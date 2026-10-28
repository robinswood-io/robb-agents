import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { boundObjectiveForCleanHandoff, queuedDirectHumanContinuationIndex, queuedDirectHumanContinuationIndexForId, validAllocatedRecoveryDispatch, hasAuthenticatedObjectiveRoot } from '../policy.ts';
import type { PendingTurnRecovery, ActiveSessionObjective } from '@craft-agent/shared/sessions';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';
import { createCleanRecoveryContinuationHandoff } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { isSourceActivationOriginCurrent } from '../source-activation.ts';
import { isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked, pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { contextLimitAuthenticatedAnswerEvidence as sessionOpContextLimitAuthenticatedAnswerEvidence } from './context-limit-authenticated-answer-evidence.ts';
import { getUserInputRequests as sessionOpGetUserInputRequests, hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';
import { canRetryRetainedMachineInbox as sessionOpCanRetryRetainedMachineInbox } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { untrackSyntheticAutomaticMessage as sessionOpUntrackSyntheticAutomaticMessage } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { drainDeferredAutomaticSessions as sessionOpDrainDeferredAutomaticSessions } from './drain-deferred-automatic-sessions.ts';

/** Rebuild a bounded fresh-context contract from durable host-owned state.
 * This is used before asking the user to repeat an objective that the host
 * still has. It never imports assistant prose or raw tool output and it does
 * not upgrade an unregistered acceptance draft to a passing criterion. */
function sessionOpCreateAutonomousContextLimitHandoff(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): ReturnType<typeof createCleanRecoveryContinuationHandoff> {
    const storedObjective = managed.activeObjective;
    const objective = storedObjective?.terminalState === 'blocked_human'
        && sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, pending.recoveryDispatch)
        ? omitUndefined<ActiveSessionObjective>({ ...storedObjective, terminalState: 'active', completedAt: undefined })
        : storedObjective;
    if (!objective || objective.terminalState !== 'active'
        || !hasAuthenticatedObjectiveRoot(managed, objective))
        return undefined;
    // Source activation or authenticated internal continuation (e.g., subagent
    // result, auth result, background/scheduled task) is a host-issued
    // continuation of the current visible revision. Its hidden row is never
    // itself an objective root, but an exact origin binding permits projection
    // back to the accepted visible request.
    const rootIndex = managed.messages.findIndex(message => message.id === objective.userMessageId);
    const activationIndex = managed.messages.findIndex(message => message.id === pending.userMessageId);
    const activationRows = managed.messages.filter(message => message.id === pending.userMessageId);
    const activation = activationRows.length === 1 ? activationRows[0] : undefined;
    const authenticatedActivation = !!activation && activation.role === 'user'
        && activation.hidden === true && !activation.isQueued && !activation.isPending
        && !activation.agentDelivery && !activation.providerDispatch
        && isSourceActivationOriginCurrent(objective, activation.internalOrigin);
    const authenticatedInternalTurn = !!activation && activation.role === 'user'
        && activation.hidden === true && !activation.isPending
        && rootIndex >= 0 && activationIndex >= rootIndex
        && (activation.internalOrigin?.kind === 'agent-message'
            || activation.internalOrigin?.kind === 'auth-result'
            || activation.internalOrigin?.kind === 'auth-retry'
            || activation.internalOrigin?.kind === 'browser-fallback'
            || activation.internalOrigin?.kind === 'automation');
    const projectedInternalOrigin = authenticatedActivation || authenticatedInternalTurn;
    if (!sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)
        && !projectedInternalOrigin)
        return undefined;
    const visibleSourceUserMessageId = objective.lastUserMessageId ?? objective.userMessageId;
    const sourceIsVisible = pending.userMessageId === objective.userMessageId
        || pending.userMessageId === visibleSourceUserMessageId;
    const authenticatedAnswers = sessionOpContextLimitAuthenticatedAnswerEvidence(sessionOperationContext, managed, objective, sourceIsVisible || projectedInternalOrigin ? undefined : pending.userMessageId, pending);
    if (!authenticatedAnswers)
        return undefined;
    if (!sourceIsVisible && !projectedInternalOrigin
        && !authenticatedAnswers.responseMessageIds.has(pending.userMessageId)) {
        return undefined;
    }
    const handoffPending = sourceIsVisible ? pending : {
        ...pending,
        userMessageId: visibleSourceUserMessageId,
    };
    const boundedWork = (value: unknown, prefix = ''): string | undefined => {
        if (typeof value !== 'string')
            return undefined;
        const normalized = value.trim();
        if (!normalized)
            return undefined;
        const combined = `${prefix}${normalized}`;
        return combined.length <= 1500 ? combined : `${combined.slice(0, 1497)}...`;
    };
    const work: string[] = [];
    for (const gap of pending.validationGaps ?? []) {
        const item = boundedWork(gap, 'Resolve host validation gap: ');
        if (item)
            work.push(item);
    }
    for (const item of pending.continuationWork ?? []) {
        const bounded = boundedWork(item);
        if (bounded)
            work.push(bounded);
    }
    if (objective.lastOutcome?.state === 'continue' && objective.lastOutcome.blocker == null) {
        for (const item of objective.lastOutcome.remainingWork) {
            const bounded = boundedWork(item);
            if (bounded)
                work.push(bounded);
        }
    }
    const acceptanceNeedsReview = objective.acceptanceNeedsReview === true;
    const acceptanceCriteria = (acceptanceNeedsReview ? [] : objective.acceptanceCriteria ?? []).slice(0, 16);
    if (acceptanceNeedsReview || (objective.requiresAcceptanceCriteria === true && !acceptanceCriteria.length)) {
        work.unshift('Re-register the current target-bound acceptance contract from the preserved objective and amendments before completing work or claiming success.');
    }
    for (const criterion of acceptanceCriteria) {
        const id = typeof criterion?.id === 'string' && criterion.id.trim().length <= 512
            ? criterion.id.trim() : undefined;
        const description = boundedWork(criterion?.description);
        if (!id || !description)
            return undefined;
        const criterionWork = boundedWork(description, `Reconcile registered acceptance criterion ${id}; complete it idempotently if unmet, then verify it: `);
        if (!criterionWork)
            return undefined;
        work.push(criterionWork);
    }
    if (!work.length) {
        for (const criterion of objective.completionCriteria) {
            const bounded = boundedWork(criterion);
            if (bounded)
                work.push(`Complete and verify host objective criterion: ${bounded}`);
        }
    }
    if (!work.length) {
        work.push('Continue the accepted objective, inspect its current target state, complete remaining work idempotently, and verify the result before finishing.');
    }
    const remainingWork = [...new Set(work)].slice(0, 16);
    const priorCriteria = !acceptanceNeedsReview && objective.lastOutcome?.state === 'continue'
        && objective.lastOutcome.blocker == null
        ? objective.lastOutcome.criteria
        : undefined;
    const outcomeCriteria = priorCriteria?.length
        ? priorCriteria
        : (acceptanceCriteria.length
            ? acceptanceCriteria.map(criterion => ({ id: criterion.id, satisfied: false, evidence: [] }))
            : objective.completionCriteria.map(id => ({ id, satisfied: false, evidence: [] })));
    const derivedObjective: ActiveSessionObjective = {
        ...objective,
        lastOutcome: {
            state: 'continue',
            blocker: null,
            criteria: outcomeCriteria,
            remainingWork,
        },
    };
    const bounded = boundObjectiveForCleanHandoff(managed, derivedObjective);
    return createCleanRecoveryContinuationHandoff({
        objective: bounded.objective,
        pending: handoffPending,
        objectiveText: bounded.objectiveText,
        evidence: authenticatedAnswers.evidence,
        remainingWork,
    });
}

