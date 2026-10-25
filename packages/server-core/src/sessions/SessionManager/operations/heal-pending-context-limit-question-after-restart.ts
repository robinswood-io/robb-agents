import type { SessionOperationContext } from '../operation-context.ts';
import { validAllocatedRecoveryDispatch } from '../policy.ts';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { buildCleanRecoveryContinuationPrompt } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { isExactContextLimitNextStepQuestion } from '../user-input-authority.ts';
import { retryableContextLimitRequest as sessionOpRetryableContextLimitRequest } from './retryable-context-limit-request.ts';
import { reclaimableUnobservedStartedRecoveryDispatch as sessionOpReclaimableUnobservedStartedRecoveryDispatch } from './create-autonomous-context-limit-handoff.ts';
import { createContextLimitRetryHandoff as sessionOpCreateContextLimitRetryHandoff } from './create-context-limit-retry-handoff.ts';
import { getPendingUserInputResponse as sessionOpGetPendingUserInputResponse, buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';
import { emitUserInputChanged as sessionOpEmitUserInputChanged } from './perform-request-user-input.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';

/** Upgrade an exact legacy hard-limit question to the clean continuation the
 * host can now derive from its durable objective. This spends no additional
 * attempt and accepts no new authority: only the unique host-authenticated
 * pre-provider question/dispatch pair is eligible. */
async function sessionOpHealPendingContextLimitQuestionAfterRestart(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<boolean> {
    const pending = managed.pendingTurnRecovery;
    const request = sessionOpRetryableContextLimitRequest(sessionOperationContext, managed);
    const dispatch = pending?.recoveryDispatch;
    if (!pending || request?.status !== 'pending' || !dispatch)
        return false;
    let allocatedDispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']>;
    let syntheticPromptIndex: number | undefined;
    if (dispatch.phase === 'allocated') {
        if (validAllocatedRecoveryDispatch(pending) !== dispatch)
            return false;
        allocatedDispatch = { ...dispatch };
    }
    else if (dispatch.phase === 'started') {
        const reclaimable = sessionOpReclaimableUnobservedStartedRecoveryDispatch(sessionOperationContext, managed, pending);
        if (reclaimable) {
            allocatedDispatch = { ...reclaimable.allocatedDispatch };
            syntheticPromptIndex = reclaimable.messageIndex;
        }
        else if (dispatch.origin === 'retry' && dispatch.cause === 'user_retry'
            && dispatch.preToolExecutionReceiptVersion === 1
            && Number.isFinite(dispatch.startedAt)
            && !dispatch.fallbackIntent && !dispatch.cleanContinuationId
            && !managed.messages.some(message => message.id === dispatch.id)) {
            // Explicit Retry normally reuses the accepted visible objective row;
            // its private dispatch id therefore has no transcript row of its own.
            // The authenticated hostPrompt proves provider admission never began.
            allocatedDispatch = { ...dispatch, phase: 'allocated' };
            delete allocatedDispatch.startedAt;
        }
        else {
            return false;
        }
    }
    else {
        return false;
    }
    delete allocatedDispatch.fallbackIntent;
    delete allocatedDispatch.cleanContinuationId;
    const basePending: PendingTurnRecovery = {
        ...pending,
        // startRecoveryDispatch always records this cause before the provider
        // seam. Include it before hashing the handoff or the first Retry rebuild
        // will derive a different id from the same durable objective.
        lastCause: allocatedDispatch.cause,
        recoveryDispatch: allocatedDispatch,
        cleanContextBoundaryMessageId: undefined,
    };
    const provisionalHandoff = dispatch.origin === 'retry'
        ? sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, basePending)
            ?? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, basePending)
        : sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, basePending);
    if (!provisionalHandoff || !buildCleanRecoveryContinuationPrompt(provisionalHandoff)) {
        return false;
    }
    const cleanDispatch = {
        ...allocatedDispatch,
        cleanContinuationId: provisionalHandoff.id,
    };
    const cleanPending: PendingTurnRecovery = {
        ...basePending,
        recoveryDispatch: cleanDispatch,
        cleanContextBoundaryMessageId: cleanDispatch.id,
    };
    const finalHandoff = dispatch.origin === 'retry'
        ? sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, cleanPending)
            ?? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, cleanPending)
        : sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, cleanPending);
    const cleanPrompt = finalHandoff && buildCleanRecoveryContinuationPrompt(finalHandoff);
    if (!finalHandoff || finalHandoff.id !== cleanDispatch.cleanContinuationId || !cleanPrompt) {
        return false;
    }
    // A previously accepted structured answer can still be waiting in the
    // local FIFO even though that exact authenticated answer is already folded
    // into the clean handoff. Consume only this one redundant delivery record;
    // keep its transcript evidence and every unrelated machine/human row.
    const representedAnswerRequest = sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true);
    const representedAnswerId = representedAnswerRequest?.responseMessageId === pending.userMessageId
        ? representedAnswerRequest.responseMessageId : undefined;
    const representedAnswerMessages = representedAnswerId
        ? managed.messages.filter(message => message.id === representedAnswerId)
        : [];
    const representedAnswerQueueIndexes = representedAnswerId
        ? managed.messageQueue.flatMap((item, index) => (item.messageId === representedAnswerId
            && item.options?.internalOrigin?.kind === 'user-input'
            && item.options.hidden === true
            ? [index] : []))
        : [];
    const representedAnswerMessage = representedAnswerMessages.length === 1
        && representedAnswerMessages[0]?.role === 'user'
        && representedAnswerMessages[0].hidden === true
        && representedAnswerMessages[0].isQueued === true
        && representedAnswerMessages[0].internalOrigin?.kind === 'user-input'
        && !representedAnswerMessages[0].agentDelivery
        && representedAnswerQueueIndexes.length === 1
        && managed.messageQueue[representedAnswerQueueIndexes[0]!]?.message
            === representedAnswerMessages[0].content
        ? representedAnswerMessages[0] : undefined;
    const representedAnswerQueueIndex = representedAnswerMessage
        ? representedAnswerQueueIndexes[0] : undefined;
    const representedAnswerQueueItem = representedAnswerQueueIndex === undefined
        ? undefined : managed.messageQueue[representedAnswerQueueIndex];
    const previous = {
        pendingTurnRecovery: pending,
        requestStatus: request.status,
        requestAnsweredAt: request.answeredAt,
        sdkSessionId: managed.sdkSessionId,
        branchFromSdkSessionId: managed.branchFromSdkSessionId,
        branchFromSessionPath: managed.branchFromSessionPath,
        branchFromSdkCwd: managed.branchFromSdkCwd,
        branchFromSdkTurnId: managed.branchFromSdkTurnId,
        branchContextStrategy: managed.branchContextStrategy,
        branchSeedApplied: managed.branchSeedApplied,
        providerContextBoundaryMessageId: managed.providerContextBoundaryMessageId,
        contextCompactionAttempt: managed.contextCompactionAttempt,
        transferredSessionSummary: managed.transferredSessionSummary,
        transferredSessionSummaryApplied: managed.transferredSessionSummaryApplied,
        tokenUsage: managed.tokenUsage ? { ...managed.tokenUsage } : undefined,
        syntheticPrompt: syntheticPromptIndex === undefined
            ? undefined
            : managed.messages[syntheticPromptIndex],
        representedAnswerWasQueued: representedAnswerMessage?.isQueued,
    };
    await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'automatic context-limit question recovery');
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.pendingTurnRecovery !== pending
        || request.status !== 'pending' || managed.stopRequested)
        return false;
    if (syntheticPromptIndex !== undefined)
        managed.messages.splice(syntheticPromptIndex, 1);
    if (representedAnswerQueueIndex !== undefined && representedAnswerQueueItem
        && managed.messageQueue[representedAnswerQueueIndex] === representedAnswerQueueItem
        && representedAnswerMessage) {
        managed.messageQueue.splice(representedAnswerQueueIndex, 1);
        representedAnswerMessage.isQueued = false;
    }
    request.status = 'cancelled';
    request.answeredAt = Math.max(Date.now(), request.createdAt + 1);
    managed.pendingTurnRecovery = cleanPending;
    managed.sdkSessionId = undefined;
    managed.branchFromSdkSessionId = undefined;
    managed.branchFromSessionPath = undefined;
    managed.branchFromSdkCwd = undefined;
    managed.branchFromSdkTurnId = undefined;
    managed.branchContextStrategy = undefined;
    managed.branchSeedApplied = true;
    managed.providerContextBoundaryMessageId = cleanDispatch.id;
    managed.contextCompactionAttempt = undefined;
    managed.transferredSessionSummary = undefined;
    managed.transferredSessionSummaryApplied = undefined;
    if (managed.tokenUsage) {
        managed.tokenUsage = {
            ...managed.tokenUsage,
            contextTokens: Math.max(1, Math.ceil(cleanPrompt.length / 4)),
        };
    }
    sessionOperationContext.owner["persistSession"](managed);
    try {
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        if (sessionOperationContext.state.sessions.get(managed.id) === managed
            && managed.pendingTurnRecovery === cleanPending && !managed.stopRequested) {
            if (previous.syntheticPrompt
                && !managed.messages.some(message => message.id === previous.syntheticPrompt!.id)) {
                managed.messages.splice(Math.min(syntheticPromptIndex ?? managed.messages.length, managed.messages.length), 0, previous.syntheticPrompt);
            }
            if (representedAnswerQueueIndex !== undefined && representedAnswerQueueItem
                && representedAnswerMessage
                && !managed.messageQueue.some(item => item === representedAnswerQueueItem)) {
                managed.messageQueue.splice(Math.min(representedAnswerQueueIndex, managed.messageQueue.length), 0, representedAnswerQueueItem);
                representedAnswerMessage.isQueued = previous.representedAnswerWasQueued;
            }
            request.status = previous.requestStatus;
            request.answeredAt = previous.requestAnsweredAt;
            managed.pendingTurnRecovery = previous.pendingTurnRecovery;
            managed.sdkSessionId = previous.sdkSessionId;
            managed.branchFromSdkSessionId = previous.branchFromSdkSessionId;
            managed.branchFromSessionPath = previous.branchFromSessionPath;
            managed.branchFromSdkCwd = previous.branchFromSdkCwd;
            managed.branchFromSdkTurnId = previous.branchFromSdkTurnId;
            managed.branchContextStrategy = previous.branchContextStrategy;
            managed.branchSeedApplied = previous.branchSeedApplied;
            managed.providerContextBoundaryMessageId = previous.providerContextBoundaryMessageId;
            managed.contextCompactionAttempt = previous.contextCompactionAttempt;
            managed.transferredSessionSummary = previous.transferredSessionSummary;
            managed.transferredSessionSummaryApplied = previous.transferredSessionSummaryApplied;
            managed.tokenUsage = previous.tokenUsage;
        }
        throw error;
    }
    sessionOpEmitUserInputChanged(sessionOperationContext, managed);
    sessionLog.warn('Replaced a legacy context-limit question with a clean autonomous continuation', {
        sessionId: managed.id,
        objectiveId: managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId,
        requestId: request.id,
        dispatchId: cleanDispatch.id,
        attempt: cleanDispatch.attempt,
    });
    return true;
}

