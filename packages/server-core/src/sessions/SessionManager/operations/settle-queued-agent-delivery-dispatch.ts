import type { SessionOperationContext } from '../operation-context.ts';

function sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext: SessionOperationContext, messageId: string | undefined, dispatchToken: symbol | undefined): void {
    if (!messageId || !dispatchToken)
        return;
    const dispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(messageId);
    if (!dispatch || dispatch.dispatchToken !== dispatchToken)
        return;
    // Reaching this callback boundary without having removed the reservation
    // at receipt=processing means no turn owns the queued receipt anymore.
    dispatch.claimed = false;
    dispatch.dispatchSettled = true;
    if (!sessionOperationContext.state.agentDeliveryAppendsInFlight.has(messageId)) {
        sessionOperationContext.state.queuedAgentDeliveryDispatches.delete(messageId);
    }
}

function sessionOpCompleteQueuedAgentDeliveryDispatch(sessionOperationContext: SessionOperationContext, messageId: string, dispatchToken: symbol | undefined): void {
    if (!dispatchToken)
        return;
    const dispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(messageId);
    if (dispatch?.dispatchToken === dispatchToken)
        sessionOperationContext.state.queuedAgentDeliveryDispatches.delete(messageId);
}

function sessionOpFinishAgentDeliveryAppend(sessionOperationContext: SessionOperationContext, messageId: string): void {
    sessionOperationContext.state.agentDeliveryAppendsInFlight.delete(messageId);
    const dispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(messageId);
    if (dispatch?.dispatchSettled)
        sessionOperationContext.state.queuedAgentDeliveryDispatches.delete(messageId);
}

export { sessionOpSettleQueuedAgentDeliveryDispatch as settleQueuedAgentDeliveryDispatch };
export { sessionOpCompleteQueuedAgentDeliveryDispatch as completeQueuedAgentDeliveryDispatch };
export { sessionOpFinishAgentDeliveryAppend as finishAgentDeliveryAppend };
