import type { SessionOperationContext } from '../operation-context.ts';
import { nextRecoveryDispatch, validAllocatedRecoveryDispatch, enqueueRecoveredMessageInTranscriptOrder } from '../policy.ts';
import { acknowledgeDurableDelivery } from '../../agent-delivery.ts';
import { randomUUID } from 'node:crypto';
import { normalizeUserInputQuestions } from '@craft-agent/core';
import type { UserInputRequest, UserInputQuestion, UserInputResponseResult } from '@craft-agent/core';
import type { Message } from '@craft-agent/core/types';
import { YOLO_AUTONOMY_GUIDANCE } from '@craft-agent/shared/agent';
import { createPendingTurnRecovery } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { CONTEXT_LIMIT_NEXT_STEP_QUESTIONS, canonicalUserInputAnswerContents } from '../user-input-authority.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo } from './is-managed-session-yolo.ts';
import { isCurrentDelegatedDescendant as sessionOpIsCurrentDelegatedDescendant } from './is-current-delegated-descendant.ts';
import { delegatedTerminalResultReceipt as sessionOpDelegatedTerminalResultReceipt, clearDelegatedTerminalResultRetry as sessionOpClearDelegatedTerminalResultRetry, ensureDelegatedTerminalResultDelivery as sessionOpEnsureDelegatedTerminalResultDelivery, scheduleDelegatedTerminalResultRetry as sessionOpScheduleDelegatedTerminalResultRetry } from './ensure-delegated-terminal-result-delivery.ts';

/** Only origin sessions persist requests. Ancestors expose a detached read projection. */
function sessionOpGetUserInputRequests(sessionOperationContext: SessionOperationContext, managed: ManagedSession, candidates: Iterable<ManagedSession> = sessionOperationContext.state.sessions.values()): UserInputRequest[] {
    const requests: UserInputRequest[] = [];
    for (const candidate of candidates) {
        if (!candidate.userInputRequests?.length || candidate.workspace.id !== managed.workspace.id)
            continue;
        let cursor: ManagedSession | undefined = candidate;
        const visited = new Set<string>();
        while (cursor && !visited.has(cursor.id) && cursor.workspace.id === managed.workspace.id) {
            if (cursor.id === managed.id) {
                requests.push(...(candidate.userInputRequests ?? []));
                break;
            }
            visited.add(cursor.id);
            cursor = cursor.parentSessionId ? sessionOperationContext.state.sessions?.get(cursor.parentSessionId) : undefined;
        }
    }
    return JSON.parse(JSON.stringify(requests.sort((a, b) => a.createdAt - b.createdAt)));
}

function sessionOpHasPendingUserInput(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return sessionOpGetUserInputRequests(sessionOperationContext, managed).some(request => request.status === 'pending');
}

function sessionOpHasQueuedUserInput(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return managed.messages.some(message => message.isQueued && message.internalOrigin?.kind === 'user-input'
        && managed.userInputRequests?.some(request => request.status === 'answered' && request.responseMessageId === message.id));
}

/** A structured answer is persisted before its first send attempt. If that
 * attempt races a cold provider reconciliation, admission deliberately
 * rejects it while the non-replay snapshot is being fsynced. Rebuild only
 * the exact host-authenticated answer row once that fence settles so the
 * durable answer cannot remain orphaned until another restart. */
function sessionOpEnqueueUnscheduledQueuedUserInputAnswers(sessionOperationContext: SessionOperationContext, managed: ManagedSession): number {
    if (sessionOperationContext.state.queuedMessageDispatches.has(managed.id))
        return 0;
    let queued = 0;
    for (const request of managed.userInputRequests ?? []) {
        if (request.status !== 'answered' || !request.responseMessageId || !request.answers?.length
            || request.sessionId !== managed.id || request.originWorkspaceId !== managed.workspace.id
            || request.objectiveUserMessageId !== managed.activeObjective?.userMessageId)
            continue;
        const rows = managed.messages.filter(message => message.id === request.responseMessageId);
        const row = rows[0];
        if (rows.length !== 1 || !row || row.role !== 'user' || row.hidden !== true
            || row.isQueued !== true || row.isPending || row.agentDelivery
            || row.internalOrigin?.kind !== 'user-input'
            || !canonicalUserInputAnswerContents(request).includes(row.content)
            || managed.messageQueue.some(item => item.messageId === row.id))
            continue;
        enqueueRecoveredMessageInTranscriptOrder(managed, {
            message: row.content,
            messageId: row.id,
            storedAttachments: row.attachments,
            options: { hidden: true, internalOrigin: { kind: 'user-input' } },
        });
        queued++;
    }
    return queued;
}

