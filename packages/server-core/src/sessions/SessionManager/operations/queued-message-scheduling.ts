import type { ManagedSession } from '../managed-session.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { hasUnscheduledQueuedUserInput, validAllocatedRecoveryDispatch, isExactQueuedSourceActivation, isClosedColdResumeStatus, isDirectHumanContinuation } from '../policy.ts';
import { sessionLog, sessionRuntimeHooks } from '../runtime-platform.ts';
import { CleanRecoveryDispatchAuthenticationError } from '../runtime-policy.ts';
import { hasPendingDecision as sessionOpHasPendingDecision, hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { isExactQueuedCleanRecoveryDispatch as sessionOpIsExactQueuedCleanRecoveryDispatch } from './start-recovery-dispatch.ts';
import { cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries, consumeLiveDirectHumanContinuation as sessionOpConsumeLiveDirectHumanContinuation } from './create-autonomous-context-limit-handoff.ts';
import { restorePreAckAgentDeliveryDequeues as sessionOpRestorePreAckAgentDeliveryDequeues } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { isStaleTypedUpwardAgentDelivery as sessionOpIsStaleTypedUpwardAgentDelivery, quarantineStaleTypedUpwardAgentDelivery as sessionOpQuarantineStaleTypedUpwardAgentDelivery, releasableUpwardAgentDeliverySenderId as sessionOpReleasableUpwardAgentDeliverySenderId } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { settleQueuedAgentDeliveryDispatch as sessionOpSettleQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';

export function scheduleQueuedMessageDispatch(managed: ManagedSession, sessionOperationContext: SessionOperationContext, dispatchGeneration: number, sessionId: string, dispatchToken: symbol, next: ManagedSession['messageQueue'][number], nextIndex: number, selectedDirectHumanId: string | undefined, selectedLiveDirectId: string | undefined, actionableUpwardSenderId: string | undefined, autonomous: boolean): void {
    // Process message (use setImmediate to allow current stack to clear)
    setImmediate(() => {
        // Stop invalidates even an internal nudge without a transcript message ID.
        // Do not clear a reservation that belongs to a newer generation.
        if (managed.processingGeneration !== dispatchGeneration || sessionOperationContext.state.queuedMessageDispatches.get(sessionId) !== dispatchToken) {
            sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext, next.messageId, dispatchToken);
            return;
        }
        const currentPending = managed.pendingTurnRecovery;
        const currentCleanDispatch = currentPending
            ? validAllocatedRecoveryDispatch(currentPending)
            : undefined;
        if (currentPending && currentCleanDispatch?.cleanContinuationId
            && next.options?.automaticRecovery?.dispatchId === currentCleanDispatch.id
            && !sessionOpIsExactQueuedCleanRecoveryDispatch(sessionOperationContext, managed, currentPending, currentCleanDispatch, next)) {
            managed.messageQueue.splice(Math.min(nextIndex, managed.messageQueue.length), 0, next);
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
            return;
        }
        if (next.options?.internalOrigin?.kind === 'source-activation'
            && !isExactQueuedSourceActivation(managed, next)) {
            if (next.messageId) {
                const staleIndex = managed.messages.findIndex(candidate => candidate.id === next.messageId
                    && candidate.role === 'user' && candidate.isQueued === true
                    && candidate.internalOrigin?.kind === 'source-activation');
                if (staleIndex >= 0)
                    managed.messages.splice(staleIndex, 1);
            }
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            sessionOperationContext.owner["persistSession"](managed);
            void sessionOperationContext.owner.flushSession(sessionId).catch(error => {
                sessionLog.warn('Failed to flush rejected source-activation dequeue', {
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }).finally(() => {
                if (!managed.isProcessing && managed.messageQueue.length > 0)
                    sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
            });
            return;
        }
        const selectedDirectStillExact = !!selectedDirectHumanId
            && isDirectHumanContinuation(managed, next.message, next.options, selectedDirectHumanId)
            && !managed.messageQueue.some(item => item.messageId === selectedDirectHumanId);
        const selectedLiveDirectStillExact = selectedDirectStillExact && !!selectedLiveDirectId
            && sessionOperationContext.state.liveDirectHumanContinuationIds.get(managed)?.has(selectedLiveDirectId) === true;
        const reservedColdHumanBecameClosed = !!selectedDirectHumanId
            && (isClosedColdResumeStatus(managed) || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))
            && !selectedLiveDirectStillExact;
        const reservedDirectIdentityChanged = !!selectedDirectHumanId && !selectedDirectStillExact;
        if (reservedColdHumanBecameClosed || reservedDirectIdentityChanged) {
            if (selectedLiveDirectId)
                sessionOpConsumeLiveDirectHumanContinuation(sessionOperationContext, managed, selectedLiveDirectId);
            const restoredIndex = Math.min(nextIndex, managed.messageQueue.length);
            managed.messageQueue.splice(restoredIndex, 0, next);
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            sessionOperationContext.owner["persistSession"](managed);
            // A later exact live row may have arrived while this cold row owned the
            // reservation. Give that capability one prompt chance to drain now.
            if (isClosedColdResumeStatus(managed) || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)) {
                sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
            }
            return;
        }
        if (next.options?.automaticRecovery
            && next.options.automaticRecovery.cause !== 'user_retry'
            && sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext, managed, next.options.automaticRecovery)) {
            // Keep the dequeue reservation until the cancellation itself is
            // durable. A concurrently accepted human turn will then start from a
            // snapshot that cannot resurrect the obsolete recovery after restart.
            sessionOperationContext.owner["persistSession"](managed);
            void sessionOperationContext.owner.flushSession(managed.id).catch(error => {
                sessionLog.warn('Failed to flush superseded automatic recovery cancellation', {
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }).finally(() => {
                if (sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === dispatchToken) {
                    sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
                }
                sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
                if (!managed.isProcessing && managed.messageQueue.length > 0) {
                    sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
                }
                else if (!managed.isProcessing) {
                    void sessionOperationContext.owner["onProcessingStopped"](sessionId, 'complete', managed.processingGeneration);
                }
            });
            return;
        }
        const messageStillQueued = !next.messageId || managed.messages.some(message => message.id === next.messageId && message.isQueued);
        const recoveryStillPending = !next.options?.automaticRecovery
            || managed.pendingTurnRecovery?.userMessageId === next.options.automaticRecovery.originalUserMessageId;
        if (sessionOperationContext.state.shuttingDown || managed.stopRequested || !messageStillQueued || !recoveryStillPending) {
            sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext, next.messageId, dispatchToken);
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            return;
        }
        const currentActionableUpwardSenderId = actionableUpwardSenderId
            && sessionOpReleasableUpwardAgentDeliverySenderId(sessionOperationContext, managed, next, dispatchToken);
        const currentStaleTypedUpwardDelivery = sessionOpIsStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, next, dispatchToken);
        if (autonomous && currentStaleTypedUpwardDelivery) {
            void sessionOpQuarantineStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, next, dispatchToken, nextIndex);
            return;
        }
        if (autonomous && (hasUnscheduledQueuedUserInput(managed)
            || sessionOperationContext.owner["hasPendingUserInput"](managed)
            || sessionOpHasPendingDecision(sessionOperationContext, managed)
            || !sessionOperationContext.owner["claimAutomaticAdmission"](managed, currentActionableUpwardSenderId))) {
            managed.messageQueue.unshift(next);
            sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext, next.messageId, dispatchToken);
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            return;
        }
        // Publish queued → processing only once every deferred authority and
        // identity check has passed. Emitting before this point can leave the UI
        // stuck in processing when a cold row is requeued after becoming terminal.
        if (next.messageId) {
            const existingMessage = managed.messages.find(m => m.id === next.messageId);
            if (existingMessage && existingMessage.internalOrigin?.kind !== 'user-input') {
                // Leave the durable queue flag until sendMessage persists its recovery
                // marker (or the internal delivery finishes). A crash here must replay it.
                // Question answers publish processing from sendMessage after that flush.
                sessionOperationContext.owner["sendEvent"]({
                    type: 'user_message',
                    sessionId,
                    message: existingMessage,
                    status: 'processing',
                    optimisticMessageId: next.optimisticMessageId
                }, managed.workspace.id);
            }
        }
        sessionOperationContext.owner.sendMessage(sessionId, next.message, next.attachments, next.storedAttachments, next.options, next.messageId, undefined, undefined, undefined, dispatchToken, next).catch(async (err) => {
            const restoredPreAckDeliveries = sessionOpRestorePreAckAgentDeliveryDequeues(sessionOperationContext, managed);
            if (restoredPreAckDeliveries > 0) {
                try {
                    if (!sessionOperationContext.owner["persistSession"](managed)) {
                        throw new Error('The pre-ACK agent-delivery rollback could not be queued for storage');
                    }
                    await sessionOperationContext.owner.flushSession(sessionId);
                }
                catch (rollbackError) {
                    sessionLog.warn('Failed to persist pre-ACK queued delivery rollback', {
                        sessionId,
                        messageId: next.messageId,
                        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                    });
                }
            }
            const currentReservation = sessionOperationContext.state.queuedMessageDispatches.get(sessionId);
            if ((currentReservation && currentReservation !== dispatchToken)
                || managed.processingGeneration > dispatchGeneration + 1)
                return;
            if (currentReservation === dispatchToken)
                sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            sessionLog.error('replay failed', {
                sessionId,
                messageId: next.messageId,
                error: err instanceof Error ? err.message : String(err),
            });
            // Report queued message failures via runtime hooks
            sessionRuntimeHooks.captureException(err, { errorSource: 'chat-queue', sessionId });
            if (err instanceof CleanRecoveryDispatchAuthenticationError) {
                // The exact queued receipt was restored by sendMessage. Keep it
                // durable and idle; immediate FIFO redrain would retry forever.
                sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
                sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error', sessionId,
                    error: {
                        code: 'queued_message_replay_failed',
                        title: 'Queued agent result retained',
                        message: 'The clean recovery boundary has not produced durable provider output. The agent result remains queued for reconciliation.',
                        actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                        canRetry: true,
                        originalError: err.message,
                    },
                }, managed.workspace.id);
                return;
            }
            // Surface a typed error so the UI can show a clear, actionable banner
            // instead of a generic "Unknown error" (#616).
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error',
                sessionId,
                error: {
                    code: 'queued_message_replay_failed',
                    title: 'Queued message could not be sent',
                    message: 'A message you sent while the agent was running could not be re-sent automatically. Tap retry to send it now.',
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                    canRetry: true,
                    originalError: err instanceof Error ? err.message : String(err),
                },
            }, managed.workspace.id);
            // Call onProcessingStopped to handle cleanup and check for more queued messages
            void sessionOperationContext.owner["onProcessingStopped"](sessionId, 'error').catch(cleanupError => {
                sessionLog.error('Queued message failure cleanup failed', {
                    sessionId,
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
            });
        }).finally(() => sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext, next.messageId, dispatchToken));
    });
}


