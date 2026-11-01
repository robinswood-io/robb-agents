import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { providerDispatchesAwaitingColdReconciliation, exactProviderDispatchAcceptanceUnknown } from '../policy.ts';
import { AbortReason } from '@craft-agent/shared/agent';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { resetSummarizationClient } from '@craft-agent/shared/utils';
import { createPendingTurnRecovery } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog, sessionRuntimeHooks } from '../runtime-platform.ts';
import { sourceActivationObjectiveBinding } from '../source-activation.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { invalidateSourceActivationRestart as sessionOpInvalidateSourceActivationRestart, dropDeferredSourceActivations as sessionOpDropDeferredSourceActivations } from './repair-legacy-synthetic-objective-authority.ts';
import { restorePreAckAgentDeliveryDequeues as sessionOpRestorePreAckAgentDeliveryDequeues, partitionQueueForStop as sessionOpPartitionQueueForStop, quarantineUnboundStoppedAgentDeliveries as sessionOpQuarantineUnboundStoppedAgentDeliveries } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { providerDispatchAcceptanceUnknown as sessionOpProviderDispatchAcceptanceUnknown, removeInFlightSyntheticAutomaticMessages as sessionOpRemoveInFlightSyntheticAutomaticMessages } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { hasBoundInterruptedTurnRecovery as sessionOpHasBoundInterruptedTurnRecovery, runLiveProviderDispatchReconciliation as sessionOpRunLiveProviderDispatchReconciliation } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { hasAcceptedHumanContinuationQueued as sessionOpHasAcceptedHumanContinuationQueued } from './create-autonomous-context-limit-handoff.ts';
import { recordRetryTelemetry as sessionOpRecordRetryTelemetry } from './telemetry.ts';
import { mintAuthenticatedInternalContinuation as sessionOpMintAuthenticatedInternalContinuation } from './message-authority.ts';

async function sessionOpCancelProcessing(sessionOperationContext: SessionOperationContext, sessionId: string, silent = false): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    // Strong retirement owns a detached session and calls the silent path after
    // ordinary admission has already been closed. Its enclosing deletion is
    // separately tracked by sessionDeletionsInFlight.
    if (silent || !managed)
        return sessionOpPerformCancelProcessing(sessionOperationContext, sessionId, silent);
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformCancelProcessing(sessionOperationContext, sessionId, silent));
}