function sessionOpEmitUserInputChanged(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    for (const wake of sessionOperationContext.state.sessionWaitListeners)
        wake(managed.id);
    sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
    let cursor: ManagedSession | undefined = managed;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor.id) && cursor.workspace.id === managed.workspace.id) {
        sessionOperationContext.owner["sendEvent"]({ type: 'user_input_changed', sessionId: cursor.id, requests: sessionOpGetUserInputRequests(sessionOperationContext, cursor) }, cursor.workspace.id);
        visited.add(cursor.id);
        cursor = cursor.parentSessionId ? sessionOperationContext.state.sessions.get(cursor.parentSessionId) : undefined;
    }
}

/** Exact host-owned boundary at which a hard-limit question may be created.
 * A restart persists the recovery allocation before rebuilding its transient
 * queue row, so both the durable allocated state and the flushed started
 * state are valid pre-provider admission boundaries. */
function sessionOpContextLimitHostAdmissionBoundary(sessionOperationContext: SessionOperationContext, managed: ManagedSession): {
    dispatchId: string;
    boundaryAt: number;
} | undefined {
    const pending = managed.pendingTurnRecovery;
    if (!pending || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return undefined;
    const dispatch = pending?.recoveryDispatch;
    if (dispatch?.phase === 'started' && Number.isFinite(dispatch.startedAt)) {
        return { dispatchId: dispatch.id, boundaryAt: dispatch.startedAt! };
    }
    if (pending && dispatch?.phase === 'allocated'
        && validAllocatedRecoveryDispatch(pending) === dispatch) {
        return { dispatchId: dispatch.id, boundaryAt: dispatch.allocatedAt };
    }
    return undefined;
}

function sessionOpCancelPendingUserInput(sessionOperationContext: SessionOperationContext, managed: ManagedSession, includeDescendants = false, preserveValidationStop = false): Promise<void> {
    const changedOrigins: ManagedSession[] = [];
    const origins = includeDescendants
        ? new Set(sessionOpGetUserInputRequests(sessionOperationContext, managed).map(request => request.sessionId))
        : new Set([managed.id]);
    for (const id of origins) {
        const origin = sessionOperationContext.state.sessions.get(id);
        if (!origin || origin.workspace.id !== managed.workspace.id)
            continue;
        let changed = false;
        for (const request of origin.userInputRequests ?? []) {
            const queuedAnswer = request.responseMessageId
                ? origin.messages.find(message => message.id === request.responseMessageId && message.isQueued) : undefined;
            if (request.status !== 'pending' && !(request.status === 'answered' && queuedAnswer))
                continue;
            if (queuedAnswer) {
                queuedAnswer.isQueued = false;
                origin.messageQueue = origin.messageQueue.filter(item => item.messageId !== queuedAnswer.id);
            }
            request.status = 'cancelled';
            request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
            changed = true;
        }
        if (changed) {
            sessionOperationContext.owner["clearPendingTurnRecovery"](origin, preserveValidationStop);
            sessionOperationContext.owner["persistSession"](origin);
            changedOrigins.push(origin);
        }
    }
    return Promise.all(changedOrigins.map(async (origin) => {
        await sessionOperationContext.owner.flushSession(origin.id);
        sessionOpEmitUserInputChanged(sessionOperationContext, origin);
    })).then(() => { });
}

async function sessionOpRequestUserInput(sessionOperationContext: SessionOperationContext, sessionId: string, value: UserInputQuestion[], hostCapability?: symbol, expectedHostRecoveryDispatchId?: string): Promise<{
    requestId: string;
    status: 'pending';
}> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        throw new Error('Question session not found');
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformRequestUserInput(sessionOperationContext, managed, value, hostCapability, expectedHostRecoveryDispatchId));
}

