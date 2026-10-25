import { resumeColdCleanAnswerRetry } from './cold-clean-answer-retry.ts';
import { reclaimColdStartedDispatch } from './cold-started-dispatch-reclaim.ts';
import { resumeColdRecoveryQueue } from './cold-recovery-resume.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { getQueuedPendingUserInputResponse, validAllocatedRecoveryDispatch, isClosedColdResumeStatus, rehydrateObjectiveEvidence } from '../policy.ts';
import { getObjectiveEvidenceCompletionGap } from '@craft-agent/shared/agent';
import { classifyObjectiveTerminalState, incompletePlanSteps } from '../../turn-completion';
import { validateObjectiveOutcome } from '../../objective-outcome';
import { validateDelegatedReviewCompletion } from '../../delegated-review-outcome';
import { requiresStructuredObjectiveOutcome } from '../../objective-completion-policy';
import { pendingRecoveryRequiresContinuation, messagesForPendingRecovery, turnStillNeedsRecovery } from '../../turn-recovery';
import type { AutomaticTurnRecoveryCause } from '../../turn-recovery';
import { findObjectiveText, hasObjectiveExecutionEvidence, objectiveRequiresExecutionEvidence, projectLegacyObjectiveCompletionRequirements } from '../../objective-contract';
import { sessionLog } from '../runtime-platform.ts';
import { repairLegacyCleanRetryCauseAfterRestart as sessionOpRepairLegacyCleanRetryCauseAfterRestart, healPendingContextLimitQuestionAfterRestart as sessionOpHealPendingContextLimitQuestionAfterRestart } from './heal-pending-context-limit-question-after-restart.ts';
import { isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked, pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { isCleanSetupPersistenceFenced as sessionOpIsCleanSetupPersistenceFenced } from './start-recovery-dispatch.ts';
import { continueObservedContextLimitQuestionAfterRestart as sessionOpContinueObservedContextLimitQuestionAfterRestart, quarantineExpiredColdAutomaticRecovery as sessionOpQuarantineExpiredColdAutomaticRecovery, resumeAllocatedRecoveryDispatch as sessionOpResumeAllocatedRecoveryDispatch } from './dispatch-allocated-clean-retry.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { getPendingUserInputResponse as sessionOpGetPendingUserInputResponse } from './user-input-recovery.ts';
import { stopImmutableRestartRecovery as sessionOpStopImmutableRestartRecovery } from './exact-user-input-response.ts';
import { providerDispatchAcceptanceUnknown as sessionOpProviderDispatchAcceptanceUnknown } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { revokeStaleColdRecovery as sessionOpRevokeStaleColdRecovery, reclaimableUnobservedStartedCleanUserInputRetry as sessionOpReclaimableUnobservedStartedCleanUserInputRetry } from './retry-turn-internal.ts';
import { movePendingRecoveryToExplicitRetrySnapshot as sessionOpMovePendingRecoveryToExplicitRetrySnapshot, hasValidationExhaustionMarker as sessionOpHasValidationExhaustionMarker, hasExhaustedValidation as sessionOpHasExhaustedValidation, applyValidatedNativeOutcome as sessionOpApplyValidatedNativeOutcome } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { hasExplicitStructuredObjectiveTracking as sessionOpHasExplicitStructuredObjectiveTracking } from './capture-user-correction.ts';
import { deferTerminalOutcomeForActiveDelegations as sessionOpDeferTerminalOutcomeForActiveDelegations } from './defer-terminal-outcome-for-active-delegations.ts';
import { reclaimableUnobservedStartedRecoveryDispatch as sessionOpReclaimableUnobservedStartedRecoveryDispatch } from './create-autonomous-context-limit-handoff.ts';

async function sessionOpResumePendingTurnAfterRestartOnce(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed?.pendingTurnRecovery || managed.isProcessing
        || sessionOperationContext.state.coldProviderReconciliationsInFlight.has(sessionId))
        return;
    await sessionOpRepairLegacyCleanRetryCauseAfterRestart(sessionOperationContext, managed);
    const restartObjectiveAtEntry = managed.activeObjective;
    const restartCancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
    const pendingAtEntry = managed.pendingTurnRecovery;
    const allocatedCleanHint = validAllocatedRecoveryDispatch(managed.pendingTurnRecovery);
    const blockedSetupHint = sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, allocatedCleanHint);
    const persistenceFencedHint = sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, allocatedCleanHint);
    if (sessionOperationContext.owner["hasPendingUserInput"](managed)) {
        await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
        if (sessionOperationContext.state.sessions.get(sessionId) !== managed || managed.isProcessing)
            return;
        if (await sessionOpContinueObservedContextLimitQuestionAfterRestart(sessionOperationContext, managed))
            return;
        if (!await sessionOpHealPendingContextLimitQuestionAfterRestart(sessionOperationContext, managed))
            return;
    }
    const terminalAnsweredUserInputHint = sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
        && managed.userInputRequests?.some(request => (request.status === 'answered'
            && request.responseMessageId === pendingAtEntry.userMessageId
            && request.sessionId === managed.id
            && request.originWorkspaceId === managed.workspace.id
            && request.objectiveUserMessageId === managed.activeObjective?.userMessageId)) === true;
    let humanRecovery = managed.pendingTurnRecovery.lastCause === 'user_retry'
        || !!sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true) || blockedSetupHint
        || terminalAnsweredUserInputHint;
    const restartRecoveryStillAuthorized = (): boolean => (sessionOperationContext.state.sessions.get(sessionId) === managed
        && !managed.stopRequested
        // A setup-blocked clean dispatch may have been written by the brief
        // implementation that also closed the session lifecycle. Let it reach
        // hydration/provenance migration only; the exact blocked branch below
        // never starts a provider automatically.
        && (blockedSetupHint || persistenceFencedHint || !isClosedColdResumeStatus(managed))
        && (humanRecovery || !sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)));
    if (!restartRecoveryStillAuthorized()) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        return;
    }
    // Indexes are hydration hints, never human authority: spawned-session and
    // older agent messages may also appear in pendingQueuedMessageIds.
    const hasInboxHint = !!managed.pendingQueuedMessageIds?.length || !!managed.pendingAgentDeliveryIds?.length;
    const hasDelegatedDescendants = [...sessionOperationContext.state.sessions.values()].some(candidate => candidate.parentSessionId === managed.id || candidate.delegation?.rootSessionId === managed.id);
    const needsLocalReconciliation = managed.lastMessageRole === 'assistant' || !!managed.lastFinalMessageId
        || !!managed.pendingTurnRecovery.waitingForPermission || !!managed.pendingAuthRequestId
        || !!managed.parentSessionId && !sessionOperationContext.state.sessions.has(managed.parentSessionId)
        || hasDelegatedDescendants;
    if (!humanRecovery && !allocatedCleanHint?.cleanContinuationId
        && !hasInboxHint && !needsLocalReconciliation) {
        if (await sessionOpStopImmutableRestartRecovery(sessionOperationContext, managed))
            return;
        if (!restartRecoveryStillAuthorized())
            return;
        if (!sessionOperationContext.owner["claimAutomaticAdmission"](managed))
            return;
    }
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    // Hydration can discover a durable provider fence and start the atomic
    // cold non-replay transaction. Do not inspect or advance its optimistic
    // in-memory successor until that exact snapshot has crossed fsync; the
    // transaction callback will schedule the continuation afterwards.
    if (sessionOperationContext.state.coldProviderReconciliationsInFlight.has(sessionId)) {
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        return;
    }
    if (sessionOpProviderDispatchAcceptanceUnknown(sessionOperationContext, managed)) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        return;
    }
    const pending = managed.pendingTurnRecovery;
    // Hydration yields. Stop or a new objective can supersede this recovery
    // while the transcript is loading; reacquire the exact objective and
    // cancellation epoch before reading or migrating any pending authority.
    if (!pending
        || managed.activeObjective !== restartObjectiveAtEntry
        || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== restartCancellationEpoch
        || !restartRecoveryStillAuthorized()) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        return;
    }
    const pendingResponseCandidate = pending ? sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true) : undefined;
    const terminalObjective = sessionOpHasTerminalObjectiveState(sessionOperationContext, managed);
    const queuedPendingResponse = terminalObjective
        ? getQueuedPendingUserInputResponse(managed)
        : pendingResponseCandidate;
    const terminalAnsweredUserInput = terminalObjective
        && managed.userInputRequests?.some(request => (request.status === 'answered'
            && request.sessionId === managed.id
            && request.originWorkspaceId === managed.workspace.id
            && request.objectiveUserMessageId === managed.activeObjective?.userMessageId)) === true;
    const terminalAnsweredPendingUserInput = terminalObjective
        && managed.userInputRequests?.some(request => (request.status === 'answered'
            && request.responseMessageId === pending.userMessageId
            && request.sessionId === managed.id
            && request.originWorkspaceId === managed.workspace.id
            && request.objectiveUserMessageId === managed.activeObjective?.userMessageId)) === true;
    // A consumed answer refines the objective, but it is not a replay
    // capability. Older snapshots could retain it as `lastCause=user_retry`
    // after Stop and thereby spend the prospective Retry reserve on startup.
    // Migrate that exact state to the explicit-Retry-only slot before any
    // automatic admission. Ambiguous FIFO/header state fails closed instead.
    if (terminalObjective && pendingResponseCandidate && !queuedPendingResponse) {
        const responseMessageId = pendingResponseCandidate.responseMessageId;
        const responseRows = responseMessageId
            ? managed.messages.filter(message => message.id === responseMessageId)
            : [];
        const queuedRows = responseMessageId
            ? managed.messageQueue.filter(item => item.messageId === responseMessageId)
            : [];
        const exactConsumedResponse = responseRows.length === 1
            && responseRows[0]!.isQueued !== true
            && queuedRows.length === 0;
        if (!exactConsumedResponse) {
            await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'terminal_user_input_queue_mismatch');
            return;
        }
        const objective = managed.activeObjective;
        const previousInterrupted = objective?.interruptedTurnRecovery;
        if (!objective || !sessionOpMovePendingRecoveryToExplicitRetrySnapshot(sessionOperationContext, managed, pending)) {
            await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'terminal_user_input_provenance_mismatch');
            return;
        }
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        try {
            if (!sessionOperationContext.owner["persistSession"](managed)) {
                throw new Error('The consumed answer Retry snapshot could not be queued for durable storage');
            }
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        catch (error) {
            // Keep automatic admission closed when migration durability is
            // uncertain. Restore the exact in-memory source only so a later
            // startup/Retry can reconcile it; never continue in this invocation.
            if (sessionOperationContext.state.sessions.get(sessionId) === managed
                && managed.activeObjective === objective
                && managed.pendingTurnRecovery === undefined) {
                objective.interruptedTurnRecovery = previousInterrupted;
                managed.pendingTurnRecovery = pending;
                sessionOperationContext.owner["persistSession"](managed);
                try {
                    await sessionOperationContext.owner.flushSession(managed.id);
                }
                catch { /* the terminal objective remains fail-closed in memory */ }
            }
            sessionLog.warn('Failed to preserve consumed answer for explicit Retry', {
                sessionId,
                responseMessageId,
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        sessionLog.info('Preserved consumed answer recovery for explicit Retry', {
            sessionId,
            responseMessageId,
        });
        return;
    }
    if (terminalAnsweredPendingUserInput && !queuedPendingResponse) {
        await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'terminal_user_input_ambiguous');
        return;
    }
    if (terminalAnsweredUserInput && !queuedPendingResponse
        && pending.lastCause !== 'user_retry') {
        await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'terminal_user_input_not_queued');
        return;
    }
    humanRecovery = !!pending && (pending.lastCause === 'user_retry' || !!queuedPendingResponse);
    if (sessionOperationContext.state.shuttingDown || !pending || managed.isProcessing
        || sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed))
        return;
    const allocatedCleanRecovery = validAllocatedRecoveryDispatch(pending);
    if (allocatedCleanRecovery?.cleanContinuationId
        && !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)) {
        await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'clean_objective_provenance_mismatch');
        return;
    }
    if (sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, allocatedCleanRecovery)) {
        const objective = managed.activeObjective;
        // Migrate only the exact shape written by the short-lived implementation
        // that represented setup pause as objective termination. Setup failure is
        // not mission completion and must not finish a delegated branch.
        if (objective?.terminalState === 'blocked_human'
            && Number.isFinite(objective.completedAt)
            && objective.completedAt! - allocatedCleanRecovery!.setupRetryBlockedAt! >= 0
            && objective.completedAt! - allocatedCleanRecovery!.setupRetryBlockedAt! <= 5000) {
            const migratedObjective = { ...objective, terminalState: 'active' as const, completedAt: undefined };
            managed.activeObjective = migratedObjective;
            try {
                if (!sessionOperationContext.owner["persistSession"](managed))
                    throw new Error('Failed to queue setup-state migration');
                await sessionOperationContext.owner.flushSession(managed.id);
            }
            catch (error) {
                if (sessionOperationContext.state.sessions.get(sessionId) === managed
                    && managed.pendingTurnRecovery === pending
                    && managed.activeObjective === migratedObjective) {
                    managed.activeObjective = objective;
                    sessionOperationContext.owner["persistSession"](managed);
                }
                sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
                sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error', sessionId: managed.id,
                    error: {
                        code: 'provider_error', title: 'Recovery state was not persisted',
                        message: 'The legacy setup pause could not be migrated durably. No provider work was started; Retry after storage is available.',
                        actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                    },
                }, managed.workspace.id);
                sessionLog.warn('Failed to persist legacy clean setup-pause migration', {
                    sessionId,
                    dispatchId: allocatedCleanRecovery!.id,
                    error: error instanceof Error ? error.message : String(error),
                });
                return;
            }
            if (sessionOperationContext.state.sessions.get(sessionId) !== managed
                || managed.pendingTurnRecovery !== pending
                || managed.activeObjective?.terminalState !== 'active')
                return;
        }
        else if (objective?.terminalState !== 'active') {
            await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'setup_block_no_active_objective');
            return;
        }
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        sessionOperationContext.owner["emitObjectiveChanged"](managed);
        sessionOperationContext.owner["sendEvent"]({
            type: 'typed_error', sessionId: managed.id,
            error: {
                code: 'provider_error', title: 'Provider setup paused',
                message: `Automatic recovery remains paused before provider work (${allocatedCleanRecovery!.lastSetupFailureClass ?? 'unknown'}). Resolve the provider issue, then Retry.`,
                actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
            },
        }, managed.workspace.id);
        return;
    }
    if (sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, allocatedCleanRecovery)) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        sessionOperationContext.owner["sendEvent"]({
            type: 'typed_error', sessionId: managed.id,
            error: {
                code: 'provider_error', title: 'Recovery state requires confirmation',
                message: 'The last clean recovery state could not be proven durable. No provider work will resume automatically; use Retry after storage is available.',
                actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
            },
        }, managed.workspace.id);
        return;
    }
    if (await sessionOpQuarantineExpiredColdAutomaticRecovery(sessionOperationContext, managed, pending))
        return;
    const legacyObjectiveStateMissing = !!managed.activeObjective
        && managed.activeObjective.terminalState == null;
    const terminalHumanCandidate = terminalObjective
        && ((pending.lastCause === 'user_retry' && !sessionOpHasValidationExhaustionMarker(sessionOperationContext, managed))
            || !!pendingResponseCandidate);
    const retryProvenanceMismatch = pending.lastCause === 'user_retry'
        && !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending);
    if (retryProvenanceMismatch) {
        await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'objective_provenance_mismatch');
        return;
    }
    if (legacyObjectiveStateMissing || terminalHumanCandidate) {
        const objective = managed.activeObjective;
        const exactAuthority = !!objective
            && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)
            && (!terminalObjective || pending.lastCause === 'user_retry' || !!queuedPendingResponse);
        if (!exactAuthority) {
            await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, terminalObjective && pendingResponseCandidate && !queuedPendingResponse
                ? 'terminal_user_input_not_queued'
                : 'objective_provenance_mismatch');
            return;
        }
        managed.activeObjective = {
            ...objective,
            terminalState: 'active',
            completedAt: undefined,
        };
        const reactivatedObjective = managed.activeObjective;
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        if (sessionOperationContext.state.shuttingDown || !restartRecoveryStillAuthorized()
            || managed.activeObjective !== reactivatedObjective
            || managed.pendingTurnRecovery !== pending || managed.isProcessing)
            return;
    }
    if (!restartRecoveryStillAuthorized())
        return;
    // A host-authenticated structured answer is fresh human input. It may
    // resume its exact objective even when the preceding automatic budget was
    // exhausted, while preserving (rather than resetting) the old counters.
    if (sessionOpHasExhaustedValidation(sessionOperationContext, managed)
        && !pendingResponseCandidate && !queuedPendingResponse)
        return;
    const startedCleanAnswerRetry = sessionOpReclaimableUnobservedStartedCleanUserInputRetry(sessionOperationContext, managed, pending);
    if (startedCleanAnswerRetry) {
        return resumeColdCleanAnswerRetry(managed, sessionOperationContext, restartRecoveryStillAuthorized, pending, startedCleanAnswerRetry, sessionId);
    }
    const allocatedCleanRetry = validAllocatedRecoveryDispatch(pending);
    if (allocatedCleanRetry?.cleanContinuationId) {
        // The legacy question has already been cancelled durably above. Only now
        // can immutable lineage distinguish a genuine decision wait from a stale
        // parent/root, before any provider reservation is claimed.
        if (await sessionOpStopImmutableRestartRecovery(sessionOperationContext, managed))
            return;
        if (!restartRecoveryStillAuthorized()
            || managed.pendingTurnRecovery !== pending || managed.isProcessing)
            return;
        // Existing rows must cross the FIFO gate so old-host messageId-only
        // entries, duplicates and attachment-bearing collisions are quarantined
        // first. With no collision, rebuild the transient allocation directly.
        const hasCleanDispatchQueueCandidate = managed.messageQueue.some(item => (item.messageId === allocatedCleanRetry.id
            || item.options?.automaticRecovery?.dispatchId === allocatedCleanRetry.id));
        if (hasCleanDispatchQueueCandidate)
            sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
        else
            sessionOpResumeAllocatedRecoveryDispatch(sessionOperationContext, managed, pending);
        return;
    }
    // Hydration already schedules the durable answer. Do not prepend an
    // automatic nudge that would run before the user's actual clarification.
    if (managed.messageQueue.length > 0 || sessionOperationContext.state.queuedMessageDispatches.has(managed.id)) {
        await sessionOpStopImmutableRestartRecovery(sessionOperationContext, managed);
        return;
    }
    // A crash can happen between persisting provider text and validating its
    // outcome. Re-run the host gate before treating that text as terminal.
    let invalidFinal = false;
    let deliveredReview = false;
    let reconciledTerminalFinal = false;
    let validationGaps: string[] | undefined;
    let restartRecoveryCause: AutomaticTurnRecoveryCause = 'app_restart';
    let continuationWork: string[] | undefined;
    const recoveryMessages = messagesForPendingRecovery(managed.messages, pending);
    const objective = managed.activeObjective;
    if (objective?.terminalState === 'active') {
        const userIndex = recoveryMessages.findIndex(message => message.id === pending.userMessageId);
        const lastAssistantOffset = userIndex < 0 ? -1 : recoveryMessages.slice(userIndex + 1).findLastIndex(message => (message.role === 'assistant' && !message.isIntermediate));
        const finalMessageIndex = lastAssistantOffset < 0 ? -1 : userIndex + 1 + lastAssistantOffset;
        const hasSubsequentTurnActivity = finalMessageIndex >= 0 && recoveryMessages.slice(finalMessageIndex + 1).some(message => (message.role === 'user' || message.role === 'tool'));
        const finalMessage = finalMessageIndex >= 0 && !hasSubsequentTurnActivity
            ? recoveryMessages[finalMessageIndex]
            : undefined;
        if (finalMessage) {
            rehydrateObjectiveEvidence(managed);
            const completionObjective = projectLegacyObjectiveCompletionRequirements(objective, findObjectiveText(managed.messages, objective));
            const reviewValidation = validateDelegatedReviewCompletion({ parentSessionId: managed.parentSessionId, sessionId: managed.id, sourceSlugs: managed.enabledSourceSlugs,
                objective, messages: managed.messages, finalMessage });
            const explicitStructuredTracking = sessionOpHasExplicitStructuredObjectiveTracking(sessionOperationContext, managed);
            const remainingPlanSteps = incompletePlanSteps(managed.messages, objective.userMessageId);
            const evidenceGap = !reviewValidation && explicitStructuredTracking && objective.evidenceRequirement ? getObjectiveEvidenceCompletionGap(managed.id) : undefined;
            const executionEvidenceMissing = !reviewValidation && explicitStructuredTracking && objectiveRequiresExecutionEvidence(objective, findObjectiveText(managed.messages, objective))
                && !hasObjectiveExecutionEvidence(managed.messages, objective.userMessageId);
            const validation = reviewValidation ?? validateObjectiveOutcome(finalMessage.objectiveOutcome, {
                objective: completionObjective, messages: managed.messages, sessionId: managed.id, extractionError: finalMessage.objectiveOutcomeError,
                evidenceGap, executionEvidenceMissing, autonomyEvents: managed.autonomyEvents,
                pendingHumanConfirmation: sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed),
                preservedContinueOnLegacyBudget: pending.budgetHistoryUnavailable === true,
            });
            if (validation.declaration && !finalMessage.objectiveOutcome) {
                finalMessage.objectiveOutcome = validation.declaration;
            }
            const state = reviewValidation?.state ?? classifyObjectiveTerminalState(finalMessage.content, {
                remainingPlanSteps,
                evidenceGap, executionEvidenceMissing,
                structuredOutcomeRequired: explicitStructuredTracking && requiresStructuredObjectiveOutcome(completionObjective),
                ...(explicitStructuredTracking && (finalMessage.objectiveOutcome || finalMessage.objectiveOutcomeError || validation.declaration) ? {
                    declaredState: validation.state, structuredOutcomeValid: validation.valid,
                } : {}),
            });
            invalidFinal = state === 'continue';
            if (invalidFinal) {
                const validContinuation = validation.valid && validation.state === 'continue'
                    && !finalMessage.objectiveOutcomeError;
                restartRecoveryCause = !explicitStructuredTracking ? 'premature_final' : validContinuation
                    ? 'objective_continue'
                    : evidenceGap ? 'evidence_gate' : 'objective_incomplete';
                validationGaps = !explicitStructuredTracking || validContinuation ? [] : [...new Set([
                        ...validation.gaps,
                        ...(evidenceGap ? [evidenceGap] : []),
                        ...(executionEvidenceMissing ? ['required execution evidence is missing'] : []),
                    ])];
                const effectiveContinuation = ('effectiveDeclaration' in validation
                    ? validation.effectiveDeclaration : undefined) ?? finalMessage.objectiveOutcome;
                continuationWork = !explicitStructuredTracking ? remainingPlanSteps
                    : validContinuation ? effectiveContinuation?.remainingWork : undefined;
                if (validContinuation)
                    objective.lastOutcome = effectiveContinuation;
            }
            if (state !== 'continue') {
                // The process may have died after persisting provider text but before
                // the live completion guard ran. Apply the same exact-lineage
                // invariant during reconciliation. This path only observes an
                // objective that is still active; it never reopens a terminal one.
                if (await sessionOpDeferTerminalOutcomeForActiveDelegations(sessionOperationContext, managed))
                    return;
                if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.sessions.get(sessionId) !== managed
                    || managed.activeObjective !== objective || isClosedColdResumeStatus(managed))
                    return;
                deliveredReview = reviewValidation?.valid === true && !pending.continuationRequired;
                objective.terminalState = state;
                if (!reviewValidation && validation.valid && validation.declaration)
                    sessionOpApplyValidatedNativeOutcome(sessionOperationContext, managed, finalMessage, validation.declaration);
                objective.lastOutcome = reviewValidation?.declaration ?? (validation.valid ? finalMessage.objectiveOutcome : undefined);
                objective.completedAt = Date.now();
                reconciledTerminalFinal = true;
            }
        }
    }
    if (reconciledTerminalFinal || deliveredReview || !turnStillNeedsRecovery(recoveryMessages, pending.userMessageId, invalidFinal || pendingRecoveryRequiresContinuation(pending, managed.activeObjective?.terminalState === 'active'))) {
        sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        sessionOperationContext.owner["emitObjectiveChanged"](managed);
        if (reconciledTerminalFinal) { }
        return;
    }
    // A durable structured answer is provenance, not a replay capability.
    // Once its provider boundary is uncertain or known consumed, continue via
    // the same bounded generic recovery allocator used by every other prompt.
    // This gives each cold pass a distinct dispatch identity and monotonically
    // spends the automatic budget instead of resubmitting answer+suffix forever.
    const reclaimObjective = managed.activeObjective;
    const reclaimableStarted = sessionOpReclaimableUnobservedStartedRecoveryDispatch(sessionOperationContext, managed, pending);
    if (reclaimableStarted) {
        return reclaimColdStartedDispatch(managed, sessionOperationContext, pending, reclaimObjective, restartRecoveryStillAuthorized, sessionId);
    }
    // A committed allocation can lose only its transient in-memory FIFO entry.
    // Recreate that exact entry without spending the lease or minting another
    // attempt. A started dispatch with any subsequent activity remains spent.
    if (validAllocatedRecoveryDispatch(pending)) {
        if (await sessionOpStopImmutableRestartRecovery(sessionOperationContext, managed))
            return;
        if (!restartRecoveryStillAuthorized())
            return;
        sessionOpResumeAllocatedRecoveryDispatch(sessionOperationContext, managed, pending);
        return;
    }
    if (await sessionOpStopImmutableRestartRecovery(sessionOperationContext, managed))
        return;
    if (!restartRecoveryStillAuthorized())
        return;
    if (!sessionOperationContext.owner["claimAutomaticAdmission"](managed))
        return;
    const recoveryGeneration = managed.processingGeneration;
    const recoveryObjective = managed.activeObjective;
    const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, restartRecoveryCause, validationGaps, continuationWork, 'restart');
    if (sessionOperationContext.state.shuttingDown || !restartRecoveryStillAuthorized() || managed.stopRequested || managed.processingGeneration !== recoveryGeneration
        || managed.activeObjective !== recoveryObjective || sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed))
        return;
    return resumeColdRecoveryQueue(managed, sessionOperationContext, queued, sessionId, invalidFinal, validationGaps, restartRecoveryCause);
}

export { sessionOpResumePendingTurnAfterRestartOnce as resumePendingTurnAfterRestartOnce };
