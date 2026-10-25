import type { SessionOperationContext } from '../operation-context.ts';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { isSessionDescendant } from '../../autonomous-session-admission';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { hasPendingDecision as sessionOpHasPendingDecision, hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';
import { authenticatedTypedAgentDeliverySender as sessionOpAuthenticatedTypedAgentDeliverySender } from './exact-user-input-response.ts';
import { currentDelegatedSenderPath as sessionOpCurrentDelegatedSenderPath, isCurrentDelegatedDescendant as sessionOpIsCurrentDelegatedDescendant } from './is-current-delegated-descendant.ts';
import { settleQueuedAgentDeliveryDispatch as sessionOpSettleQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { delegatedTerminalResultReceipt as sessionOpDelegatedTerminalResultReceipt, clearDelegatedTerminalResultRetry as sessionOpClearDelegatedTerminalResultRetry } from './ensure-delegated-terminal-result-delivery.ts';
import { hasExhaustedValidation as sessionOpHasExhaustedValidation } from './reconcile-provider-acceptance-unknown-for-retry.ts';

/** A typed result/decision/question travelling upward may wake an idle ancestor even
 * while the sender remains active. This predicate authenticates the durable
 * receipt and exact current delegation; prose inside the message is never
 * parsed as authority. */
function sessionOpActionableUpwardAgentDeliverySenderId(sessionOperationContext: SessionOperationContext, managed: ManagedSession, item: ManagedSession['messageQueue'][number], ownedDispatchToken?: symbol): string | undefined {
    if (sessionOperationContext.state.shuttingDown || managed.stopRequested || managed.isProcessing
        || managed.activeObjective?.terminalState !== 'active'
        || sessionOpHasPendingDecision(sessionOperationContext, managed) || sessionOperationContext.owner["hasPendingUserInput"](managed)
        || sessionOpHasQueuedUserInput(sessionOperationContext, managed))
        return undefined;
    const messageType = item.options?.internalOrigin?.agentMessageType;
    if (messageType !== 'result' && messageType !== 'decision' && messageType !== 'question') {
        return undefined;
    }
    const sender = sessionOpAuthenticatedTypedAgentDeliverySender(sessionOperationContext, managed, item, ownedDispatchToken);
    return sender && sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, sender) ? sender.id : undefined;
}

/** A receipt from a structural descendant must not fall back to ordinary
 * inter-session admission after that descendant's objective binding becomes
 * stale. Unrelated topologies remain valid relays. */
function sessionOpIsStaleTypedUpwardAgentDelivery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, item: ManagedSession['messageQueue'][number], ownedDispatchToken?: symbol): boolean {
    const messageType = item.options?.internalOrigin?.agentMessageType;
    if (messageType !== 'progress' && messageType !== 'result'
        && messageType !== 'decision' && messageType !== 'question') {
        return false;
    }
    const sender = sessionOpAuthenticatedTypedAgentDeliverySender(sessionOperationContext, managed, item, ownedDispatchToken);
    return !sender || isSessionDescendant(sender.id, managed.id, id => sessionOperationContext.state.sessions.get(id))
        && !sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, sender);
}

/** Fresh host-authenticated deliveries have no receipt yet. Reject the same
 * impossible stale descendant edge before it can be persisted or reach the
 * provider; unrelated relays still use ordinary admission. */
function sessionOpIsFreshStaleTypedUpwardAgentDelivery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, options: SendMessageOptions | undefined, existingMessageId: string | undefined): boolean {
    const origin = options?.internalOrigin;
    const messageType = origin?.agentMessageType;
    if (existingMessageId || origin?.kind !== 'agent-message'
        || (messageType !== 'progress' && messageType !== 'result'
            && messageType !== 'decision' && messageType !== 'question')
        || !origin.senderSessionId || !origin.deliveryId)
        return false;
    const sender = sessionOperationContext.state.sessions.get(origin.senderSessionId);
    return !!sender && sender.workspace.id === managed.workspace.id
        && isSessionDescendant(sender.id, managed.id, id => sessionOperationContext.state.sessions.get(id))
        && !sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, sender);
}

