import { AbortReason } from '@craft-agent/shared/agent';
import { ProviderDispatchRejectedError } from '@craft-agent/shared/agent/backend';
import { sessionLog, sessionRuntimeHooks } from '../runtime-platform.ts';
import { AutomaticRecoverySupersededError, AutonomousAdmissionDeferredError, InternalContinuationSupersededError, RECOVERY_BUDGET_UNAVAILABLE_MESSAGE, SourceActivationSupersededError } from '../runtime-policy.ts';
import { clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry } from './start-recovery-dispatch.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';
import { runLiveProviderDispatchReconciliation as sessionOpRunLiveProviderDispatchReconciliation } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { retainFailedCleanRetrySetup as sessionOpRetainFailedCleanRetrySetup } from './retain-failed-clean-retry-setup.ts';
import { processEvent as sessionOpProcessEvent } from './process-event.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';

export async function handleProviderTurnError(
    providerTurnInput: ProviderTurnInput,
    error: unknown
): Promise<void> {
    const {
        ownsActiveTurn,
        abandonStoppedTurn,
        recoveryHandoffPaused,
        finishSupersededAuthenticatedInternalContinuation,
        finishSupersededAutomaticRecovery,
        finishSupersededSourceActivation,
        finishDeferredPreparation,
        finishCancelledPreparation,
        contextLimitAnswerSetupRollback,
        cleanExplicitRetrySetupRollback,
        restoreStartedAutomaticDispatch,
        removeSyntheticAutomaticMessage,
        rollbackQueuedAgentDeliveryPreparation,
        sessionOperationContext,
        managed,
        activeProviderState,
        activeMessageState,
        userMessage,
        sendSpan,
    } = providerTurnInput;
if (sessionOperationContext.state.shuttingDown) {
        sendSpan.end();
        return;
    }
    // A provider can ACK synchronously and then throw before the ACK fsync
    // promise marks `chatStarted`. Classify that error only after the ACK
    // transaction settles; otherwise the pre-handoff path can race the ACK
    // snapshot, delete its fence, and incorrectly treat an accepted prompt as
    // a local preflight failure.
    if (activeProviderState.providerHandoffDurabilityPromise && !activeProviderState.chatStarted) {
        try {
            await activeProviderState.providerHandoffDurabilityPromise;
        }
        catch (handoffError) {
            error = handoffError;
        }
    }
    if (error instanceof InternalContinuationSupersededError && !activeProviderState.chatStarted) {
        sendSpan.mark('authenticated_internal_continuation.superseded');
        sendSpan.end();
        await finishSupersededAuthenticatedInternalContinuation();
        return;
    }
    if (error instanceof AutomaticRecoverySupersededError && !activeProviderState.chatStarted) {
        sendSpan.mark('automatic_recovery.superseded');
        sendSpan.end();
        await finishSupersededAutomaticRecovery();
        return;
    }
    if (error instanceof SourceActivationSupersededError && !activeProviderState.chatStarted) {
        await finishSupersededSourceActivation();
        return;
    }
    if (error instanceof AutonomousAdmissionDeferredError && !activeProviderState.chatStarted) {
        await finishDeferredPreparation();
        return;
    }
    if (managed.processingGeneration !== providerTurnInput.myGeneration || (!activeProviderState.chatStarted && !ownsActiveTurn())) {
        await finishCancelledPreparation();
        return;
    }
    if (!activeProviderState.chatStarted) {
        const definitivePreProviderRejection = !activeProviderState.providerWriteAheadReturned
            || error instanceof ProviderDispatchRejectedError
            || activeProviderState.providerDispatchRejected;
        if (definitivePreProviderRejection) {
            await activeProviderState.rollbackProviderWriteAhead();
        }
        else if (activeProviderState.exactProviderWriteAheadMatches()) {
            // The hook returned, so the backend may have written before this
            // abort/error/stream close. Never roll that exact prompt back to the
            // FIFO. Retire it transactionally and continue from current state on
            // a fresh bounded dispatch; Stop waits for this short fsync and wins
            // by restoring then tombstoning the original receipt.
            const reconciliation = sessionOpRunLiveProviderDispatchReconciliation(sessionOperationContext, managed, userMessage, activeProviderState.providerHandoffCancellationEpoch);
            let reconciled = false;
            try {
                reconciled = await reconciliation;
            }
            catch (reconciliationError) {
                if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== activeProviderState.providerHandoffCancellationEpoch
                    || managed.stopRequested) {
                    sendSpan.mark('provider.acceptance_unknown.cancelled');
                    sendSpan.end();
                    await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
                    return;
                }
                sessionLog.warn('Live provider uncertainty remained quarantined after reconciliation failure', {
                    sessionId: providerTurnInput.sessionId,
                    error: reconciliationError instanceof Error
                        ? reconciliationError.message : String(reconciliationError),
                });
            }
            if (reconciled) {
                activeProviderState.providerWriteAheadMarker = undefined;
                sendSpan.mark('provider.acceptance_unknown.reconciled');
                sendSpan.end();
                sessionOperationContext.owner["sendEvent"]({
                    type: 'info',
                    sessionId: providerTurnInput.sessionId,
                    message: 'The provider boundary was uncertain. The exact prompt was retired without replay and work is continuing from the current state…',
                    level: 'warning', timestamp: sessionOpMonotonic(sessionOperationContext),
                }, managed.workspace.id);
                await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'error', providerTurnInput.myGeneration);
                return;
            }
            sendSpan.mark('provider.acceptance_unknown');
            sendSpan.end();
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error',
                sessionId: providerTurnInput.sessionId,
                error: {
                    code: 'provider_error',
                    title: 'Provider acceptance requires confirmation',
                    message: 'The provider may already have accepted this turn. It was preserved without replay; use Retry to reconcile it explicitly.',
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                    canRetry: true,
                },
            }, managed.workspace.id);
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'error', providerTurnInput.myGeneration);
            return;
        }
        let failedSetupDispatchId = contextLimitAnswerSetupRollback?.();
        if (!failedSetupDispatchId && providerTurnInput.cleanRecoveryHandoffPrompt
            && providerTurnInput.cleanExplicitRetry && cleanExplicitRetrySetupRollback) {
            failedSetupDispatchId = cleanExplicitRetrySetupRollback();
        }
        if (!failedSetupDispatchId && providerTurnInput.cleanRecoveryHandoffPrompt && activeMessageState.syntheticAutomaticMessage
            && managed.pendingTurnRecovery?.recoveryDispatch?.cleanContinuationId) {
            const candidateId = managed.pendingTurnRecovery.recoveryDispatch.id;
            if (restoreStartedAutomaticDispatch()) {
                removeSyntheticAutomaticMessage();
                sessionOperationContext.owner["setProcessing"](managed, false);
                failedSetupDispatchId = candidateId;
            }
        }
        if (failedSetupDispatchId) {
            sessionLog.error('Clean recovery preparation failed before the first provider event', {
                sessionId: providerTurnInput.sessionId,
                dispatchId: failedSetupDispatchId,
                error: error instanceof Error ? error.message : String(error),
            });
            sessionRuntimeHooks.captureException(error, { errorSource: 'chat_setup', sessionId: providerTurnInput.sessionId });
            sendSpan.mark('agent.setup_error');
            sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error));
            sendSpan.end();
            try {
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean pre-provider setup retry');
            }
            catch (disposeError) {
                sessionLog.warn('Failed to dispose runtime after a clean pre-provider setup error', {
                    sessionId: providerTurnInput.sessionId,
                    error: disposeError instanceof Error ? disposeError.message : String(disposeError),
                });
            }
            await sessionOpRetainFailedCleanRetrySetup(sessionOperationContext, managed, failedSetupDispatchId, error);
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'error', providerTurnInput.myGeneration);
            return;
        }
    }
    if (!activeProviderState.chatStarted && await rollbackQueuedAgentDeliveryPreparation('late preparation failed before provider handoff', error)) {
        sessionLog.error('Agent delivery preparation failed before provider handoff', {
            sessionId: providerTurnInput.sessionId,
            error: error instanceof Error ? error.message : String(error),
        });
        sessionRuntimeHooks.captureException(error, { errorSource: 'chat_setup', sessionId: providerTurnInput.sessionId });
        sendSpan.mark('agent.setup_error');
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error));
        sendSpan.end();
        sessionOperationContext.owner["sendEvent"]({
            type: 'error',
            sessionId: providerTurnInput.sessionId,
            error: error instanceof Error ? error.message : 'Agent runtime setup failed',
        }, managed.workspace.id);
        try {
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'agent-delivery late setup retry');
        }
        catch (disposeError) {
            sessionLog.warn('Failed to dispose runtime after a late pre-provider delivery error', {
                sessionId: providerTurnInput.sessionId,
                error: disposeError instanceof Error ? disposeError.message : String(disposeError),
            });
        }
        const persistenceFenced = Number.isFinite(userMessage.agentDelivery?.setupPersistenceFencedAt)
            || sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(providerTurnInput.sessionId) === userMessage.agentDelivery?.id;
        const blockedAt = userMessage.agentDelivery?.setupRetryBlockedAt;
        if (persistenceFenced) {
            sessionOperationContext.state.deferredAutomaticSessions.delete(providerTurnInput.sessionId);
            sessionOpClearDeferredAutomaticRetry(sessionOperationContext, providerTurnInput.sessionId);
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error',
                sessionId: providerTurnInput.sessionId,
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
                sessionId: providerTurnInput.sessionId,
                error: {
                    code: 'provider_error', title: 'Agent delivery setup paused',
                    message: `The queued agent delivery remains safe, but provider setup is paused (${userMessage.agentDelivery?.lastSetupFailureClass ?? 'unknown'}). Resolve the provider issue, then Retry.`,
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                },
            }, managed.workspace.id);
        }
        else {
            sessionOperationContext.state.deferredAutomaticSessions.add(providerTurnInput.sessionId);
            sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](providerTurnInput.sessionId, Math.max(0, (userMessage.agentDelivery?.setupRetryNotBefore ?? Date.now()) - Date.now()));
        }
        return;
    }
    if (sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasQueuedUserInput(sessionOperationContext, managed)) {
        // The persisted question/answer handoff is the durable successor to an
        // ACKed provider turn. Release only that accepted fence; an unknown
        // write remains quarantined for explicit reconciliation.
        await activeProviderState.clearAcceptedProviderWriteAhead();
        sendSpan.end();
        await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
        return;
    }
    // Check if this is an abort error (expected when interrupted)
    const isAbortError = error instanceof Error && (error.name === 'AbortError' ||
        error.message === 'Request was aborted.' ||
        error.message.includes('aborted'));
    if (isAbortError) {
        // Extract abort reason if available (safety net for unexpected abort propagation)
        const reason = (error as DOMException).cause as AbortReason | undefined;
        sessionLog.info(`Chat aborted (reason: ${reason || 'unknown'})`);
        sendSpan.mark('chat.aborted');
        sendSpan.setMetadata('abort_reason', reason || 'unknown');
        sendSpan.end();
        // UI handoff paths (plan submission, auth request) handle their own cleanup
        // by setting isProcessing = false directly. All other abort reasons route
        // through onProcessingStopped for queue draining.
        if (reason !== AbortReason.UserStop && !managed.stopRequested
            && userMessage.providerDispatch?.state === 'accepted'
            && activeProviderState.exactProviderWriteAheadMatches()) {
            const reconciled = await sessionOpRunLiveProviderDispatchReconciliation(sessionOperationContext, managed, userMessage, activeProviderState.providerHandoffCancellationEpoch);
            if (reconciled)
                activeProviderState.providerWriteAheadMarker = undefined;
        }
        if (reason === AbortReason.UserStop || reason === AbortReason.Redirect || reason === undefined) {
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
        }
    }
    else {
        sessionLog.error('Error in chat:', error);
        sessionLog.error('Error message:', error instanceof Error ? error.message : String(error));
        sessionLog.error('Error stack:', error instanceof Error ? error.stack : 'No stack');
        // Report chat/SDK errors via runtime hooks (Electron can forward to Sentry)
        sessionRuntimeHooks.captureException(error, { errorSource: 'chat', sessionId: providerTurnInput.sessionId });
        sendSpan.mark('chat.error');
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error));
        sendSpan.end();
        const failedObjective = managed.activeObjective;
        if (recoveryHandoffPaused() || managed.activeObjective !== failedObjective) {
            sendSpan.end();
            await abandonStoppedTurn();
            return;
        }
        const recoveryQueued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'runtime_error');
        if (recoveryHandoffPaused() || managed.activeObjective !== failedObjective) {
            sendSpan.end();
            await abandonStoppedTurn();
            return;
        }
        if (!recoveryQueued) {
            const unresolved = managed.messages.filter(message => message.role === 'tool'
                && !!message.toolUseId && activeProviderState.pendingToolReceipts.has(message.toolUseId)
                && message.toolStatus === 'executing' && message.toolResult === undefined);
            for (const message of unresolved) {
                // The transport stopped, not necessarily the operation. Keep its
                // execution truth and missing receipt unknown; never synthesize proof.
                message.toolStatus = 'error';
                message.isError = true;
            }
            const details = [
                error instanceof Error ? error.message : 'Unknown runtime error',
                ...(unresolved.length ? [
                    'Tool response reception was interrupted; the operation result is unknown. Inspect the existing operation and its outputs before any retry; do not repeat it solely because the response is missing.',
                ] : []),
                ...(managed.pendingTurnRecovery?.budgetHistoryUnavailable ? [RECOVERY_BUDGET_UNAVAILABLE_MESSAGE] : []),
            ].join('\n\n');
            await sessionOpProcessEvent(sessionOperationContext, managed, {
                type: 'error',
                message: details,
            }, providerTurnInput.myGeneration);
        }
        await activeProviderState.clearAcceptedProviderWriteAhead();
        // Handle error via centralized handler
        await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'error', providerTurnInput.myGeneration);
    }
}
