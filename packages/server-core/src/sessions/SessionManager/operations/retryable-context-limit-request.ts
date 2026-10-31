import type { SessionOperationContext } from '../operation-context.ts';
import { validAllocatedRecoveryDispatch, hasAuthenticatedObjectiveRoot } from '../policy.ts';
import type { UserInputRequest } from '@craft-agent/core';
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage';
import { collectObjectiveAcceptanceObservations } from '../../objective-acceptance-criteria';
import { isClosedSessionStatus } from '../../session-status-lifecycle';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { LEGACY_ALLOCATED_CONTEXT_LIMIT_PROMPT_WINDOW_MS, isExactContextLimitNextStepQuestion } from '../user-input-authority.ts';
import { hydrateMessagesForColdPersist as sessionOpHydrateMessagesForColdPersist } from './drain-deferred-automatic-sessions.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { contextLimitAuthenticatedAnswerEvidence as sessionOpContextLimitAuthenticatedAnswerEvidence } from './context-limit-authenticated-answer-evidence.ts';
import { getUserInputRequests as sessionOpGetUserInputRequests } from './perform-request-user-input.ts';

/** Retire only an old technical Read-amendment prompt whose exact original
 * predicates already pass. The question is not authority to change the
 * registered contract, and a negative or missing observation keeps it open. */
