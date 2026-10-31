import { resolveAgentCostControlPolicy } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { DELEGATION_LIMITS } from '../../delegation-budget';
import type { ManagedSession } from '../managed-session.ts';
import { isCurrentDelegatedDescendant as sessionOpIsCurrentDelegatedDescendant } from './is-current-delegated-descendant.ts';
import type { QueuedMessageInput } from './queued-message-input.ts';

export function checkQueuedDeliveryCapacity(
  { deliveryId, options, sessionOperationContext, managed }: Pick<QueuedMessageInput, 'deliveryId' | 'options' | 'sessionOperationContext' | 'managed'>,
): ManagedSession['messageQueue'] {
    const deliverySender = deliveryId && options?.internalOrigin?.senderSessionId
        ? sessionOperationContext.state.sessions.get(options.internalOrigin.senderSessionId)
        : undefined;
    const relevantDelegatedDelivery = !!deliverySender
        && sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, managed, deliverySender);
    const yieldingRecoveries = relevantDelegatedDelivery ? managed.messageQueue.filter(item => {
        const recovery = item.options?.automaticRecovery;
        return !!recovery && recovery.cause !== 'user_retry'
            && recovery.originalUserMessageId === managed.pendingTurnRecovery?.userMessageId;
    }) : [];
    const maxQueuedMessages = deliveryId
        ? resolveAgentCostControlPolicy(loadWorkspaceConfig(managed.workspace.rootPath)?.costControl)
            .coordination.maxQueuedMessages
        : Number.POSITIVE_INFINITY;
    const countQueuedDelegatedDeliveries = (includeProgress: boolean) => managed.messageQueue.filter(item => {
        const origin = item.options?.internalOrigin;
        if (!includeProgress && origin?.kind === 'agent-message' && origin.agentMessageType === 'progress') {
            return false;
        }
        const sender = origin?.kind === 'agent-message' && origin.deliveryId && origin.senderSessionId
            ? sessionOperationContext.state.sessions.get(origin.senderSessionId) : undefined;
        return !!sender && sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, managed, sender);
    }).length;
    const queuedDelegatedDeliveryCount = relevantDelegatedDelivery
        ? countQueuedDelegatedDeliveries(options?.internalOrigin?.agentMessageType === 'progress')
        : 0;
    const queuedDescendantDeliveriesForNonDescendant = !relevantDelegatedDelivery && deliveryId
        ? countQueuedDelegatedDeliveries(true)
        : 0;
    const inboxFull = relevantDelegatedDelivery
        // Every bounded child must be able to return one durable result even
        // when siblings are still active and the ordinary inbox limit is one.
        ? queuedDelegatedDeliveryCount >= DELEGATION_LIMITS.maxChildren
        : managed.messageQueue.length - yieldingRecoveries.length - queuedDescendantDeliveriesForNonDescendant >= maxQueuedMessages;
    if (deliveryId && inboxFull) {
        throw new Error('Target inbox is full; wait for a terminal result before retrying');
    }
    return yieldingRecoveries;
}