/** Permanently reject an authenticated actionable receipt whose structural
 * descendant edge no longer belongs to the recipient's active objective.
 * Keeping that impossible receipt queued would poison the machine FIFO on
 * every restart. The transcript row is retained as failed evidence and the
 * next row drains only after the quarantine is durable. */
async function sessionOpQuarantineStaleTypedUpwardAgentDelivery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, item: ManagedSession['messageQueue'][number], ownedDispatchToken?: symbol, queueIndex?: number): Promise<void> {
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed
        || !sessionOpIsStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, item, ownedDispatchToken))
        return;
    const receipt = item.messageId
        ? managed.messages.find(message => message.id === item.messageId)
        : undefined;
    if (!receipt?.agentDelivery || receipt.agentDelivery.status !== 'queued'
        || receipt.isQueued !== true)
        return;
    const existingIndex = managed.messageQueue.indexOf(item);
    const removedIndex = existingIndex >= 0
        ? existingIndex
        : Math.min(queueIndex ?? 0, managed.messageQueue.length);
    if (existingIndex >= 0)
        managed.messageQueue.splice(existingIndex, 1);
    const previousAttempts = receipt.agentDelivery.attempts;
    receipt.isQueued = false;
    receipt.agentDelivery.status = 'failed';
    receipt.agentDelivery.attempts = Math.max(1, previousAttempts);
    const quarantineToken = ownedDispatchToken ?? Symbol('stale-agent-delivery-quarantine');
    if (!ownedDispatchToken)
        sessionOperationContext.state.queuedMessageDispatches.set(managed.id, quarantineToken);
    sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext, item.messageId, ownedDispatchToken);
    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    sessionOperationContext.owner["persistSession"](managed);
    try {
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        if (sessionOperationContext.state.sessions.get(managed.id) === managed
            && sessionOperationContext.state.queuedMessageDispatches.get(managed.id) === quarantineToken
            && receipt.agentDelivery.status === 'failed' && receipt.isQueued === false) {
            receipt.isQueued = true;
            receipt.agentDelivery.status = 'queued';
            receipt.agentDelivery.attempts = previousAttempts;
            if (!managed.messageQueue.some(candidate => candidate.messageId === item.messageId)) {
                managed.messageQueue.splice(removedIndex, 0, item);
            }
            sessionOperationContext.owner["persistSession"](managed);
        }
        sessionLog.warn('Failed to persist stale typed agent delivery quarantine', {
            sessionId: managed.id,
            messageId: item.messageId,
            error: error instanceof Error ? error.message : String(error),
        });
        const retry = setTimeout(() => {
            if (!sessionOperationContext.state.shuttingDown && sessionOperationContext.state.sessions.get(managed.id) === managed
                && !managed.stopRequested && !managed.isProcessing) {
                sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
            }
        }, 250);
        retry.unref?.();
        return;
    }
    finally {
        if (sessionOperationContext.state.queuedMessageDispatches.get(managed.id) === quarantineToken) {
            sessionOperationContext.state.queuedMessageDispatches.delete(managed.id);
        }
    }
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed)
        return;
    sessionOperationContext.owner["sendEvent"]({
        type: 'info', sessionId: managed.id, level: 'warning', timestamp: sessionOpMonotonic(sessionOperationContext),
        message: 'A stale delegated agent handoff was preserved as failed and removed from the active queue; subsequent work will continue.',
    }, managed.workspace.id);
    if (!sessionOperationContext.state.shuttingDown && !managed.stopRequested && !managed.isProcessing
        && managed.messageQueue.length > 0)
        sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
}

/** Preserve FIFO without letting a one-way progress receipt strand a later
 * actionable handoff from the same exact descendant branch. We release the
 * head progress only when every intervening row is another authenticated
 * progress on the eventual result/question/decision sender path. Human,
 * unrelated, stale and opaque rows remain strict barriers. */