function sessionOpAssertRetryTurnUnblocked(sessionOperationContext: SessionOperationContext, managed: ManagedSession, allowPermissionInbox = false, allowedPendingRequestId?: string, allowRetainedMachineInbox = false): void {
    const hasUnallowedPendingInput = sessionOpGetUserInputRequests(sessionOperationContext, managed).some(request => (request.status === 'pending' && request.id !== allowedPendingRequestId));
    if (hasUnallowedPendingInput || (!allowPermissionInbox && sessionOpHasQueuedUserInput(sessionOperationContext, managed))) {
        throw new Error('Answer or cancel the pending questions before retrying');
    }
    if (managed.pendingAuthRequestId || managed.pendingAuthRequest
        || [...sessionOperationContext.state.pendingPermissionRequests.values()].some(request => request.sessionId === managed.id)) {
        throw new Error('Resolve the pending authentication or approval before retrying');
    }
    if (!allowPermissionInbox && !allowRetainedMachineInbox
        && !sessionOpCanRetryRetainedMachineInbox(sessionOperationContext, managed) && (managed.messageQueue.length > 0 || sessionOperationContext.state.queuedMessageDispatches.has(managed.id)
        || managed.messages.some(message => message.isQueued))) {
        throw new Error('Wait for the queued messages before retrying');
    }
}