/** Repair the narrow pre-provider snapshot written by older hosts that
 * hashed a clean Retry before recording its dispatch cause. The cancelled
 * host question, exact synthetic row, and allocated fenced dispatch jointly
 * prove that no provider work was admitted. A genuinely uncertain provider
 * boundary or unbound prompt is left untouched. */
async function sessionOpRepairLegacyCleanRetryCauseAfterRestart(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    const pending = managed.pendingTurnRecovery;
    const dispatch = pending?.recoveryDispatch;
    if (!pending || !dispatch || dispatch.phase !== 'allocated'
        || dispatch.origin !== 'retry' || dispatch.cause !== 'user_retry'
        || !dispatch.cleanContinuationId || !Number.isFinite(dispatch.setupPersistenceFencedAt)
        || pending.lastCause === dispatch.cause)
        return;
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.pendingTurnRecovery !== pending
        || managed.stopRequested || validAllocatedRecoveryDispatch(pending) !== dispatch
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return;
    const objective = managed.activeObjective;
    if (!objective || objective.terminalState !== 'active')
        return;
    const requests = (managed.userInputRequests ?? []).filter(request => (request.status === 'cancelled' && request.sessionId === managed.id
        && request.originWorkspaceId === managed.workspace.id
        && request.objectiveUserMessageId === objective?.userMessageId
        && request.hostPrompt?.schemaVersion === 1
        && request.hostPrompt.kind === 'context-limit-next-step'
        && request.hostPrompt.objectiveId === (objective.objectiveId ?? objective.userMessageId)
        && request.hostPrompt.recoveryDispatchId === dispatch.id
        && request.hostPrompt.issuedAt >= dispatch.allocatedAt
        && request.hostPrompt.issuedAt <= request.createdAt
        && !request.answers && !request.responseMessageId
        && isExactContextLimitNextStepQuestion(request)));
    const rows = managed.messages.filter(message => message.id === dispatch.id);
    const row = rows.length === 1 ? rows[0] : undefined;
    if (requests.length !== 1 || !row || managed.messages.at(-1) !== row
        || row.role !== 'user' || row.hidden !== true || row.isQueued || row.isPending
        || row.agentDelivery || row.providerDispatch || row.internalOrigin
        || (row.attachments?.length ?? 0) > 0
        || managed.messageQueue.some(item => item.messageId === dispatch.id)
        || managed.autonomyEvents?.some(event => event.timestamp >= row.timestamp))
        return;
    let oldPrompt: string;
    try {
        oldPrompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, pending, dispatch);
    }
    catch {
        return;
    }
    if (row.content !== oldPrompt)
        return;
    const previousContextLimit = sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, pending);
    const usedContextLimit = previousContextLimit?.id === dispatch.cleanContinuationId;
    const canonicalPending: PendingTurnRecovery = { ...pending, lastCause: dispatch.cause };
    const canonicalHandoff = usedContextLimit
        ? sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, canonicalPending)
        : sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, canonicalPending);
    if (!canonicalHandoff || !buildCleanRecoveryContinuationPrompt(canonicalHandoff))
        return;
    const repairedDispatch = { ...dispatch, cleanContinuationId: canonicalHandoff.id };
    delete repairedDispatch.setupPersistenceFencedAt;
    const repairedPending: PendingTurnRecovery = {
        ...canonicalPending, recoveryDispatch: repairedDispatch,
    };
    let repairedPrompt: string;
    try {
        repairedPrompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, repairedPending, repairedDispatch);
    }
    catch {
        return;
    }
    if (repairedPrompt !== buildCleanRecoveryContinuationPrompt(canonicalHandoff))
        return;
    const index = managed.messages.indexOf(row);
    managed.messages.splice(index, 1);
    managed.pendingTurnRecovery = repairedPending;
    if (!sessionOperationContext.owner["persistSession"](managed)) {
        managed.pendingTurnRecovery = pending;
        managed.messages.splice(index, 0, row);
        return;
    }
    try {
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        if (managed.pendingTurnRecovery === repairedPending) {
            managed.pendingTurnRecovery = pending;
            managed.messages.splice(index, 0, row);
        }
        throw error;
    }
    sessionLog.warn('Repaired a pre-provider clean Retry cause mismatch', {
        sessionId: managed.id, dispatchId: dispatch.id,
    });
}

export { sessionOpHealPendingContextLimitQuestionAfterRestart as healPendingContextLimitQuestionAfterRestart };
export { sessionOpRepairLegacyCleanRetryCauseAfterRestart as repairLegacyCleanRetryCauseAfterRestart };