function sessionOpReleasableUpwardAgentDeliverySenderId(sessionOperationContext: SessionOperationContext, managed: ManagedSession, item: ManagedSession['messageQueue'][number], ownedDispatchToken?: symbol): string | undefined {
    const direct = sessionOpActionableUpwardAgentDeliverySenderId(sessionOperationContext, managed, item, ownedDispatchToken);
    if (direct)
        return direct;
    if (item.options?.internalOrigin?.agentMessageType !== 'progress')
        return undefined;
    const headSender = sessionOpAuthenticatedTypedAgentDeliverySender(sessionOperationContext, managed, item, ownedDispatchToken);
    if (!headSender || !sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, headSender))
        return undefined;
    let remaining: ManagedSession['messageQueue'];
    if (ownedDispatchToken) {
        remaining = managed.messageQueue;
    }
    else {
        const itemIndex = managed.messageQueue.indexOf(item);
        if (itemIndex < 0)
            return undefined;
        remaining = managed.messageQueue.slice(itemIndex + 1);
    }
    const precedingProgressSenderIds = [headSender.id];
    for (const candidate of remaining) {
        const candidateActionableSenderId = sessionOpActionableUpwardAgentDeliverySenderId(sessionOperationContext, managed, candidate);
        if (candidateActionableSenderId) {
            const candidateSender = sessionOperationContext.state.sessions.get(candidateActionableSenderId);
            const releasedPath = candidateSender
                ? sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, candidateSender)
                : undefined;
            return releasedPath && precedingProgressSenderIds.every(id => releasedPath.has(id))
                ? candidateActionableSenderId
                : undefined;
        }
        if (candidate.options?.internalOrigin?.agentMessageType !== 'progress')
            return undefined;
        const progressSender = sessionOpAuthenticatedTypedAgentDeliverySender(sessionOperationContext, managed, candidate);
        if (!progressSender || !sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, progressSender))
            return undefined;
        precedingProgressSenderIds.push(progressSender.id);
    }
    return undefined;
}

/** `processing` is deliberately not consumption proof. A crash can happen
 * after queue claim but before the provider has incorporated the result. */
function sessionOpHasConsumedDelegatedTerminalResult(sessionOperationContext: SessionOperationContext, ancestor: ManagedSession, child: ManagedSession): boolean {
    const recipient = child.parentSessionId ? sessionOperationContext.state.sessions.get(child.parentSessionId) : undefined;
    if (!recipient || recipient.workspace.id !== ancestor.workspace.id
        || (recipient.id !== ancestor.id && !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, ancestor, recipient)))
        return false;
    return sessionOpDelegatedTerminalResultReceipt(sessionOperationContext, recipient, child)?.agentDelivery?.status === 'processed';
}

function sessionOpHasDurableDelegatedTerminalResultDelivery(sessionOperationContext: SessionOperationContext, ancestor: ManagedSession, child: ManagedSession): boolean {
    const recipient = child.parentSessionId ? sessionOperationContext.state.sessions.get(child.parentSessionId) : undefined;
    if (!recipient || recipient.workspace.id !== ancestor.workspace.id
        || (recipient.id !== ancestor.id && !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, ancestor, recipient)))
        return false;
    const receipt = sessionOpDelegatedTerminalResultReceipt(sessionOperationContext, recipient, child);
    return receipt?.agentDelivery?.status === 'queued' && receipt.isQueued === true
        || receipt?.agentDelivery?.status === 'processing'
        || receipt?.agentDelivery?.status === 'processed';
}

/** `wait_sessions` can deliver the same terminal child payload that is also
 * retained in the parent's machine inbox. Once the exact wait tool result is
 * part of the durable parent transcript, consume that inbox receipt in the
 * same fsync transaction instead of forcing a redundant provider turn. */
