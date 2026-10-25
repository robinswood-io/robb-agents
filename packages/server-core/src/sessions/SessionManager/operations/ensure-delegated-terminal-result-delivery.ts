import type { SessionOperationContext } from '../operation-context.ts';
import { delegatedTerminalResultDeliveryId, delegatedTerminalResultContent, enqueueRecoveredMessageInTranscriptOrder } from '../policy.ts';
import { acknowledgeDurableDelivery, recoveredInternalMessageOptions } from '../../agent-delivery.ts';
import type { UserInputQuestion } from '@craft-agent/core';
import type { Message } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { DELEGATED_TERMINAL_RESULT_PROTOCOL } from '../runtime-policy.ts';
import { isCurrentDelegatedDescendant as sessionOpIsCurrentDelegatedDescendant } from './is-current-delegated-descendant.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo, stopYoloHumanHandoff as sessionOpStopYoloHumanHandoff } from './is-managed-session-yolo.ts';

function sessionOpDelegatedTerminalResultReceipt(sessionOperationContext: SessionOperationContext, parent: ManagedSession, child: ManagedSession): Message | undefined {
    const deliveryId = delegatedTerminalResultDeliveryId(parent, child);
    if (!deliveryId)
        return undefined;
    return parent.messages.find(message => (message.role === 'user'
        && message.agentDelivery?.id === deliveryId
        && message.internalOrigin?.kind === 'agent-message'
        && message.internalOrigin.senderSessionId === child.id
        && message.content.startsWith(DELEGATED_TERMINAL_RESULT_PROTOCOL)));
}

/** Deliver one host-owned terminal envelope. The deterministic receipt ID is
 * the exactly-once key; failed attempts reuse that row rather than appending a
 * second result. */
async function sessionOpEnsureDelegatedTerminalResultDelivery(sessionOperationContext: SessionOperationContext, child: ManagedSession, deferRecipientDispatch = false): Promise<boolean> {
    const delegation = child.delegation;
    const parent = child.parentSessionId ? sessionOperationContext.state.sessions.get(child.parentSessionId) : undefined;
    if (!delegation || !parent || parent.workspace.id !== child.workspace.id)
        return false;
    await Promise.all([sessionOperationContext.owner["ensureMessagesLoaded"](child), sessionOperationContext.owner["ensureMessagesLoaded"](parent)]);
    if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.sessions.get(child.id) !== child
        || sessionOperationContext.state.sessions.get(parent.id) !== parent
        || !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, parent, child))
        return false;
    if (!child.delegation?.finishedAt && !sessionOpHasTerminalObjectiveState(sessionOperationContext, child))
        return false;
    const deliveryId = delegatedTerminalResultDeliveryId(parent, child);
    if (!deliveryId)
        return false;
    const existing = sessionOpDelegatedTerminalResultReceipt(sessionOperationContext, parent, child);
    if (existing?.agentDelivery?.status === 'processed') {
        sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
        return true;
    }
    if (existing?.agentDelivery) {
        if (existing.agentDelivery.status === 'processing' && parent.isProcessing)
            return true;
        if (existing.agentDelivery.status === 'failed' && existing.agentDelivery.attempts >= 3) {
            if (sessionOpIsManagedSessionYolo(sessionOperationContext, parent)) {
                sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
                await sessionOpStopYoloHumanHandoff(sessionOperationContext, parent, `YOLO child-result delivery exhausted after three attempts (${child.id}). The exact terminal receipt is retained; child work was not repeated.`);
                return false;
            }
            const questions: UserInputQuestion[] = [{
                    id: `retry-child-result-${child.id}`.slice(0, 80),
                    question: 'Le résultat terminal du sous-agent a été conservé, mais sa livraison au parent a échoué trois fois. Faut-il réessayer cette même livraison sans répéter le travail enfant ?',
                    options: [{
                            id: 'retry-delivery',
                            label: 'Réessayer la livraison',
                            description: 'Réutiliser le reçu terminal existant avec les barrières anti-rejeu.',
                            recommended: true,
                        }],
                }];
            const pendingQuestion = parent.userInputRequests?.find(request => request.status === 'pending');
            if (!pendingQuestion) {
                await sessionOperationContext.owner.requestUserInput(parent.id, questions);
                sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
                return true;
            }
            const exactRetryQuestionAlreadyPending = pendingQuestion.objectiveUserMessageId
                === parent.activeObjective?.userMessageId
                && pendingQuestion.questions.length === 1
                && pendingQuestion.questions[0]?.id === questions[0]?.id;
            if (exactRetryQuestionAlreadyPending) {
                sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
                return true;
            }
            // Another host/user question owns the single prompt slot. Retain the
            // failed receipt and report an incomplete reconciliation so the
            // durable retry timer keeps polling; answering/cancelling that question
            // also triggers an immediate exact-child reconciliation below.
            return false;
        }
        // A process loss or a failed recipient generation replays the same
        // receipt. No new delivery identity or transcript row is minted.
        existing.agentDelivery.status = 'queued';
        existing.isQueued = true;
        if (!parent.messageQueue.some(item => item.messageId === existing.id)) {
            enqueueRecoveredMessageInTranscriptOrder(parent, {
                message: existing.content,
                messageId: existing.id,
                storedAttachments: existing.attachments,
                options: recoveredInternalMessageOptions(existing),
            });
        }
        sessionOperationContext.state.deferredAutomaticSessions.add(parent.id);
        sessionOperationContext.owner["persistSession"](parent);
        await sessionOperationContext.owner.flushSession(parent.id);
        sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
        if (!deferRecipientDispatch && !parent.isProcessing)
            sessionOperationContext.owner["processNextQueuedMessage"](parent.id);
        return true;
    }
    const content = delegatedTerminalResultContent(child);
    await acknowledgeDurableDelivery(ack => sessionOperationContext.owner.sendMessage(parent.id, content, undefined, undefined, {
        hidden: true,
        internalOrigin: {
            kind: 'agent-message', senderSessionId: child.id, deliveryId,
            agentMessageType: 'result',
        },
    }, undefined, undefined, ack), error => {
        sessionLog.warn('Delegated terminal result recipient failed after durable acceptance', {
            parentSessionId: parent.id,
            childSessionId: child.id,
            deliveryId,
            error: error instanceof Error ? error.message : String(error),
        });
        sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
    });
    sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
    return true;
}

function sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext: SessionOperationContext, childSessionId: string): void {
    const timer = sessionOperationContext.state.delegatedTerminalResultRetryTimers.get(childSessionId);
    if (timer)
        clearTimeout(timer);
    sessionOperationContext.state.delegatedTerminalResultRetryTimers.delete(childSessionId);
    sessionOperationContext.state.delegatedTerminalResultRetryAttempts.delete(childSessionId);
}

function sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext: SessionOperationContext, childSessionId: string): void {
    if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.delegatedTerminalResultRetryTimers.has(childSessionId))
        return;
    const child = sessionOperationContext.state.sessions.get(childSessionId);
    if (!child?.delegation || (!child.delegation.finishedAt && !sessionOpHasTerminalObjectiveState(sessionOperationContext, child)))
        return;
    const parent = child.parentSessionId ? sessionOperationContext.state.sessions.get(child.parentSessionId) : undefined;
    if (!parent || !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, parent, child)) {
        sessionOperationContext.state.delegatedTerminalResultRetryAttempts.delete(childSessionId);
        return;
    }
    const attempt = (sessionOperationContext.state.delegatedTerminalResultRetryAttempts.get(childSessionId) ?? 0) + 1;
    sessionOperationContext.state.delegatedTerminalResultRetryAttempts.set(childSessionId, attempt);
    const delayMs = Math.min(30000, 250 * (2 ** Math.min(attempt - 1, 7)));
    const timer = setTimeout(() => {
        sessionOperationContext.state.delegatedTerminalResultRetryTimers.delete(childSessionId);
        const current = sessionOperationContext.state.sessions.get(childSessionId);
        if (sessionOperationContext.state.shuttingDown || !current) {
            sessionOperationContext.state.delegatedTerminalResultRetryAttempts.delete(childSessionId);
            return;
        }
        void sessionOpEnsureDelegatedTerminalResultDelivery(sessionOperationContext, current).then(delivered => {
            if (!delivered)
                sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, childSessionId);
        }, error => {
            sessionLog.warn('Delegated terminal result retry failed', {
                childSessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, childSessionId);
        });
    }, delayMs);
    timer.unref?.();
    sessionOperationContext.state.delegatedTerminalResultRetryTimers.set(childSessionId, timer);
}

export { sessionOpDelegatedTerminalResultReceipt as delegatedTerminalResultReceipt };
export { sessionOpEnsureDelegatedTerminalResultDelivery as ensureDelegatedTerminalResultDelivery };
export { sessionOpClearDelegatedTerminalResultRetry as clearDelegatedTerminalResultRetry };
export { sessionOpScheduleDelegatedTerminalResultRetry as scheduleDelegatedTerminalResultRetry };