async function sessionOpPerformCancelProcessing(sessionOperationContext: SessionOperationContext, sessionId: string, silent = false): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    let persistExplicitStopSnapshot: (() => Promise<void>) | undefined;
    if (managed) {
        // Unlike stopRequested (reset after cleanup), this fence survives a Stop
        // completing while an older retry is still awaiting hydration/durability.
        sessionOperationContext.state.turnCancellationEpochs.set(managed, (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) + 1);
        sessionOpInvalidateSourceActivationRestart(sessionOperationContext, managed);
        // Fence a scheduled inbox dispatch before the first asynchronous save.
        managed.stopRequested = true;
        sessionOpRestorePreAckAgentDeliveryDequeues(sessionOperationContext, managed, true);
        await sessionOperationContext.owner.closePendingPermissionRequestsForStop(managed, managed.processingGeneration);
        await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
        const providerReconciliation = sessionOperationContext.state.providerRetryReconciliationTransactions.get(sessionId);
        if (providerReconciliation) {
            try {
                await providerReconciliation;
            }
            catch { /* cancellation restores the exact marker before Stop snapshots it */ }
        }
        const liveProviderReconciliation = sessionOperationContext.state.providerLiveReconciliationTransactions.get(sessionId);
        if (liveProviderReconciliation) {
            try {
                await liveProviderReconciliation;
            }
            catch { /* cancellation restores the exact marker before Stop snapshots it */ }
        }
        persistExplicitStopSnapshot = async (): Promise<void> => {
            const activeObjective = managed.activeObjective;
            const activeObjectiveId = activeObjective?.objectiveId ?? activeObjective?.userMessageId;
            const fencedDispatches = providerDispatchesAwaitingColdReconciliation(managed);
            const accepted = !silent && fencedDispatches.length === 1
                ? fencedDispatches[0]
                : undefined;
            const acceptedMarker = accepted?.providerDispatch;
            const exactCurrentFence = !!accepted
                && (acceptedMarker?.state === 'accepted' || acceptedMarker?.state === 'acceptance-unknown')
                && exactProviderDispatchAcceptanceUnknown(accepted)
                && acceptedMarker.objectiveId === activeObjectiveId
                && acceptedMarker.objectiveUserMessageId === activeObjective?.userMessageId;
            if (!exactCurrentFence) {
                sessionOperationContext.owner["persistSession"](managed);
                await sessionOperationContext.owner.flushSession(managed.id);
                return;
            }
            // Monotonic with respect to the provider receipt. Tests use synthetic
            // future ACK timestamps and wall clocks can also move backwards; an
            // explicit Stop must still produce a structurally valid tombstone.
            const stoppedAt = Math.max(Date.now(), acceptedMarker?.acceptedAt ?? acceptedMarker?.markedAt ?? 0);
            const originalMarker = acceptedMarker!;
            const stoppedMarker: NonNullable<Message['providerDispatch']> = {
                ...originalMarker,
                userStoppedAt: stoppedAt,
                ...(originalMarker.state === 'accepted' ? {
                    state: 'retired-accepted' as const,
                    retiredAt: stoppedAt,
                    retirementReason: 'user-stop-after-provider-ack' as const,
                } : {}),
            };
            accepted.providerDispatch = stoppedMarker;
            sessionOperationContext.state.providerStopTransitionsInFlight.add(managed.id);
            try {
                if (!sessionOperationContext.owner["persistSession"](managed)) {
                    throw new Error('The explicit Stop snapshot could not be queued for durable storage');
                }
                await sessionOperationContext.owner.flushSessionDurably(managed.id);
            }
            catch (error) {
                // The exact ACKed prompt remains consumed, but without a durable Stop
                // tombstone a later turn cannot safely assume that cancellation won.
                // Restore a live/cold barrier and keep the user's Stop marker attached
                // so startup never turns the failure into autonomous work.
                if (accepted.providerDispatch === stoppedMarker) {
                    accepted.providerDispatch = {
                        ...originalMarker,
                        userStoppedAt: stoppedAt,
                    };
                    sessionOperationContext.owner["persistSession"](managed);
                }
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error', sessionId,
                    error: {
                        code: 'provider_error',
                        title: 'Stop state was not persisted',
                        message: 'The provider turn remains safely quarantined because the explicit Stop snapshot could not be made durable. Retry after storage is available.',
                        actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                        canRetry: true,
                    },
                }, managed.workspace.id);
                sessionLog.warn('Failed to persist explicit provider Stop tombstone', {
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            finally {
                sessionOperationContext.state.providerStopTransitionsInFlight.delete(managed.id);
            }
        };
        const acceptanceUnknown = !!sessionOpProviderDispatchAcceptanceUnknown(sessionOperationContext, managed);
        if (!acceptanceUnknown)
            sessionOpDropDeferredSourceActivations(sessionOperationContext, managed, true);
        sessionOpRemoveInFlightSyntheticAutomaticMessages(sessionOperationContext, managed);
        await sessionOperationContext.owner["cancelPendingUserInput"](managed, true, true);
        const preserveExpiredPermissionHandoff = managed.activeObjective?.terminalState === 'blocked_human'
            && managed.pendingTurnRecovery?.waitingForPermission?.recoveryRequired === true;
        if (!managed.isProcessing) {
            managed.processingGeneration++;
            const { retained } = sessionOpPartitionQueueForStop(sessionOperationContext, managed);
            managed.messageQueue = retained;
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            if (retained.length && managed.activeObjective?.terminalState === 'active'
                && !managed.pendingTurnRecovery) {
                const objectiveAnchor = managed.activeObjective.lastUserMessageId
                    ?? managed.activeObjective.userMessageId;
                managed.pendingTurnRecovery = createPendingTurnRecovery(objectiveAnchor);
            }
            if (!preserveExpiredPermissionHandoff && !acceptanceUnknown)
                sessionOperationContext.owner["clearPendingTurnRecovery"](managed, true);
            if (retained.length && managed.activeObjective?.terminalState === 'active'
                && !sessionOpHasBoundInterruptedTurnRecovery(sessionOperationContext, managed)) {
                managed.activeObjective.terminalState = 'blocked_policy';
                managed.activeObjective.completedAt = Date.now();
            }
            sessionOpQuarantineUnboundStoppedAgentDeliveries(sessionOperationContext, managed, retained);
            const retainedIds = new Set(managed.messageQueue
                .map(item => item.messageId).filter((id): id is string => !!id));
            for (const message of managed.messages) {
                if (message.role === 'user' && message.isQueued && !retainedIds.has(message.id))
                    message.isQueued = false;
            }
            await persistExplicitStopSnapshot();
            managed.stopRequested = false;
            sessionOperationContext.owner["sendEvent"]({ type: 'interrupted', sessionId }, managed.workspace.id);
        }
    }
    if (!managed?.isProcessing) {
        return; // No active stream; pending questions were cancelled above
    }
    sessionLog.info('Cancelling processing for session:', sessionId, silent ? '(silent)' : '');
    const { retained: retainedAgentDeliveries, cleared: clearedQueuedMessages } = sessionOpPartitionQueueForStop(sessionOperationContext, managed);
    // Restore only cancelled user/non-receipt rows to the composer. Retained
    // child results stay invisible and durable until an explicit Retry.
    const queuedTexts = clearedQueuedMessages.filter(item => (item.options?.hidden !== true
        && !item.options?.internalOrigin
        && !item.options?.automaticRecovery)).map(q => q.message);
    // Collect queued message IDs so we can remove them from the messages array
    // (they were added when sendMessage was called during processing)
    const queuedMessageIds = new Set(clearedQueuedMessages.map(q => q.messageId).filter((id): id is string => !!id));
    // Stop cancels ordinary FIFO work but retains exact ACKed child receipts.
    managed.messageQueue = retainedAgentDeliveries;
    const preserveExpiredPermissionHandoff = managed.activeObjective?.terminalState === 'blocked_human'
        && managed.pendingTurnRecovery?.waitingForPermission?.recoveryRequired === true;
    if (retainedAgentDeliveries.length && managed.activeObjective?.terminalState === 'active'
        && !managed.pendingTurnRecovery) {
        const objectiveAnchor = managed.activeObjective.lastUserMessageId
            ?? managed.activeObjective.userMessageId;
        managed.pendingTurnRecovery = createPendingTurnRecovery(objectiveAnchor);
    }
    const acceptanceUnknown = !!sessionOpProviderDispatchAcceptanceUnknown(sessionOperationContext, managed);
    if (!preserveExpiredPermissionHandoff && !acceptanceUnknown)
        sessionOperationContext.owner["clearPendingTurnRecovery"](managed, true);
    if (retainedAgentDeliveries.length && managed.activeObjective?.terminalState === 'active'
        && !sessionOpHasBoundInterruptedTurnRecovery(sessionOperationContext, managed)) {
        managed.activeObjective.terminalState = 'blocked_policy';
        managed.activeObjective.completedAt = Date.now();
    }
    sessionOpQuarantineUnboundStoppedAgentDeliveries(sessionOperationContext, managed, retainedAgentDeliveries);
    const retainedMessageIds = new Set(managed.messageQueue.map(q => q.messageId).filter((id): id is string => !!id));
    for (const message of managed.messages) {
        if (message.role === 'user' && message.isQueued
            && !queuedMessageIds.has(message.id) && !retainedMessageIds.has(message.id))
            message.isQueued = false;
    }
    // Remove queued user messages from the persisted messages array
    if (queuedMessageIds.size > 0) {
        managed.messages = managed.messages.filter(m => !queuedMessageIds.has(m.id));
    }
    await persistExplicitStopSnapshot!();
    // Signal intent to stop - let the event loop drain remaining events before clearing isProcessing
    // This prevents losing in-flight messages after soft interrupt
    managed.stopRequested = true;
    // Track interruption so the next user message gets a context note
    // telling the LLM the previous response was cut short
    managed.wasInterrupted = true;
    // Force-abort via Query.close() - sends soft interrupt to the backend
    if (managed.agent) {
        managed.agent.forceAbort(AbortReason.UserStop);
    }
    // Only show "Response interrupted" message when user explicitly clicked Stop
    // Silent mode is used when redirecting (sending new message while processing)
    if (!silent) {
        const interruptedMessage: Message = {
            id: generateMessageId(),
            role: 'info',
            content: 'Response interrupted',
            timestamp: sessionOpMonotonic(sessionOperationContext),
        };
        managed.messages.push(interruptedMessage);
        sessionOperationContext.owner["sendEvent"]({
            type: 'interrupted',
            sessionId,
            message: interruptedMessage,
            // Include queued texts so the UI can restore them to the input field
            ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
        }, managed.workspace.id);
    }
    else {
        // Still send interrupted event but without the message (for UI state update)
        sessionOperationContext.owner["sendEvent"]({
            type: 'interrupted',
            sessionId,
            // Include queued texts so the UI can restore them to the input field
            ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
        }, managed.workspace.id);
    }
    // Safety timeout: if event loop doesn't complete within 5 seconds, force cleanup
    // This handles cases where the generator gets stuck
    setTimeout(() => {
        if (managed.stopRequested && managed.isProcessing) {
            sessionLog.warn('Generator did not complete after stop request, forcing cleanup');
            void sessionOperationContext.owner["onProcessingStopped"](sessionId, 'timeout').catch((error: unknown) => {
                sessionLog.error('Forced stop cleanup failed', {
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    }, 5000);
    // NOTE: We don't clear isProcessing or send complete event here anymore.
    // The event loop will drain remaining events and call onProcessingStopped when done.
}

/**
 * Attempt auth retry: refresh token, destroy agent, resend last message.
 * Shared by both typed_error and plain error auth-retry paths.
 * Returns true if retry was initiated, false if conditions not met.
 */
function sessionOpAttemptAuthRetry(sessionOperationContext: SessionOperationContext, sessionId: string, managed: ManagedSession, workspaceId: string, failureErrorCode?: string, processingGeneration?: number): boolean {
    if (managed.authRetryAttempted || !managed.lastSentMessage)
        return false;
    const generationKey = processingGeneration ?? managed.processingGeneration;
    const retryMessage = managed.lastSentMessage;
    const retryAttachments = managed.lastSentAttachments;
    const retryStoredAttachments = managed.lastSentStoredAttachments;
    const retryOptions = managed.lastSentOptions;
    const retryUserMessage = managed.messages.findLast(message => (message.role === 'user' && !message.isQueued && message.content === retryMessage));
    const retryObjective = managed.activeObjective;
    const retryObjectiveBinding = sourceActivationObjectiveBinding(retryObjective);
    const retryAuthorityEpoch = sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0;
    if (!retryUserMessage || !retryObjectiveBinding)
        return false;
    const retryStillCurrent = () => sessionOperationContext.state.sessions.get(sessionId) === managed
        && !sessionOperationContext.state.shuttingDown && managed.processingGeneration === generationKey
        && managed.activeObjective === retryObjective
        && (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) === retryAuthorityEpoch
        && !sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext, managed);
    if (managed.terminalErrorGeneration === generationKey) {
        managed.terminalErrorGeneration = undefined;
    }
    const reasonCode = failureErrorCode ?? 'authentication_expired';
    sessionOpRecordRetryTelemetry(sessionOperationContext, managed, {
        component: 'generation',
        attempt: 1,
        reasonCode,
        processingGeneration: generationKey,
    });
    sessionOperationContext.owner["finishGenerationTelemetry"](managed, generationKey, 'generation.failed', { errorCode: reasonCode });
    sessionLog.info(`Auth error detected, attempting token refresh and retry for session ${sessionId}`);
    managed.authRetryAttempted = true;
    managed.authRetryInProgress = true;
    // Emit lightweight info so the user sees progress instead of a scary red error
    sessionOperationContext.owner["sendEvent"]({
        type: 'info',
        sessionId,
        message: 'Token expired, refreshing session…',
        timestamp: sessionOpMonotonic(sessionOperationContext),
    }, workspaceId);
    setImmediate(async () => {
        try {
            // 1. Reset summarization client so it picks up fresh credentials
            sessionLog.info(`[auth-retry] Resetting summarization client for session ${sessionId}`);
            resetSummarizationClient();
            // 2. Destroy the complete runtime — the new agent's postInit() will
            // refresh auth. Nulling only the agent leaked its subprocess and MCP pool.
            sessionLog.info(`[auth-retry] Disposing runtime for session ${sessionId}`);
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'authentication refresh retry');
            if (!retryStillCurrent()) {
                managed.authRetryInProgress = false;
                sessionLog.info(`[auth-retry] Abandoned stale retry after a newer human continuation for session ${sessionId}`);
                return;
            }
            // Once the provider has durably ACKed this envelope, refreshing auth
            // cannot authorize submitting the same prompt again: the original may
            // already have mutated external state before reporting token expiry.
            // Consume that receipt together with one fresh inspection continuation
            // and let the new runtime resume from current state instead.
            if (retryUserMessage.providerDispatch?.state === 'accepted'
                && exactProviderDispatchAcceptanceUnknown(retryUserMessage)) {
                const reconciliationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
                const reconciled = await sessionOpRunLiveProviderDispatchReconciliation(sessionOperationContext, managed, retryUserMessage, reconciliationEpoch);
                managed.authRetryInProgress = false;
                if (!reconciled) {
                    throw new Error('The ACKed auth failure could not allocate a non-replay continuation');
                }
                sessionLog.info(`[auth-retry] Reconciled ACKed message ${retryUserMessage.id} without exact replay for session ${sessionId}`);
                await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'error', generationKey);
                return;
            }
            // 3. Retry as a host-authenticated transport continuation. Preserve the
            // original user row and objective revision; never delete "the last"
            // user row or mint the provider retry as new human authority.
            sessionLog.info(`[auth-retry] Retrying exact message ${retryUserMessage.id} for session ${sessionId}`);
            sessionOperationContext.owner["setProcessing"](managed, false);
            managed.authRetryInProgress = false;
            const continuationToken = sessionOpMintAuthenticatedInternalContinuation(sessionOperationContext, managed, 'auth-retry');
            if (!continuationToken) {
                sessionLog.info(`[auth-retry] Abandoned retry without a current authenticated objective for session ${sessionId}`);
                return;
            }
            await sessionOperationContext.owner.sendAuthenticatedInternalContinuation(managed, retryMessage, 'auth-retry', continuationToken, omitUndefined({
                attachments: retryAttachments,
                storedAttachments: retryStoredAttachments,
                options: retryOptions,
                existingMessageId: retryUserMessage.id,
                isAuthRetry: true,
            }));
            sessionLog.info(`[auth-retry] Retry completed for session ${sessionId}`);
        }
        catch (retryError) {
            managed.authRetryInProgress = false;
            if (!retryStillCurrent()) {
                sessionLog.info(`[auth-retry] Ignored stale retry failure after objective replacement for session ${sessionId}`);
                return;
            }
            sessionLog.error(`[auth-retry] Failed to retry after auth refresh for session ${sessionId}:`, retryError);
            sessionRuntimeHooks.captureException(retryError, { errorSource: 'auth-retry', sessionId });
            const failedMessage: Message = {
                id: generateMessageId(),
                role: 'error',
                content: 'Authentication failed. Please check your credentials.',
                timestamp: sessionOpMonotonic(sessionOperationContext),
                ...(failureErrorCode !== undefined ? { errorCode: failureErrorCode } : {}),
            };
            managed.messages.push(failedMessage);
            sessionOperationContext.owner["sendEvent"]({
                type: 'error',
                sessionId,
                error: 'Authentication failed. Please check your credentials.',
                timestamp: failedMessage.timestamp,
            }, workspaceId);
            await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'error');
        }
    });
    return true;
}

export { sessionOpCancelProcessing as cancelProcessing };
export { sessionOpPerformCancelProcessing as performCancelProcessing };
export { sessionOpAttemptAuthRetry as attemptAuthRetry };