function sessionOpConsumeDelegatedTerminalReceiptsFromWaitResult(sessionOperationContext: SessionOperationContext, parent: ManagedSession, waitTool: Message | undefined, resultText: string): boolean {
    if (waitTool?.toolName !== 'mcp__session__wait_sessions'
        || waitTool.toolStatus === 'error'
        || waitTool.toolExecuted === false)
        return false;
    const requestedIds = waitTool.toolInput?.sessionIds;
    if (!Array.isArray(requestedIds) || !requestedIds.every(id => typeof id === 'string'))
        return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(resultText);
    }
    catch {
        return false;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as {
        sessions?: unknown;
    }).sessions))
        return false;
    const allowed = new Set(requestedIds);
    let changed = false;
    for (const item of (parsed as {
        sessions: unknown[];
    }).sessions) {
        if (!item || typeof item !== 'object')
            continue;
        const value = item as Record<string, unknown>;
        if (typeof value.sessionId !== 'string' || !allowed.has(value.sessionId)
            || typeof value.finalMessageId !== 'string' || typeof value.finalText !== 'string')
            continue;
        const child = sessionOperationContext.state.sessions.get(value.sessionId);
        if (!child || child.parentSessionId !== parent.id
            || child.workspace.id !== parent.workspace.id
            || !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, parent, child)
            || !sessionOpHasTerminalObjectiveState(sessionOperationContext, child))
            continue;
        const final = child.messages.findLast(message => (message.id === value.finalMessageId && message.role === 'assistant' && !message.isIntermediate));
        if (!final || final.content.slice(0, 32000) !== value.finalText)
            continue;
        const receipt = sessionOpDelegatedTerminalResultReceipt(sessionOperationContext, parent, child);
        if (!receipt?.agentDelivery
            || (receipt.agentDelivery.status !== 'queued' && receipt.agentDelivery.status !== 'processing'))
            continue;
        receipt.agentDelivery.status = 'processed';
        receipt.isQueued = false;
        parent.messageQueue = parent.messageQueue.filter(queued => queued.messageId !== receipt.id);
        sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
        changed = true;
    }
    return changed;
}

/** Return only live descendants from the exact current delegated lineage. A
 * historical idle child must not keep a newer objective open, but runtime
 * activity wins over an old finishedAt marker when a child was relaunched. */
function sessionOpActiveRelevantDelegatedDescendants(sessionOperationContext: SessionOperationContext, managed: ManagedSession, allowExactTerminalReceiptInCurrentTurn = false): ManagedSession[] {
    return [...sessionOperationContext.state.sessions.values()].filter(candidate => {
        const objectiveState = candidate.activeObjective?.terminalState;
        if (candidate.stopRequested || !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, managed, candidate))
            return false;
        const terminalResultPendingConsumption = (!!objectiveState && objectiveState !== 'active')
            || !!candidate.delegation?.finishedAt;
        if (terminalResultPendingConsumption) {
            if (allowExactTerminalReceiptInCurrentTurn && managed.isProcessing) {
                const receipt = sessionOpDelegatedTerminalResultReceipt(sessionOperationContext, managed, candidate);
                const origin = managed.lastSentOptions?.internalOrigin;
                const matchingReceipts = receipt?.agentDelivery
                    ? managed.messages.filter(message => message.agentDelivery?.id === receipt.agentDelivery!.id)
                    : [];
                const exactCurrentDelivery = !!receipt?.agentDelivery
                    && matchingReceipts.length === 1 && matchingReceipts[0] === receipt
                    && receipt.agentDelivery.status === 'processing'
                    && receipt.isQueued !== true
                    && origin?.kind === 'agent-message'
                    && origin.senderSessionId === candidate.id
                    && origin.deliveryId === receipt.agentDelivery.id
                    && managed.lastSentMessage === receipt.content;
                // Only the exact host-owned terminal receipt currently bound to the
                // provider turn may cross this gate. Its final validation determines
                // whether onProcessingStopped marks it processed or failed; an
                // arbitrary processing receipt remains a blocking descendant.
                if (exactCurrentDelivery)
                    return false;
            }
            return !sessionOpHasConsumedDelegatedTerminalResult(sessionOperationContext, managed, candidate);
        }
        const runtimeActive = candidate.isProcessing || sessionOperationContext.state.queuedMessageDispatches.has(candidate.id)
            || sessionOperationContext.state.automaticAdmissionReservations.has(candidate.id);
        if (runtimeActive)
            return true;
        // Authentication/approval is a durable child wait, not an idle child. It
        // must keep every ancestor objective open until the exact handoff is
        // resolved and its continuation/result has been consumed.
        if (sessionOpHasPendingDecision(sessionOperationContext, candidate) || sessionOperationContext.owner["hasPendingUserInput"](candidate)
            || sessionOpHasQueuedUserInput(sessionOperationContext, candidate))
            return true;
        const durableRecoveryActive = candidate.messageQueue.length > 0
            || (!!candidate.pendingTurnRecovery && !sessionOpHasExhaustedValidation(sessionOperationContext, candidate)
                && !sessionOperationContext.owner["hasPendingUserInput"](candidate) && !sessionOpHasPendingDecision(sessionOperationContext, candidate));
        if (durableRecoveryActive)
            return true;
        // A persisted child with no objective, inbox row, recovery, or live
        // reservation may be the residue of a crash between child creation and
        // its first dispatch. There is nothing the scheduler can resume, so it
        // must not hold the parent open forever. The live creation window is
        // already covered by automaticAdmissionReservations above.
        return false;
    });
}

