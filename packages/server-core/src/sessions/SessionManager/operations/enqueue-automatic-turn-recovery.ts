import type { SessionOperationContext } from '../operation-context.ts';
import { boundObjectiveForCleanHandoff, nextRecoveryDispatch, classifyAutomaticRecoveryWorkForSession, isImmutableAutomaticRecoveryBlock } from '../policy.ts';
import { resolveAgentCostControlPolicy } from '@craft-agent/shared/config';
import { isWorkspaceAutomaticToolFallbackEnabled, loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { demoteLatestCheckpointAssistant, latestFinalAssistantId } from '../../tool-checkpoint-visibility';
import { explicitRetryProgressFingerprint } from '../../explicit-retry-progress';
import { inspectAutonomousLineage } from '../../autonomous-session-admission';
import { turnRecoveryValidationFingerprint, buildCleanRecoveryContinuationPrompt, createCleanRecoveryContinuationHandoff, MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS, MAX_OBJECTIVE_CONTINUATION_ATTEMPTS, exhaustPendingTurnRecovery, hasObjectiveContinuationProvenance, planAutomaticTurnRecovery } from '../../turn-recovery';
import type { AutomaticTurnRecoveryCause } from '../../turn-recovery';
import { createAutonomyFallbackIntent } from '../../autonomy-browser-fallback';
import type { AutonomyFallbackIntent } from '../../autonomy-browser-fallback';
import { turnProgressFingerprint } from '../../objective-contract';
import { normalizeRecoveryValidationGapsForProgress } from '../../recovery-progress';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';
import { hasAcceptedHumanContinuationQueued as sessionOpHasAcceptedHumanContinuationQueued } from './create-autonomous-context-limit-handoff.ts';
import { terminalizeImmutableAutomaticRecoveryBlock as sessionOpTerminalizeImmutableAutomaticRecoveryBlock } from './dispatch-allocated-clean-retry.ts';
import { autonomousAdmissionBlock as sessionOpAutonomousAdmissionBlock } from './exact-user-input-response.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage, getPendingUserInputResponse as sessionOpGetPendingUserInputResponse } from './user-input-recovery.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';

async function sessionOpEnqueueAutomaticTurnRecovery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, cause: AutomaticTurnRecoveryCause, validationGaps?: string[], continuationWork?: string[], dispatchOrigin?: NonNullable<PendingTurnRecovery['recoveryDispatch']>['origin'], fallbackIntent?: AutonomyFallbackIntent, inheritedCleanProviderBoundary = false): Promise<boolean> {
    const pending = managed.pendingTurnRecovery;
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
    const automaticToolFallbackEnabled = isWorkspaceAutomaticToolFallbackEnabled(workspaceConfig);
    const requiresCleanProviderBoundary = inheritedCleanProviderBoundary || (!automaticToolFallbackEnabled
        && pending?.recoveryDispatch?.phase === 'started'
        && !!pending.recoveryDispatch.fallbackIntent);
    const effectiveFallbackIntent = automaticToolFallbackEnabled
        ? fallbackIntent
        : undefined;
    if (sessionOperationContext.state.shuttingDown || managed.stopRequested)
        return false;
    if (sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))
        return false;
    if (sessionOpHasQueuedUserInput(sessionOperationContext, managed))
        return true;
    if (sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed))
        return false;
    const carriesPriorValidationGaps = cause === 'app_restart'
        || cause === 'runtime_error'
        || cause === 'stream_ended'
        || cause === 'tool_checkpoint'
        || cause === 'premature_final';
    // An intermediate transport/runtime callback sometimes supplies `[]`.
    // That is not host evidence that the rejection disappeared: retain the
    // persisted gap for both the circuit breaker and the next routing pass.
    const effectiveGaps = validationGaps?.length
        ? validationGaps
        : carriesPriorValidationGaps && pending?.validationGaps?.length
            ? pending.validationGaps
            : validationGaps ?? pending?.validationGaps;
    const boundedGaps = effectiveGaps?.slice(0, 16).map(gap => gap.slice(0, 500));
    const currentContinuationWork = continuationWork ?? pending?.continuationWork;
    const boundedContinuationWork = currentContinuationWork?.slice(0, 16).map(item => item.slice(0, 500));
    const preservesValidatedContinuation = cause === 'objective_continue'
        || ((cause === 'app_restart' || cause === 'runtime_error' || cause === 'stream_ended'
            || cause === 'tool_checkpoint' || cause === 'premature_final' || cause === 'objective_incomplete'
            || cause === 'evidence_gate' || cause === 'user_retry')
            && !!pending && hasObjectiveContinuationProvenance(pending));
    const nextContinuationWork = preservesValidatedContinuation ? boundedContinuationWork : undefined;
    const continuationOrigin = preservesValidatedContinuation ? 'objective_continue' as const : undefined;
    if (sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext, managed)) {
        // The accepted instruction will resume the work through normal FIFO
        // admission. A synthetic continuation must not repeatedly overtake it,
        // consume another automatic attempt, or move an earlier child delivery.
        // A prior handoff may have cleared the automatic marker. The saved human
        // instruction remains independently dispatchable without creating a new
        // recovery budget or marking its preserved objective exhausted.
        if (pending && (validationGaps !== undefined || continuationWork !== undefined)) {
            managed.pendingTurnRecovery = {
                ...pending,
                validationGaps: boundedGaps,
                continuationWork: nextContinuationWork,
                continuationOrigin,
            };
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        return true;
    }
    if (!pending)
        return false;
    const lineage = inspectAutonomousLineage(managed, id => sessionOperationContext.state.sessions.get(id), false, id => { const session = sessionOperationContext.state.sessions.get(id); return !!session && sessionOpHasPendingDecision(sessionOperationContext, session); });
    if (!lineage.allowed && isImmutableAutomaticRecoveryBlock(lineage.reason)) {
        managed.pendingTurnRecovery = {
            ...pending, lastCause: cause, validationGaps: boundedGaps,
            continuationWork: nextContinuationWork,
            continuationOrigin,
            continuationRequired: true,
        };
        await sessionOpTerminalizeImmutableAutomaticRecoveryBlock(sessionOperationContext, managed, lineage);
        // This is a durable terminal handoff. Callers should stop the current
        // generation normally instead of manufacturing another retry/error.
        return true;
    }
    if (!lineage.allowed || sessionOpAutonomousAdmissionBlock(sessionOperationContext, managed, false, false)) {
        sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
        // Retention is a successful handoff, not a spent retry or contract failure.
        managed.pendingTurnRecovery = {
            ...pending, lastCause: cause, validationGaps: boundedGaps,
            continuationWork: nextContinuationWork,
            continuationOrigin,
            continuationRequired: true,
        };
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        return true;
    }
    const queuedRecovery = managed.messageQueue.find(item => item.options?.automaticRecovery?.originalUserMessageId === pending.userMessageId);
    if (queuedRecovery) {
        const dispatch = managed.pendingTurnRecovery?.recoveryDispatch;
        if (effectiveFallbackIntent) {
            if (dispatch?.phase !== 'allocated')
                return false;
            const durableIntent = createAutonomyFallbackIntent(effectiveFallbackIntent.kind, effectiveFallbackIntent.failedToolName);
            if (dispatch.cause !== 'runtime_error'
                || dispatch.fallbackIntent?.kind !== durableIntent.kind
                || dispatch.fallbackIntent.failedToolName !== durableIntent.failedToolName) {
                // Reuse the already-budgeted identity atomically. A fallback intent
                // on a non-runtime cause is invalid on restart, so the durable cause,
                // FIFO provenance and rebuilt prompt must move together.
                const updatedDispatch = { ...dispatch, cause: 'runtime_error' as const, fallbackIntent: durableIntent };
                managed.pendingTurnRecovery = {
                    ...managed.pendingTurnRecovery!,
                    lastCause: 'runtime_error',
                    recoveryDispatch: updatedDispatch,
                };
                queuedRecovery.message = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, managed.pendingTurnRecovery, updatedDispatch);
                queuedRecovery.options = {
                    ...queuedRecovery.options,
                    hidden: true,
                    internalOrigin: { kind: 'browser-fallback' },
                    automaticRecovery: {
                        ...queuedRecovery.options?.automaticRecovery!,
                        cause: 'runtime_error',
                        dispatchId: updatedDispatch.id,
                        dispatchAttempt: updatedDispatch.attempt,
                        dispatchOrigin: updatedDispatch.origin,
                        dispatchAllocatedAt: updatedDispatch.allocatedAt,
                    },
                };
                sessionOperationContext.owner["persistSession"](managed);
                await sessionOperationContext.owner.flushSession(managed.id);
            }
        }
        return true;
    }
    const recoveryPolicy = resolveAgentCostControlPolicy(workspaceConfig?.costControl).recovery;
    // A valid `continue` receipt and a structural checkpoint in that same
    // validated lineage may use the dedicated continuation budget. Transport,
    // runtime and validation failures retain the smaller general retry budget.
    const usesValidatedContinuationBudget = cause === 'objective_continue'
        || (cause === 'tool_checkpoint' && hasObjectiveContinuationProvenance(pending));
    const validatedStrategyPhase = pending.recoveryStrategy?.phase ?? 'resume';
    const remainingValidatedStrategyPhases = validatedStrategyPhase === 'resume'
        ? 3
        : validatedStrategyPhase === 'replan' ? 2 : 1;
    const remainingAbsoluteValidatedAttempts = Math.max(0, MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS - pending.attempts);
    const validatedPhaseAttemptLimit = validatedStrategyPhase === 'resume'
        // Preserve the documented/default four productive continuation passes.
        // Later phases divide the still-available absolute budget so re-plan and
        // escalation both receive at least one real dispatch before the cap.
        ? Math.min(recoveryPolicy.maxValidatedContinuationAttempts, MAX_OBJECTIVE_CONTINUATION_ATTEMPTS)
        : Math.min(recoveryPolicy.maxValidatedContinuationAttempts, Math.max(1, Math.floor(remainingAbsoluteValidatedAttempts / remainingValidatedStrategyPhases)));
    const authenticatedUserInputResponse = cause === 'app_restart'
        && dispatchOrigin === 'restart'
        ? sessionOpGetPendingUserInputResponse(sessionOperationContext, managed)
        : undefined;
    const authenticatedUserInputRestart = !!authenticatedUserInputResponse;
    const consumedProviderDispatchReconciliation = pending.continuationRequired === true
        && pending.lastCause === 'app_restart'
        && pending.recoveryDispatch === undefined;
    const maxAttempts = usesValidatedContinuationBudget
        ? validatedPhaseAttemptLimit
        : authenticatedUserInputRestart || consumedProviderDispatchReconciliation
            // An accepted structured answer is fresh human evidence, but it is not
            // permission to replay its exact envelope. Allow the host to replace a
            // possibly-consumed answer with distinct generic restart dispatches;
            // their persisted `attempts` counter remains bounded by the absolute
            // recovery ceiling across any number of crashes.
            ? MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS
            : recoveryPolicy.maxAutomaticAttempts;
    const recoveryWorkClass = classifyAutomaticRecoveryWorkForSession(managed, cause, effectiveGaps);
    // A cheap bounded pass gets one useful stronger-model retry before the
    // unchanged-gap breaker fires. Substantive recoveries retain the exact
    // configured breaker, and every path remains under the attempt/lease caps.
    const maxStagnantAttempts = recoveryWorkClass === 'receipt-repair'
        || recoveryWorkClass === 'read-only-verification'
        ? Math.max(recoveryPolicy.maxNoProgressAttempts, 2)
        : recoveryPolicy.maxNoProgressAttempts;
    // Only a fresh host validation rejection may advance the validation
    // stagnation counter. Transport/runtime callbacks retain the rejected gap
    // for the next prompt and routing pass, but they neither reset nor consume
    // that counter. Restart reconciliation likewise re-observes persisted state
    // rather than producing a new rejection.
    const freshValidationRejection = (cause === 'objective_incomplete' || cause === 'evidence_gate')
        && dispatchOrigin !== 'restart'
        && !!effectiveGaps?.length;
    const retainsPriorValidationRejection = !!effectiveGaps?.length
        && (carriesPriorValidationGaps || dispatchOrigin === 'restart');
    // Consuming a provider fence after a crash provides no trustworthy model
    // progress signal: the provider may have accepted the prompt but emitted no
    // durable row. Do not misclassify successive crash reconciliation as model
    // stagnation. The monotonically persisted absolute attempt counter remains
    // the hard bound.
    const progressFingerprint = consumedProviderDispatchReconciliation
        ? undefined
        : freshValidationRejection
            ? turnRecoveryValidationFingerprint(normalizeRecoveryValidationGapsForProgress(effectiveGaps!))
            : retainsPriorValidationRejection
                ? undefined
                : effectiveGaps?.length
                    ? turnRecoveryValidationFingerprint(normalizeRecoveryValidationGapsForProgress(effectiveGaps))
                    : turnProgressFingerprint(managed.messages, pending.userMessageId);
    const recoveryAllocatedAt = Date.now();
    const planningPending: PendingTurnRecovery = {
        ...pending,
        // A structured answer is a new authenticated human input, so an old
        // automatic stop marker may not suppress its first provider delivery.
        // Keep the monotonic attempt count: only the terminal marker is reopened,
        // which leaves at most the existing absolute-budget remainder.
        ...(authenticatedUserInputRestart ? {
            exhaustedAt: undefined,
            validationExhausted: undefined,
        } : {}),
        lastCause: cause,
        validationGaps: boundedGaps,
        continuationWork: nextContinuationWork,
        continuationOrigin,
    };
    const planInput = {
        cause,
        objective: managed.activeObjective,
        nowMs: recoveryAllocatedAt,
        maxAttempts,
        progressFingerprint,
        maxStagnantAttempts,
        explicitContext: managed.activeObjective ? {
            objectiveId: managed.activeObjective.objectiveId ?? managed.activeObjective.userMessageId,
            semanticProgressFingerprint: explicitRetryProgressFingerprint(managed.messages, managed.activeObjective.userMessageId),
        } : undefined,
    };
    const plan = planAutomaticTurnRecovery({ pending: planningPending, ...planInput });
    if (plan.action === 'replan' || plan.action === 'escalate') {
        managed.pendingTurnRecovery = plan.recovery;
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
            phase: 'fallback',
            message: `Automatic recovery advanced to ${plan.action} after ${plan.reason}.`,
        });
        // Re-enter after the durable strategy transition. The new phase has its
        // own baseline, so the next plan deterministically allocates one dispatch.
        return sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, cause, boundedGaps, nextContinuationWork, dispatchOrigin, effectiveFallbackIntent, requiresCleanProviderBoundary);
    }
    if (plan.action === 'halt') {
        managed.pendingTurnRecovery = exhaustPendingTurnRecovery({
            ...plan.recovery,
            ...(cause === 'objective_incomplete' || cause === 'evidence_gate'
                ? { validationExhausted: true }
                : {}),
        });
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        return false;
    }
    let advanced = plan.recovery;
    let cleanContinuationId: string | undefined;
    let detachProviderWithoutCleanHandoff = false;
    if (plan.action === 'clean-continuation') {
        const objective = managed.activeObjective;
        const remainingWork = plan.recovery.continuationWork ?? objective?.lastOutcome?.remainingWork;
        const boundedObjective = objective ? boundObjectiveForCleanHandoff(managed, objective) : undefined;
        const cleanDispatchPlan = planAutomaticTurnRecovery({
            pending: plan.recovery,
            ...planInput,
            nowMs: Math.max(recoveryAllocatedAt, Date.now()),
        });
        if (cleanDispatchPlan.action !== 'dispatch') {
            throw new Error('A clean recovery continuation could not allocate its first bounded dispatch');
        }
        advanced = {
            ...cleanDispatchPlan.recovery,
            cleanContextBoundaryMessageId: undefined,
        };
        const dispatchedHandoff = (boundedObjective && remainingWork
            ? createCleanRecoveryContinuationHandoff({
                objective: boundedObjective.objective,
                pending: advanced,
                objectiveText: boundedObjective.objectiveText,
                evidence: [],
                remainingWork: remainingWork.slice(0, 16),
            })
            : undefined) ?? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, advanced);
        if (dispatchedHandoff && buildCleanRecoveryContinuationPrompt(dispatchedHandoff)) {
            cleanContinuationId = dispatchedHandoff.id;
        }
        else {
            detachProviderWithoutCleanHandoff = true;
        }
    }
    if (requiresCleanProviderBoundary && !cleanContinuationId) {
        const cleanPending: PendingTurnRecovery = {
            ...advanced,
            recoveryDispatch: undefined,
            cleanContextBoundaryMessageId: undefined,
        };
        const handoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, cleanPending);
        const cleanPrompt = handoff && buildCleanRecoveryContinuationPrompt(handoff);
        if (handoff && cleanPrompt) {
            cleanContinuationId = handoff.id;
            advanced = cleanPending;
        }
        else {
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'disabled routing fallback quarantine');
            detachProviderWithoutCleanHandoff = true;
            advanced = cleanPending;
        }
    }
    const recoveryDispatch = {
        ...nextRecoveryDispatch(pending, cause, dispatchOrigin ?? (cause === 'app_restart' ? 'restart' : 'automatic'), recoveryAllocatedAt, effectiveFallbackIntent
            ? createAutonomyFallbackIntent(effectiveFallbackIntent.kind, effectiveFallbackIntent.failedToolName)
            : undefined),
        ...(cleanContinuationId ? { cleanContinuationId } : {}),
        ...(!cleanContinuationId && authenticatedUserInputResponse?.responseMessageId
            && !consumedProviderDispatchReconciliation
            ? { carriedUserInputResponseId: authenticatedUserInputResponse.responseMessageId }
            : {}),
    };
    managed.pendingTurnRecovery = {
        ...advanced,
        validationGaps: boundedGaps,
        continuationWork: nextContinuationWork,
        continuationOrigin,
        recoveryDispatch,
        ...(cleanContinuationId || detachProviderWithoutCleanHandoff
            ? { cleanContextBoundaryMessageId: recoveryDispatch.id }
            : {}),
    };
    const recoveryPrompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, managed.pendingTurnRecovery, recoveryDispatch);
    if (cleanContinuationId || detachProviderWithoutCleanHandoff) {
        // The allocation flush is the crash fence for a clean provider handoff.
        // Detach every persisted resume path in that same snapshot; the send
        // path will dispose any still-live in-memory runtime before admission.
        managed.sdkSessionId = undefined;
        managed.branchFromSdkSessionId = undefined;
        managed.branchFromSessionPath = undefined;
        managed.branchFromSdkCwd = undefined;
        managed.branchFromSdkTurnId = undefined;
        managed.branchContextStrategy = undefined;
        managed.branchSeedApplied = true;
        managed.providerContextBoundaryMessageId = recoveryDispatch.id;
        managed.contextCompactionAttempt = undefined;
        managed.transferredSessionSummary = undefined;
        managed.transferredSessionSummaryApplied = undefined;
        if (managed.tokenUsage) {
            managed.tokenUsage = {
                ...managed.tokenUsage,
                contextTokens: Math.max(1, Math.ceil(recoveryPrompt.length / 4)),
            };
        }
    }
    if (cause === 'premature_final'
        || cause === 'objective_incomplete'
        || cause === 'objective_continue'
        || cause === 'evidence_gate'
        || cause === 'tool_checkpoint') {
        const checkpoint = demoteLatestCheckpointAssistant(managed.messages, pending.userMessageId);
        if (checkpoint) {
            managed.lastFinalMessageId = latestFinalAssistantId(managed.messages);
            sessionOperationContext.owner["sendEvent"]({
                type: 'text_complete', sessionId: managed.id,
                text: checkpoint.content, isIntermediate: true,
                turnId: checkpoint.turnId, parentToolUseId: checkpoint.parentToolUseId,
                timestamp: checkpoint.timestamp, messageId: checkpoint.id,
                routingMeta: checkpoint.routingMeta,
                objectiveOutcome: checkpoint.objectiveOutcome ?? null,
                objectiveOutcomeError: checkpoint.objectiveOutcomeError ?? null,
            }, managed.workspace.id);
        }
        sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
            phase: 'fallback',
            message: `Objective completion gate requested recovery pass ${advanced.attempts} (stagnant=${advanced.stagnantAttempts ?? 0}/${maxStagnantAttempts}, leaseExpiresAt=${advanced.leaseExpiresAt}).`,
        });
    }
    managed.messageQueue.unshift({
        message: recoveryPrompt,
        options: {
            hidden: true,
            ...(recoveryDispatch.fallbackIntent ? { internalOrigin: { kind: 'browser-fallback' as const } } : {}),
            automaticRecovery: {
                originalUserMessageId: pending.userMessageId,
                cause,
                dispatchId: recoveryDispatch.id,
                dispatchAttempt: recoveryDispatch.attempt,
                dispatchOrigin: recoveryDispatch.origin,
                dispatchAllocatedAt: recoveryDispatch.allocatedAt,
                ...(cleanContinuationId ? { cleanContinuationId } : {}),
            },
        },
    });
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOperationContext.owner["sendEvent"]({
        type: 'info',
        sessionId: managed.id,
        message: cause === 'app_restart'
            ? 'The application restarted during this turn. Work is resuming automatically…'
            : cause === 'premature_final'
                ? 'The agent stopped after announcing more work. Work is continuing automatically…'
                : cause === 'tool_checkpoint'
                    ? 'The tool-call budget reached a checkpoint. The objective is continuing automatically…'
                    : cause === 'objective_continue'
                        ? 'The agent reported concrete remaining work. The objective is continuing automatically…'
                        : cause === 'evidence_gate'
                            ? 'The high-stakes evidence or review gate is incomplete. Work is continuing automatically…'
                            : cause === 'objective_incomplete'
                                ? 'Execution or verification evidence is incomplete. Work is continuing automatically…'
                                : 'The agent connection ended before the final response. Work is resuming automatically…',
        level: 'warning',
        timestamp: sessionOpMonotonic(sessionOperationContext),
    }, managed.workspace.id);
    sessionLog.warn('Queued bounded automatic turn recovery', {
        sessionId: managed.id,
        originalUserMessageId: pending.userMessageId,
        cause,
        attempt: recoveryDispatch.attempt,
        budgetAttempt: advanced.attempts,
        dispatchId: recoveryDispatch.id,
        origin: recoveryDispatch.origin,
    });
    return true;
}

export { sessionOpEnqueueAutomaticTurnRecovery as enqueueAutomaticTurnRecovery };
