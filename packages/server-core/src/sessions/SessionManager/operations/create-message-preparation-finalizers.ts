import { cancelSourceActivationPending } from '../policy.ts';
import { consumeAuthenticatedInternalContinuation as sessionOpConsumeAuthenticatedInternalContinuation, consumeDelegatedDispatchContinuation as sessionOpConsumeDelegatedDispatchContinuation } from './message-authority.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { hasRunningBackgroundTasks as sessionOpHasRunningBackgroundTasks } from './evict-idle-session-runtimes.ts';
import type { MessagePreparationFinalizerInput } from './message-preparation-finalizer-input.ts';

export function createMessagePreparationFinalizers(
    input: MessagePreparationFinalizerInput
) {
    const {
        ownsActiveTurn,
        sessionOperationContext,
        sessionId,
        restoreStartedAutomaticDispatch,
        userMessage,
        deliveryAttemptsBeforePreparation,
        managed,
        myGeneration,
        queuedItem,
        activeMessageState,
        attachments,
        storedAttachments,
        sendSpan,
        abandonStoppedTurn,
        sourceActivationOrigin,
        authenticatedInternalContinuationToken,
        existingMessageId,
        existingTurnRollback,
        delegatedDispatchContinuationToken,
    } = input;
const finishDeferredPreparation = async () => {
        if (!ownsActiveTurn())
            return;
        sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
        restoreStartedAutomaticDispatch();
        userMessage.isQueued = true;
        if (userMessage.agentDelivery && deliveryAttemptsBeforePreparation !== undefined) {
            userMessage.agentDelivery.attempts = deliveryAttemptsBeforePreparation;
            userMessage.agentDelivery.status = 'queued';
            if (managed.activeAgentDelivery?.generation === myGeneration
                && managed.activeAgentDelivery.deliveryId === userMessage.agentDelivery.id) {
                managed.activeAgentDelivery = undefined;
            }
        }
        if (!managed.messageQueue.some(item => item.messageId === userMessage.id)) {
            managed.messageQueue.unshift(queuedItem?.messageId === userMessage.id ? queuedItem
                : { message: activeMessageState.message, ...(attachments !== undefined ? { attachments: attachments } : {}), ...(storedAttachments !== undefined ? { storedAttachments: storedAttachments } : {}), ...(activeMessageState.options !== undefined ? { options: activeMessageState.options } : {}), messageId: userMessage.id });
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
        sendSpan.end();
        if (ownsActiveTurn())
            await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'interrupted', myGeneration);
    };
    const finishCancelledPreparation = async () => {
        sendSpan.mark('agent.preparation_cancelled');
        sendSpan.end();
        // Stop may finish before lazy runtime preparation returns. Dispose that
        // late runtime, but never clean up a newer request or emit its completion.
        if (managed.processingGeneration !== myGeneration)
            return;
        if ((managed.agent || managed.poolServer || managed.mcpPool) && !sessionOpHasRunningBackgroundTasks(sessionOperationContext, managed)) {
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'cancelled turn preparation');
        }
        await abandonStoppedTurn();
    };
    const finishSupersededSourceActivation = async () => {
        if (!sourceActivationOrigin)
            return;
        sendSpan.mark('source_activation.superseded');
        sendSpan.end();
        const pending = managed.autoRetryPending;
        if (pending?.sourceActivationId === sourceActivationOrigin.sourceActivationId
            && pending.providerStarted !== true) {
            cancelSourceActivationPending(managed, pending);
        }
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
        const sourceIndex = managed.messages.findIndex(candidate => candidate.id === userMessage.id
            && candidate.internalOrigin?.kind === 'source-activation');
        if (sourceIndex >= 0)
            managed.messages.splice(sourceIndex, 1);
        if (managed.processingGeneration === myGeneration && managed.isProcessing) {
            sessionOperationContext.owner["setProcessing"](managed, false);
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }
    };
    const finishSupersededAuthenticatedInternalContinuation = async () => {
        if (!authenticatedInternalContinuationToken)
            return;
        sessionOpConsumeAuthenticatedInternalContinuation(sessionOperationContext, authenticatedInternalContinuationToken);
        if (existingMessageId) {
            if (existingTurnRollback)
                existingTurnRollback();
            else if (managed.processingGeneration === myGeneration && managed.isProcessing) {
                // Auth retry reuses the immutable original user row and therefore has
                // no explicit Retry/user-input rollback closure. Release only this
                // stale generation; the newer objective/FIFO state is authoritative.
                sessionOperationContext.owner["setProcessing"](managed, false);
            }
        }
        else {
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
            const index = managed.messages.indexOf(userMessage);
            if (index >= 0 && userMessage.hidden
                && (userMessage.internalOrigin?.kind === 'auth-result'
                    || userMessage.internalOrigin?.kind === 'auth-retry')) {
                managed.messages.splice(index, 1);
            }
            if (managed.processingGeneration === myGeneration && managed.isProcessing) {
                sessionOperationContext.owner["setProcessing"](managed, false);
            }
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }
    };
    const finishSupersededDelegatedDispatch = async () => {
        if (!delegatedDispatchContinuationToken)
            return;
        sessionOpConsumeDelegatedDispatchContinuation(sessionOperationContext, delegatedDispatchContinuationToken);
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
        const index = managed.messages.indexOf(userMessage);
        if (index >= 0 && userMessage.internalOrigin?.kind === 'spawned-session') {
            managed.messages.splice(index, 1);
        }
        if (managed.activeObjective?.userMessageId === userMessage.id) {
            managed.activeObjective = undefined;
        }
        if (managed.pendingTurnRecovery?.userMessageId === userMessage.id) {
            managed.pendingTurnRecovery = undefined;
        }
        if (managed.processingGeneration === myGeneration && managed.isProcessing) {
            sessionOperationContext.owner["setProcessing"](managed, false);
        }
        if (managed.lastSentMessage === activeMessageState.message) {
            managed.lastSentMessage = undefined;
            managed.lastSentAttachments = undefined;
            managed.lastSentStoredAttachments = undefined;
            managed.lastSentOptions = undefined;
        }
        if (managed.delegation && !managed.delegation.finishedAt) {
            managed.delegation.finishedAt = sessionOpMonotonic(sessionOperationContext);
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
    };
    return { finishDeferredPreparation, finishCancelledPreparation, finishSupersededSourceActivation, finishSupersededAuthenticatedInternalContinuation, finishSupersededDelegatedDispatch };
}