function sessionOpQueuedRelevantDelegatedDeliverySenderIds(sessionOperationContext: SessionOperationContext, managed: ManagedSession): string[] {
    const senderIds = new Set<string>();
    for (const item of managed.messageQueue) {
        const origin = item.options?.internalOrigin;
        if (origin?.kind !== 'agent-message' || !origin.deliveryId || !origin.senderSessionId)
            continue;
        const sender = sessionOperationContext.state.sessions.get(origin.senderSessionId);
        if (sender && sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, managed, sender))
            senderIds.add(sender.id);
    }
    return [...senderIds];
}

function sessionOpPlaceCurrentRecoveryAfterDelegatedDeliveries(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    if (!sessionOpQueuedRelevantDelegatedDeliverySenderIds(sessionOperationContext, managed).length)
        return;
    const pendingUserMessageId = managed.pendingTurnRecovery?.userMessageId;
    const recoveries = managed.messageQueue.filter(item => {
        const recovery = item.options?.automaticRecovery;
        return !!recovery && recovery.cause !== 'user_retry'
            && !recovery.cleanContinuationId
            && recovery.originalUserMessageId === pendingUserMessageId;
    });
    if (!recoveries.length)
        return;
    const recoverySet = new Set(recoveries);
    managed.messageQueue = [
        ...managed.messageQueue.filter(item => !recoverySet.has(item)),
        ...recoveries,
    ];
}

export { sessionOpActionableUpwardAgentDeliverySenderId as actionableUpwardAgentDeliverySenderId };
export { sessionOpIsStaleTypedUpwardAgentDelivery as isStaleTypedUpwardAgentDelivery };
export { sessionOpIsFreshStaleTypedUpwardAgentDelivery as isFreshStaleTypedUpwardAgentDelivery };
export { sessionOpQuarantineStaleTypedUpwardAgentDelivery as quarantineStaleTypedUpwardAgentDelivery };
export { sessionOpReleasableUpwardAgentDeliverySenderId as releasableUpwardAgentDeliverySenderId };
export { sessionOpHasConsumedDelegatedTerminalResult as hasConsumedDelegatedTerminalResult };
export { sessionOpHasDurableDelegatedTerminalResultDelivery as hasDurableDelegatedTerminalResultDelivery };
export { sessionOpConsumeDelegatedTerminalReceiptsFromWaitResult as consumeDelegatedTerminalReceiptsFromWaitResult };
export { sessionOpActiveRelevantDelegatedDescendants as activeRelevantDelegatedDescendants };
export { sessionOpQueuedRelevantDelegatedDeliverySenderIds as queuedRelevantDelegatedDeliverySenderIds };
export { sessionOpPlaceCurrentRecoveryAfterDelegatedDeliveries as placeCurrentRecoveryAfterDelegatedDeliveries };