async function sessionOpPerformRequestUserInput(sessionOperationContext: SessionOperationContext, managed: ManagedSession, value: UserInputQuestion[], hostCapability?: symbol, expectedHostRecoveryDispatchId?: string): Promise<{
    requestId: string;
    status: 'pending';
}> {
    if (sessionOpIsManagedSessionYolo(sessionOperationContext, managed)) {
        throw new Error(`YOLO_HUMAN_HANDOFF_DISABLED: No question was created. ${YOLO_AUTONOMY_GUIDANCE}`);
    }
    const questions = normalizeUserInputQuestions(value);
    if (managed.stopRequested)
        throw new Error('The session is stopping');
    const objective = managed.activeObjective;
    if (objective && objective.terminalState !== 'active')
        throw new Error('The objective is no longer active');
    const pending = managed.userInputRequests?.find(request => request.status === 'pending');
    if (pending) {
        if (pending.objectiveUserMessageId !== objective?.userMessageId || JSON.stringify(pending.questions) !== JSON.stringify(questions)) {
            throw new Error('Answer or cancel the pending questions before creating another request');
        }
        if (hostCapability !== undefined) {
            const boundary = sessionOpContextLimitHostAdmissionBoundary(sessionOperationContext, managed);
            const objectiveId = objective?.objectiveId ?? objective?.userMessageId;
            if (hostCapability !== sessionOperationContext.state.contextLimitUserInputCapability
                || expectedHostRecoveryDispatchId !== boundary?.dispatchId
                || pending.hostPrompt?.schemaVersion !== 1
                || pending.hostPrompt.kind !== 'context-limit-next-step'
                || pending.hostPrompt.objectiveId !== objectiveId
                || pending.hostPrompt.recoveryDispatchId !== boundary?.dispatchId
                || !boundary
                || pending.hostPrompt.issuedAt < boundary.boundaryAt
                || pending.hostPrompt.issuedAt > pending.createdAt) {
                throw new Error('A context-limit prompt cannot adopt an existing question');
            }
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        sessionOpEmitUserInputChanged(sessionOperationContext, managed);
        return { requestId: pending.id, status: 'pending' };
    }
    const hostPrompt = (() => {
        if (hostCapability === undefined)
            return undefined;
        let boundary = sessionOpContextLimitHostAdmissionBoundary(sessionOperationContext, managed);
        if (!boundary && hostCapability === sessionOperationContext.state.contextLimitUserInputCapability && objective?.terminalState === 'active') {
            const basePending = managed.pendingTurnRecovery ?? createPendingTurnRecovery(objective.userMessageId);
            const allocated = nextRecoveryDispatch(basePending, 'user_retry', 'retry', Date.now());
            allocated.phase = 'allocated';
            managed.pendingTurnRecovery = { ...basePending, recoveryDispatch: allocated };
            boundary = sessionOpContextLimitHostAdmissionBoundary(sessionOperationContext, managed);
        }
        if (hostCapability !== sessionOperationContext.state.contextLimitUserInputCapability
            || (expectedHostRecoveryDispatchId && expectedHostRecoveryDispatchId !== boundary?.dispatchId)
            || JSON.stringify(questions) !== JSON.stringify(CONTEXT_LIMIT_NEXT_STEP_QUESTIONS)
            || !objective || objective.terminalState !== 'active'
            || !boundary) {
            throw new Error('The context-limit question has no exact host admission boundary');
        }
        return {
            schemaVersion: 1 as const,
            kind: 'context-limit-next-step' as const,
            objectiveId: objective.objectiveId ?? objective.userMessageId,
            recoveryDispatchId: boundary.dispatchId,
            issuedAt: Date.now(),
        };
    })();
    const request: UserInputRequest = {
        id: `input-${randomUUID()}`, sessionId: managed.id, originWorkspaceId: managed.workspace.id,
        questions, status: 'pending', createdAt: Date.now(), objectiveUserMessageId: objective?.userMessageId,
        ...(hostPrompt ? { hostPrompt } : {}),
    };
    managed.userInputRequests = [...(managed.userInputRequests ?? []), request];
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOpEmitUserInputChanged(sessionOperationContext, managed);
    return { requestId: request.id, status: 'pending' };
}

function sessionOpWakeQueuedQuestionAncestors(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
    sessionOpWakeDeferredDelegatedTerminalResultRetries(sessionOperationContext, managed);
    const visited = new Set<string>([managed.id]);
    let parentId = managed.parentSessionId;
    while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = sessionOperationContext.state.sessions.get(parentId);
        if (!parent || parent.workspace.id !== managed.workspace.id)
            break;
        sessionOpWakeDeferredDelegatedTerminalResultRetries(sessionOperationContext, parent);
        sessionOperationContext.owner["processNextQueuedMessage"](parent.id);
        parentId = parent.parentSessionId;
    }
}

/** A different question may temporarily own the parent's single prompt
 * slot while a terminal child receipt is exhausted. Once that question is
 * answered/cancelled, bypass accumulated timer backoff and reconcile the
 * exact failed receipt immediately. The deterministic delivery ID keeps this
 * kick idempotent and it never restarts child work. */