/** Retry the existing turn, acknowledging its durable marker before model work completes. */
async function sessionOpRetryTurn(sessionOperationContext: SessionOperationContext, sessionId: string, userMessageId: string, rpcContext?: {
    callerClientId?: string;
}): Promise<import('@craft-agent/shared/protocol').RetryTurnResult> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        throw new Error(`Session ${sessionId} not found`);
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOperationContext.owner["retryTurnInternal"](sessionId, userMessageId, rpcContext, true));
}

function sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    if (sessionOperationContext.state.shuttingDown || managed.stopRequested || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))
        return false;
    return queuedDirectHumanContinuationIndex(managed) >= 0;
}

function sessionOpGrantLiveDirectHumanContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession, messageId: string): boolean {
    if (queuedDirectHumanContinuationIndexForId(managed, messageId) < 0)
        return false;
    let ids = sessionOperationContext.state.liveDirectHumanContinuationIds.get(managed);
    if (!ids) {
        ids = new Set();
        sessionOperationContext.state.liveDirectHumanContinuationIds.set(managed, ids);
    }
    ids.add(messageId);
    return true;
}

function sessionOpLiveDirectHumanContinuationIndex(sessionOperationContext: SessionOperationContext, managed: ManagedSession): number {
    const ids = sessionOperationContext.state.liveDirectHumanContinuationIds.get(managed);
    if (!ids?.size)
        return -1;
    for (const id of [...ids]) {
        const index = managed.messageQueue.findIndex(item => item.messageId === id);
        if (index < 0 || queuedDirectHumanContinuationIndexForId(managed, id) < 0)
            ids.delete(id);
    }
    if (!ids.size) {
        sessionOperationContext.state.liveDirectHumanContinuationIds.delete(managed);
        return -1;
    }
    return managed.messageQueue.findIndex(item => !!item.messageId && ids.has(item.messageId)
        && queuedDirectHumanContinuationIndexForId(managed, item.messageId) >= 0);
}

function sessionOpConsumeLiveDirectHumanContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession, messageId: string): void {
    const ids = sessionOperationContext.state.liveDirectHumanContinuationIds.get(managed);
    ids?.delete(messageId);
    if (!ids?.size)
        sessionOperationContext.state.liveDirectHumanContinuationIds.delete(managed);
}

/** A committed synthetic continuation loses authority as soon as the
 * objective is terminal or a later, durably accepted human turn is waiting.
 * Remove only automatic recovery records: agent deliveries and the human
 * FIFO keep their relative order. */
function sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext: SessionOperationContext, managed: ManagedSession, dequeuedAutomaticRecovery?: NonNullable<SendMessageOptions['automaticRecovery']>): boolean {
    const terminalObjective = sessionOpHasTerminalObjectiveState(sessionOperationContext, managed);
    const acceptedHumanTurn = !terminalObjective && sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext, managed);
    const pending = managed.pendingTurnRecovery;
    const cleanRetrySupersededByHuman = (recovery: NonNullable<SendMessageOptions['automaticRecovery']>): boolean => acceptedHumanTurn && recovery.cause === 'user_retry'
        && !!recovery.dispatchId && recovery.dispatchId === pending?.recoveryDispatch?.id
        && !!pending.recoveryDispatch.cleanContinuationId;
    const recoveryIsStale = (recovery: NonNullable<SendMessageOptions['automaticRecovery']>): boolean => (recovery.cause !== 'user_retry'
        && (!pending
            || recovery.originalUserMessageId !== pending.userMessageId
            || (!!recovery.dispatchId && (recovery.dispatchId !== pending.recoveryDispatch?.id
                || recovery.cause !== pending.recoveryDispatch.cause))));
    const dequeuedRecoverySuperseded = !!dequeuedAutomaticRecovery
        && (cleanRetrySupersededByHuman(dequeuedAutomaticRecovery)
            || dequeuedAutomaticRecovery.cause !== 'user_retry'
                && (terminalObjective || acceptedHumanTurn || recoveryIsStale(dequeuedAutomaticRecovery)));
    const inFlightRecoverySuperseded = acceptedHumanTurn
        && !!sessionOperationContext.state.syntheticAutomaticMessagesInFlight.get(managed)?.size;
    const queuedCount = managed.messageQueue.length;
    // `user_retry` carries explicit human authority and is not a synthetic
    // fallback, even though it shares the durable dispatch envelope.
    const removedQueueItems: typeof managed.messageQueue = [];
    const retained = managed.messageQueue.filter(item => {
        const recovery = item.options?.automaticRecovery;
        if (!recovery)
            return true;
        if (recovery.cause === 'user_retry') {
            const keep = !cleanRetrySupersededByHuman(recovery);
            if (!keep)
                removedQueueItems.push(item);
            return keep;
        }
        const keep = !terminalObjective && !acceptedHumanTurn && !recoveryIsStale(recovery);
        if (!keep)
            removedQueueItems.push(item);
        return keep;
    });
    const removed = retained.length !== queuedCount;
    if (!removed && !dequeuedRecoverySuperseded && !inFlightRecoverySuperseded)
        return false;
    managed.messageQueue = retained;
    // A deferred pre-chat recovery can already have a durable hidden row. Its
    // host-bound queue provenance makes that exact row removable; unrelated
    // hidden messages and normal agent deliveries are never inferred from text.
    for (const item of removedQueueItems) {
        if (!item.messageId)
            continue;
        const saved = managed.messages.find(message => message.id === item.messageId);
        if (saved?.role !== 'user' || !saved.hidden || !saved.isQueued || saved.agentDelivery
            || saved.content !== item.message
            || (saved.internalOrigin && saved.internalOrigin.kind !== 'browser-fallback'))
            continue;
        sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext, managed, saved);
        managed.messages.splice(managed.messages.indexOf(saved), 1);
    }
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    if (terminalObjective) {
        sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
    }
    else if (acceptedHumanTurn && managed.pendingTurnRecovery) {
        // The queued human message may be a continuation of the same objective.
        // Keep its bounded counters, gaps and validated remaining work until the
        // normal objective transition classifies that message. Only the obsolete
        // synthetic dispatch capability is revoked here.
        managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
            ...managed.pendingTurnRecovery,
            recoveryDispatch: undefined,
        });
    }
    sessionLog.info('Cancelled superseded automatic turn recovery', {
        sessionId: managed.id,
        reason: terminalObjective ? 'objective_terminal'
            : acceptedHumanTurn ? 'accepted_human_turn' : 'stale_dispatch',
        removedQueuedRecoveries: queuedCount - retained.length,
        dequeuedAutomaticRecovery: !!dequeuedAutomaticRecovery,
    });
    return true;
}

/** A clean dispatch is spent once its unique host prompt and subsequent
 * provider output are durable. Queued child receipts may then cross that
 * boundary without impersonating the clean dispatch itself. */
function sessionOpHasConsumedCleanRecoveryDispatch(_sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const dispatch = managed.pendingTurnRecovery?.recoveryDispatch;
    if (dispatch?.phase !== 'started' || !dispatch.cleanContinuationId
        || !Number.isFinite(dispatch.startedAt))
        return false;
    const matches = managed.messages.flatMap((message, index) => (message.id === dispatch.id ? [{ message, index }] : []));
    if (matches.length !== 1)
        return false;
    const { message, index } = matches[0]!;
    if (message.role !== 'user' || message.hidden !== true
        || message.isQueued || message.isPending || message.agentDelivery
        || (message.attachments?.length ?? 0) > 0
        || message.timestamp < dispatch.startedAt!
        || !message.content.startsWith(`<host_clean_recovery_continuation id="${dispatch.cleanContinuationId}">\n`)
        || !message.content.endsWith('\n</host_clean_recovery_continuation>'))
        return false;
    return managed.messages.slice(index + 1).some(candidate => (candidate.timestamp >= message.timestamp
        && (candidate.role === 'assistant' || candidate.role === 'tool'
            || candidate.role === 'plan')));
}

