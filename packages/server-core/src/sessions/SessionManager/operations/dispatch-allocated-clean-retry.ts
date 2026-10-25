import type { SessionOperationContext } from '../operation-context.ts';
import { getQueuedPendingUserInputResponse, assertRetryTurnAnchor, validAllocatedRecoveryDispatch, cleanSetupRetryDelayMs, isImmutableAutomaticRecoveryBlock } from '../policy.ts';
import { acknowledgeDurableDelivery } from '../../agent-delivery.ts';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import type { Message } from '@craft-agent/core/types';
import { inspectAutonomousLineage } from '../../autonomous-session-admission';
import { buildCleanRecoveryContinuationPrompt } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective, isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked } from './pending-recovery-belongs-to-current-objective.ts';
import { isCleanSetupPersistenceFenced as sessionOpIsCleanSetupPersistenceFenced, fenceCleanSetupPersistence as sessionOpFenceCleanSetupPersistence, requeueAllocatedRecoveryDispatch as sessionOpRequeueAllocatedRecoveryDispatch, coldAutomaticRecoveryLeaseExpired as sessionOpColdAutomaticRecoveryLeaseExpired } from './start-recovery-dispatch.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage, getPendingUserInputResponse as sessionOpGetPendingUserInputResponse } from './user-input-recovery.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, exactQueuedAgentDeliveryReceipt as sessionOpExactQueuedAgentDeliveryReceipt } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { currentDelegatedSenderPath as sessionOpCurrentDelegatedSenderPath } from './is-current-delegated-descendant.ts';
import { revokeStaleColdRecovery as sessionOpRevokeStaleColdRecovery } from './retry-turn-internal.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { retryableContextLimitRequest as sessionOpRetryableContextLimitRequest } from './retryable-context-limit-request.ts';
import { emitUserInputChanged as sessionOpEmitUserInputChanged } from './perform-request-user-input.ts';

/** Resume an already-allocated clean Retry with the same private authority
 * as the original Retry endpoint. A persisted SendMessageOptions object can
 * never mint this capability; only the exact host-owned dispatch and current
 * objective reconstructed here may receive it. */
function sessionOpDispatchAllocatedCleanRetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): boolean {
    const dispatch = validAllocatedRecoveryDispatch(pending);
    const objective = managed.activeObjective;
    if (!dispatch || dispatch.origin !== 'retry' || dispatch.cause !== 'user_retry'
        || !dispatch.cleanContinuationId || !objective || objective.terminalState !== 'active'
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)
        || sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, dispatch)
        || cleanSetupRetryDelayMs(dispatch) > 0
        || sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, dispatch)
        || sessionOperationContext.state.shuttingDown || managed.stopRequested || managed.isProcessing) {
        sessionLog.info('Refused recovered clean Retry before private dispatch', {
            sessionId: managed.id,
            dispatchValid: !!dispatch,
            objectiveState: objective?.terminalState,
            provenanceValid: sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending),
            setupBlocked: sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, dispatch),
            persistenceFenced: sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, dispatch),
            shuttingDown: sessionOperationContext.state.shuttingDown,
            stopRequested: managed.stopRequested,
            isProcessing: managed.isProcessing,
        });
        return false;
    }
    // This is deliberately a low-level provider seam. Every caller must first
    // own the scheduler reservation so a reconstructed Retry cannot bypass
    // immutable ancestry or the global/root concurrency limits.
    if (!sessionOperationContext.state.automaticAdmissionReservations.has(managed.id)) {
        sessionLog.info('Refused recovered clean Retry without scheduler reservation', { sessionId: managed.id });
        return false;
    }
    if (sessionOperationContext.state.retryTurnsInFlight.has(managed.id))
        return true;
    let anchor: Message;
    let prompt: string;
    try {
        anchor = assertRetryTurnAnchor(managed, objective.lastUserMessageId ?? objective.userMessageId);
        prompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, pending, dispatch);
    }
    catch (error) {
        sessionLog.error('Refused an unauthenticated persisted clean Retry', {
            sessionId: managed.id,
            dispatchId: dispatch.id,
            error: error instanceof Error ? error.message : String(error),
        });
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        return false;
    }
    // Older hosts could persist the transient clean row in the generic FIFO.
    // Remove only that exact reconstruction; every human row and agent result
    // keeps its identity and relative order behind the clean boundary.
    managed.messageQueue = managed.messageQueue.filter(item => !(item.options?.automaticRecovery?.dispatchId === dispatch.id
        && item.options.automaticRecovery.cause === 'user_retry'
        && item.options.automaticRecovery.cleanContinuationId === dispatch.cleanContinuationId
        && item.message === prompt));
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    const retryCancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
    const allowanceToken = Symbol('recovered-clean-retry-allowance');
    const allowRetainedMachineInbox = sessionOpHasOnlyMachineInbox(sessionOperationContext, managed);
    sessionOperationContext.state.explicitRetryAllowanceTokens.set(allowanceToken, {
        sessionId: managed.id,
        userMessageId: anchor.id,
        objectiveId: objective.objectiveId ?? objective.userMessageId,
        cancellationEpoch: retryCancellationEpoch,
        cleanBoundaryMessageId: dispatch.id,
        cleanContinuationId: dispatch.cleanContinuationId,
        grantNewAllowance: false,
        ...(allowRetainedMachineInbox ? { allowRetainedMachineInbox: true } : {}),
    });
    const operation = Promise.resolve().then(async (): Promise<import('@craft-agent/shared/protocol').RetryTurnResult> => {
        if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.pendingTurnRecovery !== pending
            || managed.activeObjective !== objective || managed.stopRequested
            || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== retryCancellationEpoch) {
            throw new Error('The recovered clean Retry was superseded before dispatch');
        }
        await acknowledgeDurableDelivery(ack => sessionOperationContext.owner.sendMessage(managed.id, prompt, undefined, undefined, { hidden: true, automaticRecovery: {
                originalUserMessageId: anchor.id,
                cause: 'user_retry',
                dispatchId: dispatch.id,
                dispatchAttempt: dispatch.attempt,
                dispatchOrigin: dispatch.origin,
                dispatchAllocatedAt: dispatch.allocatedAt,
                cleanContinuationId: dispatch.cleanContinuationId,
            } }, undefined, false, ack, undefined, undefined, undefined, retryCancellationEpoch, allowanceToken), error => sessionLog.error('Accepted recovered clean Retry failed', {
            sessionId: managed.id,
            dispatchId: dispatch.id,
            error: error instanceof Error ? error.message : String(error),
        }));
        return { status: 'started' };
    });
    // Reserve synchronously before the microtask enters sendMessage; its
    // admission gate requires this exact in-flight operation as well as the
    // one-use capability above.
    sessionOperationContext.state.retryTurnsInFlight.set(managed.id, operation);
    void operation.catch(async (error) => {
        sessionLog.error('Recovered clean Retry admission failed', {
            sessionId: managed.id,
            dispatchId: dispatch.id,
            error: error instanceof Error ? error.message : String(error),
        });
        if (sessionOperationContext.state.sessions.get(managed.id) === managed && managed.pendingTurnRecovery === pending
            && !managed.stopRequested && !managed.isProcessing) {
            // The acknowledged provider-setup path classifies itself inside
            // sendMessage. Rejection here is pre-ACK (usually durability or a
            // revoked capability), so it must never spend the provider setup cap.
            sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, dispatch.id);
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error', sessionId: managed.id,
                error: {
                    code: 'provider_error', title: 'Recovery was not persisted',
                    message: 'The clean recovery boundary could not be durably acknowledged. No provider setup attempt was spent; Retry after storage is available.',
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                },
            }, managed.workspace.id);
        }
    }).finally(() => {
        sessionOperationContext.state.explicitRetryAllowanceTokens.delete(allowanceToken);
        if (sessionOperationContext.state.retryTurnsInFlight.get(managed.id) === operation) {
            sessionOperationContext.state.retryTurnsInFlight.delete(managed.id);
        }
        if (!managed.isProcessing && !sessionOperationContext.state.queuedMessageDispatches.has(managed.id)) {
            sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        }
    });
    return true;
}