function sessionOpRetireProvenObsoleteReadAmendmentQuestion(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const objective = managed.activeObjective;
    const pending = managed.pendingTurnRecovery;
    const criteria = objective?.acceptanceCriteria ?? [];
    const requests = (managed.userInputRequests ?? []).filter(request => request.status === 'pending');
    const request = requests.length === 1 ? requests[0] : undefined;
    if (!objective || objective.terminalState !== 'active'
        || !pending || pending.exhaustedAt
        || objective.lastOutcome?.state !== 'continue'
        || objective.lastOutcome.blocker != null
        || !request || request.sessionId !== managed.id
        || request.originWorkspaceId !== managed.workspace.id
        || request.objectiveUserMessageId !== objective.userMessageId
        || request.responseMessageId || request.answers
        || request.questions.length !== 1
        || request.questions[0]?.id !== 'amend-static-checks'
        || criteria.length === 0 || criteria.length > 16
        || criteria.some(criterion => !/^(?:functions\.)?read$/i.test(criterion.toolName)
            || criterion.checks.length !== 1
            || criterion.checks[0]?.path !== '$text'
            || typeof criterion.checks[0]?.equals !== 'string')
        || isClosedSessionStatus(loadStatusConfig(managed.workspace.rootPath), managed.sessionStatus))
        return false;
    sessionOpHydrateMessagesForColdPersist(sessionOperationContext, managed);
    if (!hasAuthenticatedObjectiveRoot(managed, objective)
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return false;
    const observed = collectObjectiveAcceptanceObservations(objective, managed.messages, managed.id);
    const positiveById = new Map(observed.filter(item => item.passed)
        .map(item => [item.criterionId, item.message.timestamp]));
    if (positiveById.size !== criteria.length
        || criteria.some(criterion => !positiveById.has(criterion.id))
        || Math.max(...positiveById.values()) > request.createdAt)
        return false;
    request.status = 'cancelled';
    request.answeredAt = Math.max(Date.now(), request.createdAt + 1);
    sessionLog.info('Retired obsolete Read amendment question after exact host validation', {
        sessionId: managed.id,
        requestId: request.id,
        criteria: criteria.map(criterion => criterion.id),
    });
    return true;
}

/** Prove that one exact prompt was created by the hard-limit gate before any
 * provider work. The legacy branches are intentionally closed to the old
 * stored shapes observed in strong-spruce; text equality alone is
 * insufficient. An orderly shutdown can remove the still-pre-provider hidden
 * row and roll its dispatch from `started` back to `allocated`, so that shape
 * is authenticated from its allocation/compaction receipts instead. */
function sessionOpRetryableContextLimitRequest(sessionOperationContext: SessionOperationContext, managed: ManagedSession): UserInputRequest | undefined {
    const objective = managed.activeObjective;
    const pending = managed.pendingTurnRecovery;
    const dispatch = pending?.recoveryDispatch;
    const compaction = managed.contextCompactionAttempt;
    const hardLimit = compaction?.hardLimitTokens;
    const startedBoundary = dispatch?.phase === 'started' && Number.isFinite(dispatch.startedAt);
    const allocatedBoundary = !!pending && dispatch?.phase === 'allocated'
        && validAllocatedRecoveryDispatch(pending) === dispatch;
    const boundaryAt = startedBoundary ? dispatch.startedAt! : dispatch?.allocatedAt;
    const objectiveId = objective?.objectiveId ?? objective?.userMessageId;
    const objectiveRevision = objective?.lastUserMessageId ?? objective?.userMessageId;
    const objectiveIds = new Set([
        objective?.objectiveId,
        objective?.userMessageId,
        objectiveRevision,
        pending?.userMessageId,
    ].filter((id): id is string => !!id));
    if (!objective || objective.terminalState !== 'active' || !pending || !dispatch
        || (!startedBoundary && !allocatedBoundary) || !Number.isFinite(boundaryAt)
        || !hardLimit || hardLimit <= 0
        || !compaction.objectiveRootId || !objectiveIds.has(compaction.objectiveRootId)
        || (managed.tokenUsage?.contextTokens ?? 0) <= hardLimit
        || !hasAuthenticatedObjectiveRoot(managed, objective))
        return undefined;
    // The recovery anchor can be either the latest accepted visible revision
    // or one exact host-authenticated structured answer. Reuse the common
    // provenance check so a valid answer-driven turn cannot create a visible
    // context prompt which Retry then refuses, while a public/forged hidden
    // row still grants no authority.
    const pendingIsVisibleObjectiveRevision = pending.userMessageId === objective.userMessageId
        || pending.userMessageId === objectiveRevision;
    const authenticatedAnswerEvidence = pendingIsVisibleObjectiveRevision
        ? undefined
        : sessionOpContextLimitAuthenticatedAnswerEvidence(sessionOperationContext, managed, objective, pending.userMessageId);
    const pendingBelongsToCurrentObjective = sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending) && (pendingIsVisibleObjectiveRevision
        || authenticatedAnswerEvidence?.responseMessageIds.has(pending.userMessageId) === true);
    const contextLimitRequests = (managed.userInputRequests ?? []).filter(request => (request.sessionId === managed.id && request.originWorkspaceId === managed.workspace.id
        && (request.status === 'pending' || request.status === 'cancelled')
        && !request.responseMessageId && !request.answers
        && isExactContextLimitNextStepQuestion(request)));
    if (!pendingBelongsToCurrentObjective)
        return undefined;
    // Select by the current host dispatch before considering cardinality. A
    // completed clean Retry deliberately retains its question as `cancelled`;
    // that durable history must not make a later hard-limit cycle ambiguous.
    // Multiple prompts claiming the same current dispatch remain fail-closed.
    const currentHostRequests = contextLimitRequests.filter(request => (request.hostPrompt?.schemaVersion === 1
        && request.hostPrompt.kind === 'context-limit-next-step'
        && request.objectiveUserMessageId === objective.userMessageId
        && request.hostPrompt.objectiveId === objectiveId
        && request.hostPrompt.recoveryDispatchId === dispatch.id
        && request.hostPrompt.issuedAt >= boundaryAt!
        && request.hostPrompt.issuedAt <= request.createdAt));
    if (currentHostRequests.length > 1)
        return undefined;
    const currentHostRequest = currentHostRequests[0];
    if (currentHostRequest) {
        const otherPending = sessionOpGetUserInputRequests(sessionOperationContext, managed).some(candidate => (candidate.status === 'pending' && candidate.id !== currentHostRequest.id));
        return otherPending ? undefined : currentHostRequest;
    }
    // An exact host-authenticated prompt is sufficient proof of the hard-limit
    // gate even when the SDK reported `not-needed` before a follow-up receipt
    // could be set. Text-only legacy prompts still require that receipt.
    if (compaction?.hardLimitFollowUpAttempted !== true)
        return undefined;
    const legacyRequestObjectiveIds = new Set([
        objective.userMessageId,
        objectiveRevision,
    ].filter((id): id is string => !!id));
    const legacyRequests = contextLimitRequests.filter(request => (request.hostPrompt === undefined
        && request.createdAt >= boundaryAt!
        && !!request.objectiveUserMessageId
        && legacyRequestObjectiveIds.has(request.objectiveUserMessageId)));
    if (legacyRequests.length !== 1)
        return undefined;
    const request = legacyRequests[0]!;
    const otherPending = sessionOpGetUserInputRequests(sessionOperationContext, managed).some(candidate => (candidate.status === 'pending' && candidate.id !== request.id));
    if (otherPending)
        return undefined;
    if (allocatedBoundary) {
        // Compatibility proof for an old host prompt interrupted by orderly app
        // shutdown after it was durably written but before agent.chat(). The
        // shutdown removes the tracked hidden row and restores its allocation.
        // Tie the question to the exact automatic allocation, the measured
        // above-limit compaction receipt and an otherwise untouched transcript;
        // a provider-created lookalike therefore cannot mint Retry authority.
        const providerBaseline = compaction?.providerContextBaselineTokens;
        const noPostAllocationTranscript = managed.messages.every(message => (Number.isFinite(message.timestamp) && message.timestamp < dispatch.allocatedAt));
        return dispatch.origin === 'automatic'
            && dispatch.cause === 'objective_incomplete'
            && dispatch.preToolExecutionReceiptVersion === 1
            && !dispatch.cleanContinuationId && !dispatch.fallbackIntent
            && pending.lastCause === dispatch.cause
            && pending.lastAttemptAt === dispatch.allocatedAt
            && pending.validationExhausted === true
            && !!pending.validationGaps?.length
            && objectiveIds.has(compaction.objectiveRootId)
            && compaction?.outcome === 'succeeded'
            && Number.isFinite(compaction.attemptedAt)
            && compaction.attemptedAt <= dispatch.allocatedAt
            && Number.isFinite(providerBaseline)
            && providerBaseline! > hardLimit
            && compaction.contextTokensBefore > hardLimit
            && request.createdAt - dispatch.allocatedAt <= LEGACY_ALLOCATED_CONTEXT_LIMIT_PROMPT_WINDOW_MS
            && noPostAllocationTranscript
            ? request : undefined;
    }
    // Compatibility proof for the exact pre-provenance persisted started
    // prompt. Its row must be the unique final transcript row and the question
    // must have been created only after that no-provider-output boundary.
    const rows = managed.messages.flatMap((message, index) => (message.id === dispatch.id ? [{ message, index }] : []));
    const row = rows[0];
    const expectedPrefix = `<automatic_turn_recovery original_user_message_id="${pending.userMessageId}" attempt="${dispatch.attempt}">\n`;
    return rows.length === 1 && !!row && row.index === managed.messages.length - 1
        && row.message.role === 'user' && row.message.hidden === true
        && !row.message.isQueued && !row.message.isPending && !row.message.agentDelivery
        && row.message.timestamp >= dispatch.startedAt!
        && row.message.content.startsWith(expectedPrefix)
        && row.message.content.includes('\n</automatic_turn_recovery>')
        ? request : undefined;
}

export { sessionOpRetireProvenObsoleteReadAmendmentQuestion as retireProvenObsoleteReadAmendmentQuestion };
export { sessionOpRetryableContextLimitRequest as retryableContextLimitRequest };