/** A started automatic dispatch may be reclaimed only when its exact durable
 * prompt is the final transcript row and the host observed no later activity.
 * This covers a process restart after the prompt flush but before the provider
 * produced anything. Any assistant/tool/message row or autonomy event keeps
 * the dispatch spent, so a possibly executed mutation is never replayed. */
function sessionOpReclaimableUnobservedStartedRecoveryDispatch(_sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): {
    messageIndex: number;
    allocatedDispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']>;
} | undefined {
    const dispatch = pending.recoveryDispatch;
    if (dispatch?.schemaVersion !== 1 || dispatch.phase !== 'started'
        || dispatch.preToolExecutionReceiptVersion !== 1
        || dispatch.cleanContinuationId
        || dispatch.origin === 'retry' || dispatch.cause === 'user_retry'
        || pending.lastCause !== dispatch.cause
        || !Number.isFinite(dispatch.startedAt) || dispatch.startedAt! < dispatch.allocatedAt)
        return undefined;
    const allocatedDispatch = { ...dispatch, phase: 'allocated' as const };
    delete allocatedDispatch.startedAt;
    if (!validAllocatedRecoveryDispatch({ ...pending, recoveryDispatch: allocatedDispatch }))
        return undefined;
    const matches = managed.messages.flatMap((message, index) => (message.id === dispatch.id ? [{ message, index }] : []));
    if (matches.length !== 1)
        return undefined;
    const { message, index: messageIndex } = matches[0]!;
    const expectedPrefix = `<automatic_turn_recovery original_user_message_id="${pending.userMessageId}" attempt="${dispatch.attempt}">\n`;
    const expectedInternalOrigin = dispatch.fallbackIntent ? 'browser-fallback' : undefined;
    if (messageIndex !== managed.messages.length - 1
        || message.role !== 'user' || message.hidden !== true
        || message.isQueued || message.isPending || message.agentDelivery
        || message.providerDispatch
        || message.internalOrigin?.kind !== expectedInternalOrigin
        || !Number.isFinite(message.timestamp) || message.timestamp < dispatch.startedAt!
        || !message.content.startsWith(expectedPrefix)
        || !message.content.includes('\n</automatic_turn_recovery>')
        || (message.attachments?.length ?? 0) > 0)
        return undefined;
    if (managed.autonomyEvents?.some(event => event.timestamp >= dispatch.startedAt!))
        return undefined;
    return { messageIndex, allocatedDispatch };
}

async function sessionOpResumePendingTurnsAfterRestart(sessionOperationContext: SessionOperationContext, sessionIds: string[]): Promise<void> {
    if (sessionOperationContext.state.shuttingDown)
        return;
    for (const id of sessionIds)
        sessionOperationContext.state.deferredAutomaticSessions.add(id);
    await sessionOpDrainDeferredAutomaticSessions(sessionOperationContext);
}

export { sessionOpCreateAutonomousContextLimitHandoff as createAutonomousContextLimitHandoff };
export { sessionOpAssertRetryTurnUnblocked as assertRetryTurnUnblocked };
export { sessionOpRetryTurn as retryTurn };
export { sessionOpHasAcceptedHumanContinuationQueued as hasAcceptedHumanContinuationQueued };
export { sessionOpGrantLiveDirectHumanContinuation as grantLiveDirectHumanContinuation };
export { sessionOpLiveDirectHumanContinuationIndex as liveDirectHumanContinuationIndex };
export { sessionOpConsumeLiveDirectHumanContinuation as consumeLiveDirectHumanContinuation };
export { sessionOpCancelSupersededAutomaticRecoveries as cancelSupersededAutomaticRecoveries };
export { sessionOpHasConsumedCleanRecoveryDispatch as hasConsumedCleanRecoveryDispatch };
export { sessionOpReclaimableUnobservedStartedRecoveryDispatch as reclaimableUnobservedStartedRecoveryDispatch };
export { sessionOpResumePendingTurnsAfterRestart as resumePendingTurnsAfterRestart };