function sessionOpResumeAllocatedRecoveryDispatch(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): boolean {
    const dispatch = validAllocatedRecoveryDispatch(pending);
    if (!dispatch)
        return false;
    if (sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, dispatch)
        || sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, dispatch)) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        return true;
    }
    const setupRetryDelayMs = cleanSetupRetryDelayMs(dispatch);
    if (setupRetryDelayMs > 0) {
        sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](managed.id, setupRetryDelayMs);
        return true;
    }
    const releasableQueuedResultSenders = dispatch.cleanContinuationId
        ? managed.messageQueue.flatMap(item => {
            const messageType = item.options?.internalOrigin?.agentMessageType;
            if (messageType !== 'result')
                return [];
            const receipt = sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, item);
            const senderId = item.options?.internalOrigin?.senderSessionId;
            const sender = receipt && senderId ? sessionOperationContext.state.sessions.get(senderId) : undefined;
            return sender && sessionOpHasTerminalObjectiveState(sessionOperationContext, sender)
                && sessionOpCurrentDelegatedSenderPath(sessionOperationContext, managed, sender) ? [sender.id] : [];
        })
        : [];
    if (!sessionOperationContext.owner["claimAutomaticAdmission"](managed, releasableQueuedResultSenders))
        return false;
    if (dispatch.origin === 'retry' && dispatch.cause === 'user_retry'
        && dispatch.cleanContinuationId) {
        return sessionOpDispatchAllocatedCleanRetry(sessionOperationContext, managed, pending);
    }
    if (!sessionOpRequeueAllocatedRecoveryDispatch(sessionOperationContext, managed, pending))
        return false;
    if (!managed.isProcessing)
        sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
    return true;
}

/** Move an expired cold marker out of the automatic startup queue without
 * erasing transcript receipts or its exact retry budget. Only an explicit
 * Retry of the same authenticated objective can consume the snapshot. */
async function sessionOpQuarantineExpiredColdAutomaticRecovery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): Promise<boolean> {
    if (pending.lastCause === 'user_retry'
        || sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true)
        || getQueuedPendingUserInputResponse(managed)
        || !sessionOpColdAutomaticRecoveryLeaseExpired(sessionOperationContext, pending))
        return false;
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.pendingTurnRecovery !== pending)
        return true;
    const objective = managed.activeObjective;
    if (!objective || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)) {
        // An obsolete marker from another objective has no authority over the
        // current objective's lifecycle. Revoke only that stale marker; never
        // exhaust or overwrite the newer accepted work.
        await sessionOpRevokeStaleColdRecovery(sessionOperationContext, managed, pending, 'expired_objective_provenance_mismatch');
        return true;
    }
    objective.interruptedTurnRecovery = {
        objectiveId: objective.objectiveId ?? objective.userMessageId,
        userMessageId: objective.lastUserMessageId ?? objective.userMessageId,
        recovery: structuredClone(pending),
    };
    objective.terminalState = 'exhausted';
    objective.completedAt = Date.now();
    managed.pendingTurnRecovery = undefined;
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.activeObjective !== objective
        || managed.pendingTurnRecovery)
        return true;
    await sessionOperationContext.owner["reconcileRecoveredTerminalStatus"](managed, 'interrupted');
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.activeObjective !== objective
        || managed.pendingTurnRecovery)
        return true;
    sessionOperationContext.owner["emitObjectiveChanged"](managed);
    sessionOperationContext.owner["sendEvent"]({
        type: 'info', sessionId: managed.id, level: 'warning', timestamp: sessionOpMonotonic(sessionOperationContext),
        message: 'Automatic continuation was not restarted because its cold recovery lease had expired. Completed work, tool receipts and the exact continuation state were preserved; use Retry to resume explicitly.',
    }, managed.workspace.id);
    sessionLog.warn('Quarantined expired cold automatic recovery', {
        sessionId: managed.id,
        objectiveId: objective?.objectiveId ?? objective?.userMessageId,
        recoveryUserMessageId: pending.userMessageId,
        recoveryStartedAt: pending.startedAt,
        recoveryLeaseExpiresAt: pending.leaseExpiresAt,
        preserved: true,
    });
    return true;
}

