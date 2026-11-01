import {setOptional, omitUndefined } from '@craft-agent/shared/utils/json';
import { persistenceRootFor } from '../policy.ts';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { getObjectiveEvidenceCompletionGap } from '@craft-agent/shared/agent';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { getLastApiError } from '@craft-agent/shared/interceptor';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { classifyLatestTurnTerminalState, classifyObjectiveTerminalState, incompletePlanSteps } from '../../turn-completion';
import { validateObjectiveOutcome } from '../../objective-outcome';
import { validateDelegatedReviewCompletion } from '../../delegated-review-outcome';
import { requiresStructuredObjectiveOutcome } from '../../objective-completion-policy';
import { messagesForPendingRecovery } from '../../turn-recovery';
import type { AutomaticTurnRecoveryCause } from '../../turn-recovery';
import { findObjectiveText, hasObjectiveExecutionEvidence, objectiveRequiresExecutionEvidence, projectLegacyObjectiveCompletionRequirements } from '../../objective-contract';
import { sessionLog } from '../runtime-platform.ts';
import { RECOVERY_BUDGET_UNAVAILABLE_MESSAGE } from '../runtime-policy.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';
import { hasExplicitStructuredObjectiveTracking as sessionOpHasExplicitStructuredObjectiveTracking } from './capture-user-correction.ts';
import { preserveInterruptedObjectiveContinuation as sessionOpPreserveInterruptedObjectiveContinuation, applyValidatedNativeOutcome as sessionOpApplyValidatedNativeOutcome } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { processEvent as sessionOpProcessEvent } from './process-event.ts';
import { deferTerminalOutcomeForActiveDelegations as sessionOpDeferTerminalOutcomeForActiveDelegations } from './defer-terminal-outcome-for-active-delegations.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';