function sessionOpWakeDeferredDelegatedTerminalResultRetries(sessionOperationContext: SessionOperationContext, parent: ManagedSession): void {
    for (const child of sessionOperationContext.state.sessions.values()) {
        if (child.parentSessionId !== parent.id || child.workspace.id !== parent.workspace.id
            || !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, parent, child))
            continue;
        const receipt = sessionOpDelegatedTerminalResultReceipt(sessionOperationContext, parent, child);
        if (receipt?.agentDelivery?.status !== 'failed' || receipt.agentDelivery.attempts < 3)
            continue;
        sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, child.id);
        void sessionOpEnsureDelegatedTerminalResultDelivery(sessionOperationContext, child).then(delivered => {
            if (!delivered)
                sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
        }, error => {
            sessionLog.warn('Deferred delegated terminal result question reconciliation failed', {
                childSessionId: child.id,
                error: error instanceof Error ? error.message : String(error),
            });
            sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
        });
    }
}

/** Consume the exact queued answer in the same durable preparation boundary
 * as the resumed delivery. On storage failure restore the in-memory FIFO; the
 * existing delivery rollback then keeps both records retryable without spend. */
async function sessionOpConsumeQueuedCostLimitContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession, continuation: {
    request: UserInputRequest;
    message: Message;
    queueIndex: number;
}): Promise<void> {
    const queued = managed.messageQueue[continuation.queueIndex];
    if (!queued || queued.messageId !== continuation.message.id) {
        throw new Error('The authenticated cost-limit continuation is no longer queued');
    }
    managed.messageQueue.splice(continuation.queueIndex, 1);
    continuation.message.isQueued = false;
    try {
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('The cost-limit continuation could not be consumed durably');
        }
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        continuation.message.isQueued = true;
        if (!managed.messageQueue.some(item => item.messageId === continuation.message.id)) {
            managed.messageQueue.splice(Math.min(continuation.queueIndex, managed.messageQueue.length), 0, queued);
        }
        throw error;
    }
}

async function sessionOpDeliverUserInputAnswer(sessionOperationContext: SessionOperationContext, managed: ManagedSession, request: UserInputRequest, message: Message, rpcContext?: {
    callerClientId?: string;
}, recoveryPrompt?: string): Promise<UserInputResponseResult> {
    const existing = sessionOperationContext.state.userInputResponsesInFlight.get(request.id);
    if (existing)
        return existing;
    const operation = (async (): Promise<UserInputResponseResult> => {
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('The accepted user answer could not be queued for durable storage');
        }
        await sessionOperationContext.owner.flushSession(managed.id);
        sessionOpEmitUserInputChanged(sessionOperationContext, managed);
        sessionOpWakeQueuedQuestionAncestors(sessionOperationContext, managed);
        await acknowledgeDurableDelivery(ack => sessionOperationContext.owner.sendMessage(managed.id, recoveryPrompt ? `${message.content}\n\n${recoveryPrompt}` : message.content, undefined, undefined, { hidden: true, internalOrigin: { kind: 'user-input' } }, message.id, false, ack, rpcContext), error => sessionLog.error('Accepted user answer processing failed', { sessionId: managed.id, error }));
        return { status: 'accepted', responseMessageId: message.id, delivery: message.isQueued ? 'queued' : 'started' };
    })();
    sessionOperationContext.state.userInputResponsesInFlight.set(request.id, operation);
    try {
        return await operation;
    }
    finally {
        sessionOperationContext.state.userInputResponsesInFlight.delete(request.id);
    }
}

export { sessionOpGetUserInputRequests as getUserInputRequests };
export { sessionOpHasPendingUserInput as hasPendingUserInput };
export { sessionOpHasQueuedUserInput as hasQueuedUserInput };
export { sessionOpEnqueueUnscheduledQueuedUserInputAnswers as enqueueUnscheduledQueuedUserInputAnswers };
export { sessionOpEmitUserInputChanged as emitUserInputChanged };
export { sessionOpContextLimitHostAdmissionBoundary as contextLimitHostAdmissionBoundary };
export { sessionOpCancelPendingUserInput as cancelPendingUserInput };
export { sessionOpRequestUserInput as requestUserInput };
export { sessionOpPerformRequestUserInput as performRequestUserInput };
export { sessionOpWakeQueuedQuestionAncestors as wakeQueuedQuestionAncestors };
export { sessionOpWakeDeferredDelegatedTerminalResultRetries as wakeDeferredDelegatedTerminalResultRetries };
export { sessionOpConsumeQueuedCostLimitContinuation as consumeQueuedCostLimitContinuation };
export { sessionOpDeliverUserInputAnswer as deliverUserInputAnswer };