/** A host context-limit question can be written after a recovery dispatch has
 * already produced provider output. That dispatch is consumed: never reclaim
 * or replay it. A new bounded clean continuation may use only the preserved
 * objective and host-owned receipts, and must spend a distinct attempt. */
async function sessionOpContinueObservedContextLimitQuestionAfterRestart(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<boolean> {
    const pending = managed.pendingTurnRecovery;
    const dispatch = pending?.recoveryDispatch;
    const request = sessionOpRetryableContextLimitRequest(sessionOperationContext, managed);
    if (!pending || !dispatch || !request?.hostPrompt
        || request.status !== 'pending'
        || dispatch.phase !== 'started'
        || dispatch.origin !== 'automatic'
        || dispatch.preToolExecutionReceiptVersion !== 1
        || !Number.isFinite(dispatch.startedAt)
        || dispatch.cleanContinuationId || dispatch.fallbackIntent
        || (managed.messageQueue.length > 0 && !sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
        || sessionOpHasPendingDecision(sessionOperationContext, managed)
        || managed.pendingAuthRequestId || managed.pendingAuthRequest)
        return false;
    const boundaryRows = managed.messages.flatMap((message, index) => (message.id === dispatch.id ? [{ message, index }] : []));
    const boundary = boundaryRows.length === 1 ? boundaryRows[0] : undefined;
    if (!boundary || boundary.message.role !== 'user'
        || boundary.message.hidden !== true || boundary.message.isQueued
        || boundary.message.timestamp < dispatch.startedAt!)
        return false;
    const afterBoundary = managed.messages.slice(boundary.index + 1);
    if (afterBoundary.some(message => message.role === 'user' && !message.hidden)
        || !afterBoundary.some(message => ((message.role === 'assistant' || message.role === 'tool')
            && message.timestamp >= dispatch.startedAt!
            && message.timestamp <= request.createdAt)))
        return false;
    const nextPending: PendingTurnRecovery = {
        ...pending,
        recoveryDispatch: undefined,
        cleanContextBoundaryMessageId: undefined,
        continuationRequired: true,
    };
    const handoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, nextPending);
    if (!handoff || !buildCleanRecoveryContinuationPrompt(handoff))
        return false;
    // Cancellation and successor allocation share the enqueue durable flush.
    // A crash before it retains the old question; a crash after it finds the
    // new dispatch. The consumed provider transcript remains intact in both.
    request.status = 'cancelled';
    request.answeredAt = Math.max(Date.now(), request.createdAt + 1);
    managed.pendingTurnRecovery = nextPending;
    try {
        const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'objective_continue', pending.validationGaps, handoff.remainingWork, undefined, undefined, true);
        if (!queued) {
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        sessionOpEmitUserInputChanged(sessionOperationContext, managed);
        sessionLog.warn('Replaced a consumed context-limit question with a distinct clean continuation', {
            sessionId: managed.id,
            requestId: request.id,
            consumedDispatchId: dispatch.id,
            successorDispatchId: managed.pendingTurnRecovery?.recoveryDispatch?.id,
            queued,
        });
        if (queued && managed.messageQueue.length > 0 && !managed.isProcessing) {
            sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
        }
        return true;
    }
    catch (error) {
        // Roll back only before a successor changed the recovery snapshot. A
        // later failure cannot resurrect the consumed question beside a new
        // dispatch whose allocation may already be durable.
        if (managed.pendingTurnRecovery === nextPending) {
            managed.pendingTurnRecovery = pending;
            request.status = 'pending';
            request.answeredAt = undefined;
        }
        throw error;
    }
}

/** A recovery inherited from a delegation cannot outlive an immutable
 * ancestry boundary. Preserve its exact Retry snapshot, but never replay it
 * under a completed/replaced/missing parent objective. */
async function sessionOpTerminalizeImmutableAutomaticRecoveryBlock(sessionOperationContext: SessionOperationContext, managed: ManagedSession, lineage: ReturnType<typeof inspectAutonomousLineage>): Promise<boolean> {
    const initialObjective = managed.activeObjective;
    const initialPending = managed.pendingTurnRecovery;
    if (!initialObjective || initialObjective.terminalState !== 'active' || !initialPending
        || lineage.allowed || !isImmutableAutomaticRecoveryBlock(lineage.reason))
        return false;
    // A cold recovery has only header metadata at this point. Load the exact
    // transcript before allowing an old pending ID to become Retry authority.
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    if (managed.activeObjective !== initialObjective || initialObjective.terminalState !== 'active'
        || managed.pendingTurnRecovery !== initialPending)
        return false;
    const objective = initialObjective;
    const pending = initialPending;
    const currentLineage = inspectAutonomousLineage(managed, id => sessionOperationContext.state.sessions.get(id), false, id => { const session = sessionOperationContext.state.sessions.get(id); return !!session && sessionOpHasPendingDecision(sessionOperationContext, session); });
    if (currentLineage.allowed || !isImmutableAutomaticRecoveryBlock(currentLineage.reason))
        return false;
    if (sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)) {
        objective.interruptedTurnRecovery = {
            objectiveId: objective.objectiveId ?? objective.userMessageId,
            // The envelope is authenticated by the latest visible human anchor.
            // Its exact internal recovery may legitimately point at a hidden
            // user-input answer and is preserved unchanged below.
            userMessageId: objective.lastUserMessageId ?? objective.userMessageId,
            recovery: structuredClone(pending),
        };
    }
    else {
        // Never launder a stale objective's budget/work into the current Retry.
        // There is no runnable quarantine slot: revoking the pending authority
        // while retaining transcript evidence is the fail-closed handoff.
        objective.interruptedTurnRecovery = undefined;
        sessionLog.warn('Revoked automatic recovery with stale objective provenance', {
            sessionId: managed.id,
            objectiveId: objective.objectiveId ?? objective.userMessageId,
            recoveryUserMessageId: pending.userMessageId,
        });
    }
    objective.terminalState = 'blocked_policy';
    objective.completedAt = Date.now();
    managed.pendingTurnRecovery = undefined;
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOperationContext.owner["sendEvent"]({
        type: 'info', sessionId: managed.id, level: 'warning', timestamp: sessionOpMonotonic(sessionOperationContext),
        message: `Automatic continuation stopped because its delegated ancestry is no longer valid (${currentLineage.reason}: ${currentLineage.blockedBy ?? 'unknown'}). Completed work${objective.interruptedTurnRecovery ? ' and the exact recovery state were preserved' : ' was preserved while stale recovery authority was revoked'}; no previous dispatch was replayed.`,
    }, managed.workspace.id);
    return true;
}

export { sessionOpDispatchAllocatedCleanRetry as dispatchAllocatedCleanRetry };
export { sessionOpResumeAllocatedRecoveryDispatch as resumeAllocatedRecoveryDispatch };
export { sessionOpQuarantineExpiredColdAutomaticRecovery as quarantineExpiredColdAutomaticRecovery };
export { sessionOpContinueObservedContextLimitQuestionAfterRestart as continueObservedContextLimitQuestionAfterRestart };
export { sessionOpTerminalizeImmutableAutomaticRecoveryBlock as terminalizeImmutableAutomaticRecoveryBlock };
