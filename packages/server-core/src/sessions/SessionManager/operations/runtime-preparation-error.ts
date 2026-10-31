import { sessionLog, sessionRuntimeHooks } from '../runtime-platform.ts';
import { AutomaticRecoverySupersededError, AutonomousAdmissionDeferredError, DelegatedDispatchSupersededError, InternalContinuationSupersededError, SourceActivationSupersededError } from '../runtime-policy.ts';
import { fenceCleanSetupPersistence as sessionOpFenceCleanSetupPersistence, clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry } from './start-recovery-dispatch.ts';
import { retainFailedCleanRetrySetup as sessionOpRetainFailedCleanRetrySetup } from './retain-failed-clean-retry-setup.ts';
import type { RuntimePreparationInput } from './runtime-preparation-input.ts';

export async function handleRuntimePreparationError(
    runtimePreparationInput: RuntimePreparationInput,
    error: unknown,
    cleanRecoveryConversionFlushFailed: boolean,
    cleanRecoveryHandoffPrompt: boolean
): Promise<void> {
    const {
        managed,
        activeMessageState,
        userMessage,
        sessionOperationContext,
        sendSpan,
        ownsActiveTurn,
        finishSupersededDelegatedDispatch,
        finishSupersededAuthenticatedInternalContinuation,
        finishSupersededAutomaticRecovery,
        finishSupersededSourceActivation,
        finishCancelledPreparation,
        finishDeferredPreparation,
        contextLimitAnswerSetupRollback,
        removeSyntheticAutomaticMessage,
        rollbackQueuedAgentDeliveryPreparation,
        cleanExplicitRetrySetupRollback,
        restoreStartedAutomaticDispatch,
    } = runtimePreparationInput;

if (error instanceof DelegatedDispatchSupersededError) {
        sendSpan.mark('delegated_dispatch.superseded');
        sendSpan.end();
        await finishSupersededDelegatedDispatch();
        return;
    }
    if (error instanceof InternalContinuationSupersededError) {
        sendSpan.mark('authenticated_internal_continuation.superseded');
        sendSpan.end();
        await finishSupersededAuthenticatedInternalContinuation();
        return;
    }
    if (error instanceof AutomaticRecoverySupersededError) {
        sendSpan.mark('automatic_recovery.superseded');
        sendSpan.end();
        await finishSupersededAutomaticRecovery();
        return;
    }
    if (error instanceof SourceActivationSupersededError) {
        await finishSupersededSourceActivation();
        return;
    }
    if (!ownsActiveTurn()) {
        await finishCancelledPreparation();
        return;
    }
    if (error instanceof AutonomousAdmissionDeferredError) {
        await finishDeferredPreparation();
        return;
    }
    if (cleanRecoveryConversionFlushFailed) {
        let failedDispatchId = contextLimitAnswerSetupRollback?.();
        if (!failedDispatchId) {
            const started = managed.pendingTurnRecovery?.recoveryDispatch;
            if (started?.phase === 'started' && started.cleanContinuationId
                && started.id === userMessage.id) {
                removeSyntheticAutomaticMessage();
                const allocated = { ...started, phase: 'allocated' as const };
                delete allocated.startedAt;
                managed.pendingTurnRecovery = {
                    ...managed.pendingTurnRecovery!,
                    recoveryDispatch: allocated,
                };
                managed.messageQueue = managed.messageQueue.filter(item => (item.messageId !== allocated.id
                    && item.options?.automaticRecovery?.dispatchId !== allocated.id));
                sessionOperationContext.owner["setProcessing"](managed, false);
                failedDispatchId = allocated.id;
            }
        }
        if (failedDispatchId) {
            sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, failedDispatchId);
            sendSpan.mark('clean_recovery.persistence_error');
            sendSpan.end();
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error', sessionId: managed.id,
                error: {
                    code: 'provider_error',
                    title: 'Recovery state was not persisted',
                    message: 'The clean recovery boundary could not be durably saved. No provider setup attempt was spent; Retry after storage is available.',
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                    canRetry: true,
                },
            }, managed.workspace.id);
            await sessionOperationContext.owner["onProcessingStopped"](runtimePreparationInput.sessionId, 'error', runtimePreparationInput.myGeneration);
            return;
        }
    }
    sessionLog.error(`Failed to prepare agent runtime for session ${runtimePreparationInput.sessionId}:`, error);
    sessionRuntimeHooks.captureException(error, { errorSource: 'chat_setup', sessionId: runtimePreparationInput.sessionId });
    sendSpan.mark('agent.setup_error');
    sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error));
    sendSpan.end();
    sessionOperationContext.owner["sendEvent"]({
        type: 'error',
        sessionId: runtimePreparationInput.sessionId,
        error: error instanceof Error ? error.message : 'Agent runtime setup failed',
    }, managed.workspace.id);
    const rolledBackQueuedAgentDelivery = await rollbackQueuedAgentDeliveryPreparation('runtime preparation failed before provider handoff', error);
    if (rolledBackQueuedAgentDelivery) {
        try {
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'agent-delivery setup retry');
        }
        catch (disposeError) {
            sessionLog.warn('Failed to dispose runtime after a pre-provider delivery error', {
                sessionId: runtimePreparationInput.sessionId,
                error: disposeError instanceof Error ? disposeError.message : String(disposeError),
            });
        }
        const persistenceFenced = Number.isFinite(userMessage.agentDelivery?.setupPersistenceFencedAt)
            || sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(runtimePreparationInput.sessionId) === userMessage.agentDelivery?.id;
        const blockedAt = userMessage.agentDelivery?.setupRetryBlockedAt;
        if (persistenceFenced) {
            sessionOperationContext.state.deferredAutomaticSessions.delete(runtimePreparationInput.sessionId);
            sessionOpClearDeferredAutomaticRetry(sessionOperationContext, runtimePreparationInput.sessionId);
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error',
                sessionId: runtimePreparationInput.sessionId,
                error: {
                    code: 'provider_error', title: 'Agent delivery state requires confirmation',
                    message: 'The queued agent delivery was restored in memory, but its durable rollback could not be confirmed. No provider will start; use Retry after storage is available.',
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                },
            }, managed.workspace.id);
        }
        else if (blockedAt) {
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error',
                sessionId: runtimePreparationInput.sessionId,
                error: {
                    code: 'provider_error', title: 'Agent delivery setup paused',
                    message: `The queued agent delivery remains safe, but provider setup is paused (${userMessage.agentDelivery?.lastSetupFailureClass ?? 'unknown'}). Resolve the provider issue, then Retry.`,
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                },
            }, managed.workspace.id);
        }
        else {
            sessionOperationContext.state.deferredAutomaticSessions.add(runtimePreparationInput.sessionId);
            sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](runtimePreparationInput.sessionId, Math.max(0, (userMessage.agentDelivery?.setupRetryNotBefore ?? Date.now()) - Date.now()));
        }
        return;
    }
    const failedContextLimitAnswerDispatchId = contextLimitAnswerSetupRollback?.();
    if (failedContextLimitAnswerDispatchId) {
        try {
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean pre-provider setup retry');
        }
        catch (disposeError) {
            sessionLog.warn('Failed to dispose runtime after a clean pre-provider setup error', {
                sessionId: runtimePreparationInput.sessionId,
                error: disposeError instanceof Error ? disposeError.message : String(disposeError),
            });
        }
        await sessionOpRetainFailedCleanRetrySetup(sessionOperationContext, managed, failedContextLimitAnswerDispatchId, error);
    }
    else if (cleanRecoveryHandoffPrompt && runtimePreparationInput.cleanExplicitRetry && cleanExplicitRetrySetupRollback) {
        // The boundary was durable but no provider runtime was created. Roll
        // back only this new hidden row to its acknowledged allocation. The
        // bounded helper persists its classified failure before arming a retry.
        const failedDispatchId = cleanExplicitRetrySetupRollback();
        if (failedDispatchId) {
            try {
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean pre-provider setup retry');
            }
            catch (disposeError) {
                sessionLog.warn('Failed to dispose runtime after a clean pre-provider setup error', {
                    sessionId: runtimePreparationInput.sessionId,
                    error: disposeError instanceof Error ? disposeError.message : String(disposeError),
                });
            }
            await sessionOpRetainFailedCleanRetrySetup(sessionOperationContext, managed, failedDispatchId, error);
        }
    }
    else if (cleanRecoveryHandoffPrompt && activeMessageState.syntheticAutomaticMessage
        && managed.pendingTurnRecovery?.recoveryDispatch?.cleanContinuationId) {
        const failedDispatchId = managed.pendingTurnRecovery.recoveryDispatch.id;
        if (restoreStartedAutomaticDispatch()) {
            removeSyntheticAutomaticMessage();
            sessionOperationContext.owner["setProcessing"](managed, false);
            try {
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean pre-provider setup retry');
            }
            catch (disposeError) {
                sessionLog.warn('Failed to dispose runtime after a clean pre-provider setup error', {
                    sessionId: runtimePreparationInput.sessionId,
                    error: disposeError instanceof Error ? disposeError.message : String(disposeError),
                });
            }
            await sessionOpRetainFailedCleanRetrySetup(sessionOperationContext, managed, failedDispatchId, error);
        }
    }
    else if (removeSyntheticAutomaticMessage()) {
        // No provider saw this recovery prompt. Persist its exact removal
        // before publishing the terminal setup failure, otherwise a restart
        // can inject the undelivered hidden row as SDK recovery history.
        sessionOperationContext.owner["persistSession"](managed);
        try {
            await sessionOperationContext.owner.flushSession(runtimePreparationInput.sessionId);
        }
        catch (cleanupError) {
            sessionLog.warn('Failed to flush undelivered automatic recovery cleanup', {
                sessionId: runtimePreparationInput.sessionId,
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            });
        }
    }
    await sessionOperationContext.owner["onProcessingStopped"](runtimePreparationInput.sessionId, 'error', runtimePreparationInput.myGeneration);
    return;
}