export async function handleProviderTurnEvent(
    providerTurnInput: ProviderTurnInput,
    event: AgentEvent
): Promise<boolean> {
    const {
        ownsActiveTurn,
        abandonStoppedTurn,
        recoveryHandoffPaused,
        sessionOperationContext,
        managed,
        activeProviderState,
        userMessage,
        sendSpan,
    } = providerTurnInput;
// Handle complete event - SDK always sends this (even after interrupt)
    // This is the central place where processing ends
    if (event.type === 'complete') {
        // Skip normal completion handling if auth retry is in progress
        // The retry will handle its own completion
        if (managed.authRetryInProgress) {
            sessionLog.info('Chat completed but auth retry is in progress, skipping normal completion handling');
            sendSpan.mark('chat.complete.auth_retry_pending');
            sendSpan.end();
            return true;
        }
        // Auth/plan handoff paths already stopped processing and emitted a complete
        // event to the renderer. Ignore the backend's trailing complete to avoid
        // double cleanup and duplicate UI completion events.
        if (!managed.isProcessing) {
            sessionLog.info('Chat completed after explicit handoff/stop; skipping normal completion handling');
            sendSpan.mark('chat.complete.already_stopped');
            sendSpan.end();
            return true;
        }
        // Preserve drained text after a soft Stop, but never turn a late
        // provider completion into a verified result for cancelled ownership.
        if (!ownsActiveTurn()) {
            sendSpan.end();
            await abandonStoppedTurn();
            return true;
        }
        if (sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasQueuedUserInput(sessionOperationContext, managed)) {
            await activeProviderState.clearAcceptedProviderWriteAhead();
            sendSpan.end();
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
            return true;
        }
        // /compact is a local runtime-maintenance command, not a model turn.
        // Its info+complete stream is terminal by itself and must not create
        // a provider WAL, replace the active objective, or schedule recovery
        // merely because it intentionally has no assistant response.
        if (providerTurnInput.localCompactCommand) {
            sendSpan.mark('chat.complete.local_compaction');
            sendSpan.end();
            // A slash compaction is local runtime maintenance, not a user
            // objective turn. Remove its transient command row durably before
            // publishing idle so it cannot become the next Retry anchor, and
            // deliberately bypass onProcessingStopped: that method owns
            // objective/session lifecycle completion and Conductor signals.
            const commandIndex = managed.messages.indexOf(userMessage);
            if (commandIndex >= 0 && userMessage.role === 'user'
                && !userMessage.providerDispatch && !userMessage.agentDelivery) {
                managed.messages.splice(commandIndex, 1);
            }
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
            managed.lastMessageRole = providerTurnInput.lastMessageRoleBeforeDispatch;
            managed.lastSentMessage = undefined;
            managed.lastSentAttachments = undefined;
            managed.lastSentStoredAttachments = undefined;
            managed.lastSentOptions = undefined;
            managed.turnStartFinalMessageId = undefined;
            if (!sessionOperationContext.owner["persistSession"](managed)) {
                throw new Error('The local compaction result could not be queued for durable storage');
            }
            await sessionOperationContext.owner.flushSession(managed.id);
            if (!ownsActiveTurn())
                return true;
            sessionOperationContext.owner["finishGenerationTelemetry"](managed, providerTurnInput.myGeneration, 'generation.completed');
            sessionOperationContext.owner["setProcessing"](managed, false);
            managed.stopRequested = false;
            managed.pendingUserSteers?.clear();
            sessionOperationContext.owner["sendEvent"]({
                type: 'complete',
                sessionId: providerTurnInput.sessionId,
                reason: 'complete', tokenUsage: managed.tokenUsage,
                backgroundTasksAlive: sessionOperationContext.state.keepBackgroundTasksAlive,
            }, managed.workspace.id);
            sessionOperationContext.owner["persistSession"](managed);
            if (managed.messageQueue.length > 0)
                sessionOperationContext.owner["processNextQueuedMessage"](providerTurnInput.sessionId);
            sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]?.();
            return true;
        }
        sessionLog.info('Chat completed via complete event');
        // A complete event is valid only when this user turn produced either
        // a final assistant response or a visible error. Commentary and tool
        // results alone are progress, not completion.
        const terminalMessages = managed.pendingTurnRecovery
            ? messagesForPendingRecovery(managed.messages, managed.pendingTurnRecovery) : managed.messages;
        const remainingPlanSteps = incompletePlanSteps(managed.messages, managed.activeObjective?.userMessageId ?? managed.pendingTurnRecovery?.userMessageId ?? userMessage.id);
        const emittedTerminalState = classifyLatestTurnTerminalState(terminalMessages, managed.pendingTurnRecovery?.userMessageId ?? userMessage.id, remainingPlanSteps);
        const finalMessage = [...terminalMessages].reverse().find(candidate => (candidate.role === 'assistant' && !candidate.isIntermediate));
        // A negative audit finding can describe remaining corrections without
        // promising that this read-only reviewer will perform them.
        const reviewValidation = managed.activeObjective && finalMessage
            && (emittedTerminalState === 'final-assistant' || emittedTerminalState === 'premature-final-assistant')
            ? validateDelegatedReviewCompletion({ ...(managed.parentSessionId !== undefined ? { parentSessionId: managed.parentSessionId } : {}), sessionId: managed.id, ...(managed.enabledSourceSlugs !== undefined ? { sourceSlugs: managed.enabledSourceSlugs } : {}),
                objective: managed.activeObjective, messages: managed.messages, finalMessage }) : undefined;
        const explicitStructuredTracking = sessionOpHasExplicitStructuredObjectiveTracking(sessionOperationContext, managed);
        const latestTurnTerminalState = reviewValidation
            ? 'final-assistant'
            : emittedTerminalState;
        if (managed.pendingTurnRecovery?.continuationRequired) {
            sessionLog.warn(`Session ${providerTurnInput.sessionId} reached a host-authored tool checkpoint`);
            const recoveryQueued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'tool_checkpoint');
            if (recoveryHandoffPaused()) {
                sendSpan.end();
                await abandonStoppedTurn();
                return true;
            }
            if (recoveryQueued) {
                await activeProviderState.clearAcceptedProviderWriteAhead();
                sendSpan.mark('chat.complete.tool_checkpoint_auto_recovery');
                sendSpan.end();
                await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
                return true;
            }
            if (managed.activeObjective)
                managed.activeObjective.terminalState = 'exhausted';
            if (sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext, managed)) {
                sessionOperationContext.owner["persistSession"](managed);
                await sessionOperationContext.owner.flushSession(managed.id);
                if (recoveryHandoffPaused()) {
                    sendSpan.end();
                    await abandonStoppedTurn();
                    return true;
                }
                sessionOperationContext.owner["sendEvent"]({
                    type: 'info',
                    sessionId: providerTurnInput.sessionId,
                    message: 'Automatic continuation paused at a structural tool checkpoint after reaching its configured progress limit. Completed work and remaining work were preserved; retry to resume.',
                    level: 'warning', timestamp: sessionOpMonotonic(sessionOperationContext),
                }, managed.workspace.id);
                await activeProviderState.clearAcceptedProviderWriteAhead();
                sendSpan.mark('chat.complete.objective_continuation_checkpoint_exhausted');
                sendSpan.end();
                await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
                return true;
            }
            await sessionOpProcessEvent(sessionOperationContext, managed, {
                type: 'error',
                message: managed.pendingTurnRecovery?.budgetHistoryUnavailable
                    ? RECOVERY_BUDGET_UNAVAILABLE_MESSAGE
                    : 'The objective reached its recovery ceiling after a structural tool checkpoint. Completed work was preserved.',
            }, providerTurnInput.myGeneration);
        }
        else if (latestTurnTerminalState === 'premature-final-assistant') {
            sessionLog.warn(`Session ${providerTurnInput.sessionId} ended with a final response that announced unfinished work`);
            const recoveryQueued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'premature_final');
            if (recoveryHandoffPaused()) {
                sendSpan.end();
                await abandonStoppedTurn();
                return true;
            }
            if (recoveryQueued) {
                await activeProviderState.clearAcceptedProviderWriteAhead();
                sendSpan.mark('chat.complete.premature_final_auto_recovery');
                sendSpan.end();
                await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
                return true;
            }
            await sessionOpProcessEvent(sessionOperationContext, managed, {
                type: 'error',
                message: managed.pendingTurnRecovery?.budgetHistoryUnavailable
                    ? RECOVERY_BUDGET_UNAVAILABLE_MESSAGE
                    : 'The agent repeatedly stopped after announcing more work. Completed work was preserved; retry to resume safely.',
            }, providerTurnInput.myGeneration);
        }
        else if (latestTurnTerminalState === 'incomplete') {
            sessionLog.warn(`Session ${providerTurnInput.sessionId} completed without assistant response - possible context overflow or API issue`);
            // Check if there's a captured API error that explains the silent failure.
            // Pass explicit session path to avoid reading from the wrong session
            // (_sessionDir singleton can be clobbered by concurrent sessions).
            const sessionErrorPath = getSessionStoragePath(persistenceRootFor(managed), managed.id);
            const apiError = getLastApiError(sessionErrorPath);
            let surfacedSpecificError = false;
            if (apiError && apiError.status === 400) {
                const isImageError = apiError.message?.includes('image exceeds');
                const errorMessage: Message = {
                    id: generateMessageId(),
                    role: 'error',
                    content: isImageError
                        ? `Image Too Large: ${apiError.message}`
                        : `Request Error: ${apiError.message}`,
                    timestamp: sessionOpMonotonic(sessionOperationContext),
                    errorCode: isImageError ? 'image_too_large' : 'invalid_request',
                    errorTitle: isImageError ? 'Image Too Large' : 'Invalid Request',
                    errorDetails: isImageError
                        ? ['An image in the conversation exceeds the 5 MB API limit.',
                            'This session cannot recover — the image is embedded in the history.',
                            'Please start a new session to continue.']
                        : [apiError.message],
                    errorCanRetry: false,
                };
                managed.messages.push(errorMessage);
                managed.terminalErrorGeneration = providerTurnInput.myGeneration;
                surfacedSpecificError = true;
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error',
                    sessionId: providerTurnInput.sessionId,
                    error: {
                        code: isImageError ? 'image_too_large' as const : 'invalid_request' as const,
                        title: errorMessage.errorTitle!,
                        message: apiError.message,
                        actions: [],
                        canRetry: false,
                        ...(errorMessage.errorDetails !== undefined ? { details: errorMessage.errorDetails } : {}),
                    },
                }, managed.workspace.id);
            }
            if (!surfacedSpecificError) {
                const recoveryQueued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'stream_ended');
                if (recoveryHandoffPaused()) {
                    sendSpan.end();
                    await abandonStoppedTurn();
                    return true;
                }
                if (recoveryQueued) {
                    // enqueueAutomaticTurnRecovery flushed the successor while
                    // the accepted receipt still fenced admission. This durable
                    // snapshot commits that successor (generic or queued human)
                    // together with receipt removal before FIFO admission.
                    await activeProviderState.clearAcceptedProviderWriteAhead();
                    sendSpan.mark('chat.complete.auto_recovery');
                    sendSpan.end();
                    await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'error', providerTurnInput.myGeneration);
                    return true;
                }
                await sessionOpProcessEvent(sessionOperationContext, managed, {
                    type: 'error',
                    message: managed.pendingTurnRecovery?.budgetHistoryUnavailable
                        ? RECOVERY_BUDGET_UNAVAILABLE_MESSAGE
                        : 'The agent stopped before producing a final response after bounded automatic recovery. Completed tool results were preserved; retry to resume safely.',
                }, providerTurnInput.myGeneration);
            }
        }
        else if (latestTurnTerminalState === 'final-assistant' && managed.activeObjective) {
            const completionObjective = projectLegacyObjectiveCompletionRequirements(managed.activeObjective, findObjectiveText(managed.messages, managed.activeObjective));
            const hasExecutionEvidence = hasObjectiveExecutionEvidence(managed.messages, managed.activeObjective.userMessageId);
            const evidenceGap = !reviewValidation && explicitStructuredTracking && managed.activeObjective.evidenceRequirement
                ? getObjectiveEvidenceCompletionGap(managed.id)
                : undefined;
            const executionEvidenceMissing = !reviewValidation && explicitStructuredTracking && objectiveRequiresExecutionEvidence(managed.activeObjective, findObjectiveText(managed.messages, managed.activeObjective))
                && !hasExecutionEvidence;
            const structuredOutcomeRequired = explicitStructuredTracking && requiresStructuredObjectiveOutcome(completionObjective);
            const outcomeValidation = reviewValidation ?? validateObjectiveOutcome(finalMessage?.objectiveOutcome, {
                objective: completionObjective,
                messages: managed.messages,
                sessionId: managed.id,
                ...(finalMessage?.objectiveOutcomeError !== undefined ? { extractionError: finalMessage?.objectiveOutcomeError } : {}),
                ...(evidenceGap !== undefined ? { evidenceGap: evidenceGap } : {}),
                executionEvidenceMissing,
                ...(managed.autonomyEvents !== undefined ? { autonomyEvents: managed.autonomyEvents } : {}),
                pendingHumanConfirmation: sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed),
                preservedContinueOnLegacyBudget: managed.pendingTurnRecovery?.budgetHistoryUnavailable === true,
            });
            if (finalMessage && outcomeValidation.declaration && !finalMessage.objectiveOutcome) {
                finalMessage.objectiveOutcome = outcomeValidation.declaration;
            }
            const objectiveTerminalState = reviewValidation?.state ?? classifyObjectiveTerminalState(finalMessage?.content ?? '', omitUndefined({
                evidenceGap,
                executionEvidenceMissing,
                structuredOutcomeRequired,
                remainingPlanSteps,
                ...(explicitStructuredTracking && (finalMessage?.objectiveOutcome || finalMessage?.objectiveOutcomeError || outcomeValidation.declaration) ? {
                    declaredState: outcomeValidation.state,
                    structuredOutcomeValid: outcomeValidation.valid,
                } : {}),
            }));
            // The provider cannot terminalize a parent while a child bound to
            // this exact objective is still running. Keep the objective active
            // and park a bounded continuation behind the child's terminal
            // result. This guard runs before any terminal state is persisted,
            // so it never reopens a legitimately completed objective later.
            if (objectiveTerminalState !== 'continue'
                && await sessionOpDeferTerminalOutcomeForActiveDelegations(sessionOperationContext, managed)) {
                await activeProviderState.clearAcceptedProviderWriteAhead();
                sendSpan.mark('chat.complete.delegated_descendant_pending');
                sendSpan.end();
                await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
                return true;
            }
            if (objectiveTerminalState === 'continue') {
                const validContinuation = outcomeValidation.valid
                    && outcomeValidation.state === 'continue'
                    && !finalMessage?.objectiveOutcomeError;
                const recoveryCause: AutomaticTurnRecoveryCause = !explicitStructuredTracking ? 'premature_final' : validContinuation
                    ? 'objective_continue'
                    : evidenceGap ? 'evidence_gate' : 'objective_incomplete';
                const outcomeLogDetails = {
                    sessionId: providerTurnInput.sessionId,
                    recoveryCause,
                    evidenceGap,
                    hasExecutionEvidence,
                    outcomeGaps: outcomeValidation.gaps,
                };
                if (validContinuation)
                    sessionLog.info('preservedFromPriorOutcome' in outcomeValidation && outcomeValidation.preservedFromPriorOutcome
                        ? 'Prior objective remaining work revalidated for legacy turn'
                        : 'Objective reported valid remaining work', outcomeLogDetails);
                else
                    sessionLog.warn('Objective completion contract rejected terminal response', outcomeLogDetails);
                // A valid `continue` receipt is still a host-validated outcome.
                // Retain it for durable progress presentation without marking the
                // objective complete or assigning a completion timestamp.
                const effectiveContinuation = ('effectiveDeclaration' in outcomeValidation
                    ? outcomeValidation.effectiveDeclaration : undefined) ?? finalMessage?.objectiveOutcome;
                if (validContinuation)
                    setOptional(managed.activeObjective, "lastOutcome", effectiveContinuation);
                // Parsing can fail before the validator reaches the independent
                // evidence gates. Preserve every current reason in the retry and
                // terminal diagnostic, including those early-return cases.
                const validationGaps = !explicitStructuredTracking || validContinuation ? [] : [...new Set([
                        ...outcomeValidation.gaps,
                        ...(evidenceGap ? [evidenceGap] : []),
                        ...(executionEvidenceMissing ? ['required execution evidence is missing'] : []),
                    ])];
                const recoveryQueued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, recoveryCause, validationGaps, !explicitStructuredTracking ? remainingPlanSteps
                    : validContinuation ? effectiveContinuation?.remainingWork : undefined);
                if (recoveryHandoffPaused()) {
                    sendSpan.end();
                    await abandonStoppedTurn();
                    return true;
                }
                if (recoveryQueued) {
                    await activeProviderState.clearAcceptedProviderWriteAhead();
                    sendSpan.mark('chat.complete.objective_contract_auto_recovery');
                    sendSpan.end();
                    await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
                    return true;
                }
                managed.activeObjective.terminalState = 'exhausted';
                if (validContinuation) {
                    sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext, managed);
                    sessionOperationContext.owner["persistSession"](managed);
                    await sessionOperationContext.owner.flushSession(managed.id);
                    if (recoveryHandoffPaused()) {
                        sendSpan.end();
                        await abandonStoppedTurn();
                        return true;
                    }
                    sessionOperationContext.owner["sendEvent"]({
                        type: 'info',
                        sessionId: providerTurnInput.sessionId,
                        message: 'Automatic continuation paused after its bounded progress budget. Completed work and the reported remaining work were preserved; retry to resume.',
                        level: 'warning', timestamp: sessionOpMonotonic(sessionOperationContext),
                    }, managed.workspace.id);
                    await activeProviderState.clearAcceptedProviderWriteAhead();
                    sendSpan.mark('chat.complete.objective_continuation_exhausted');
                    sendSpan.end();
                    await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
                    return true;
                }
                // A visible final is a progress receipt, never completion proof.
                // Preserve it in the transcript while keeping the objective
                // exhausted and retryable when any validation gap remains.
                await sessionOpProcessEvent(sessionOperationContext, managed, {
                    type: 'typed_error',
                    error: {
                        code: 'objective_validation_failed',
                        title: 'Completion could not be verified',
                        message: managed.pendingTurnRecovery?.budgetHistoryUnavailable
                            ? RECOVERY_BUDGET_UNAVAILABLE_MESSAGE
                            : 'Automatic continuation stopped because the completion contract still could not be validated within the retry limit. Completed work and tool receipts were preserved. Inspect the reported validation gaps before retrying; a validation failure does not authorize repeating an external action or repairing the host application.',
                        details: validationGaps.slice(0, 16).map(gap => gap.slice(0, 500)),
                        actions: [], canRetry: true,
                    },
                }, providerTurnInput.myGeneration);
            }
            else {
                managed.activeObjective.terminalState = objectiveTerminalState;
                if (!reviewValidation && outcomeValidation.valid && outcomeValidation.declaration && finalMessage)
                    sessionOpApplyValidatedNativeOutcome(sessionOperationContext, managed, finalMessage, outcomeValidation.declaration);
                setOptional(managed.activeObjective, "lastOutcome", reviewValidation?.declaration ?? (outcomeValidation.valid ? finalMessage?.objectiveOutcome : undefined));
                managed.activeObjective.completedAt = Date.now();
                sessionOperationContext.owner["persistSession"](managed);
            }
        }
        // For complete-only terminal/error/handoff branches, the current
        // in-memory state is now the durable non-replay successor. Commit it
        // together with accepted-receipt removal before releasing the FIFO.
        await activeProviderState.clearAcceptedProviderWriteAhead();
        sendSpan.mark('chat.complete');
        sendSpan.end();
        const stopReason = managed.terminalErrorGeneration === providerTurnInput.myGeneration ? 'error' : 'complete';
        await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, stopReason, providerTurnInput.myGeneration);
        return true;
    }
    return false;
}
