import type { SessionOperationContext } from '../operation-context.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { PendingTurnRecovery, ActiveSessionObjective } from '@craft-agent/shared/sessions';
import type { ManagedSession } from '../managed-session.ts';
import { authenticatedUserInputAnswerAuthoritySegments, isExactContextLimitNextStepQuestion, legacyUserInputAnswerMessageContent, userInputAnswerMessageContent } from '../user-input-authority.ts';

/** Build a fresh-context contract solely from accepted human objective state,
 * registered host criteria and host validation gaps. Assistant finals and
 * free-form tool output are deliberately absent. */
function sessionOpBoundCleanUserInputRequest(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): UserInputRequest | undefined {
    const objective = managed.activeObjective;
    const dispatch = pending.recoveryDispatch;
    if (!objective || !dispatch || (dispatch.phase !== 'allocated' && dispatch.phase !== 'started')
        || !dispatch.cleanContinuationId || dispatch.origin !== 'retry'
        || dispatch.cause !== 'user_retry' || pending.userMessageId !== dispatch.id)
        return undefined;
    const requests = (managed.userInputRequests ?? []).filter(request => (request.status === 'answered' && request.responseMessageId === dispatch.id
        && request.sessionId === managed.id && request.originWorkspaceId === managed.workspace.id
        && request.objectiveUserMessageId === objective.userMessageId
        && request.hostPrompt?.schemaVersion === 1
        && request.hostPrompt.kind === 'context-limit-next-step'
        && request.hostPrompt.objectiveId === (objective.objectiveId ?? objective.userMessageId)
        && typeof request.hostPrompt.recoveryDispatchId === 'string'
        && request.hostPrompt.recoveryDispatchId.length > 0
        && Number.isFinite(request.hostPrompt.issuedAt)
        && request.hostPrompt.issuedAt <= request.createdAt
        && Number.isFinite(request.answeredAt) && request.answeredAt! >= request.createdAt
        && !!request.answers?.length && isExactContextLimitNextStepQuestion(request)));
    return requests.length === 1 ? requests[0] : undefined;
}

function sessionOpContextLimitAuthenticatedAnswerEvidence(sessionOperationContext: SessionOperationContext, managed: ManagedSession, objective: ActiveSessionObjective, requiredResponseMessageId?: string, pendingOverride?: PendingTurnRecovery): {
    evidence: Array<{
        reference: string;
        summary: string;
    }>;
    responseMessageIds: Set<string>;
} | undefined {
    const rootIndex = managed.messages.findIndex(message => message.id === objective.userMessageId);
    if (rootIndex < 0)
        return undefined;
    const rows: Array<{
        index: number;
        request: UserInputRequest;
        messageId: string;
    }> = [];
    const responseMessageIds = new Set<string>();
    for (const request of managed.userInputRequests ?? []) {
        if (request.status !== 'answered' || !request.answers?.length || !request.responseMessageId
            || request.sessionId !== managed.id || request.originWorkspaceId !== managed.workspace.id
            || request.objectiveUserMessageId !== objective.userMessageId)
            continue;
        const matches = managed.messages.flatMap((message, index) => (message.id === request.responseMessageId ? [{ message, index }] : []));
        const row = matches[0];
        const queuedAnswerItems = row?.message.isQueued === true
            ? managed.messageQueue.filter(item => (item.messageId === row.message.id
                && item.message === row.message.content
                && item.options?.hidden === true
                && item.options.internalOrigin?.kind === 'user-input'
                && !item.options.automaticRecovery))
            : [];
        const exactQueuedAnswer = row?.message.isQueued === true
            && queuedAnswerItems.length === 1
            && !sessionOperationContext.state.queuedMessageDispatches.has(managed.id);
        if (matches.length !== 1 || !row || row.index <= rootIndex
            || row.message.role !== 'user' || row.message.hidden !== true
            || (row.message.isQueued && !exactQueuedAnswer)
            || row.message.isPending || row.message.agentDelivery
            || row.message.internalOrigin?.kind !== 'user-input'
            || ![
                userInputAnswerMessageContent(request.id, request.questions, request.answers),
                legacyUserInputAnswerMessageContent(request.id, request.questions, request.answers),
            ].includes(row.message.content)
            || rows.some(candidate => candidate.messageId === row.message.id))
            continue;
        rows.push({ index: row.index, request, messageId: row.message.id });
    }
    const evidencePending = pendingOverride ?? managed.pendingTurnRecovery;
    const boundCleanRequest = evidencePending
        ? sessionOpBoundCleanUserInputRequest(sessionOperationContext, managed, evidencePending)
        : undefined;
    if (boundCleanRequest?.responseMessageId
        && !rows.some(candidate => candidate.messageId === boundCleanRequest.responseMessageId)) {
        const matches = managed.messages.flatMap((message, index) => (message.id === boundCleanRequest.responseMessageId ? [{ message, index }] : []));
        const match = matches[0];
        const compatibleRepurposedOrReclaimed = matches.length === 0 || matches.length === 1
            && !!match && match.message.role === 'user' && match.message.hidden === true
            && !match.message.isQueued && !match.message.isPending && !match.message.agentDelivery
            && (match.message.internalOrigin === undefined
                || match.message.internalOrigin.kind === 'user-input')
            && (match.message.attachments?.length ?? 0) === 0;
        if (compatibleRepurposedOrReclaimed) {
            rows.push({
                index: match?.index ?? managed.messages.length,
                request: boundCleanRequest,
                messageId: boundCleanRequest.responseMessageId,
            });
        }
    }
    rows.sort((left, right) => left.index - right.index);
    const candidates: Array<{
        index: number;
        messageId: string;
        evidence: Array<{
            reference: string;
            summary: string;
        }>;
    }> = [];
    for (const { index, request, messageId } of rows) {
        const segments = authenticatedUserInputAnswerAuthoritySegments(request);
        if (!segments.length)
            continue;
        const answerEvidence: Array<{
            reference: string;
            summary: string;
        }> = [];
        for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
            const segment = segments[segmentIndex]!;
            const chunks = Array.from({ length: Math.ceil(segment.length / 1500) }, (_, index) => (segment.slice(index * 1500, (index + 1) * 1500)));
            for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
                const reference = `${messageId}#answer-${segmentIndex + 1}-${chunkIndex + 1}`;
                if (reference.length > 512) {
                    answerEvidence.length = 0;
                    break;
                }
                answerEvidence.push({ reference, summary: chunks[chunkIndex]! });
            }
            if (!answerEvidence.length)
                break;
        }
        if (!answerEvidence.length || answerEvidence.length > 32)
            continue;
        candidates.push({
            index,
            messageId,
            evidence: answerEvidence,
        });
    }
    const requiredCandidate = requiredResponseMessageId
        ? candidates.find(candidate => candidate.messageId === requiredResponseMessageId)
        : undefined;
    if (requiredResponseMessageId && !requiredCandidate)
        return { evidence: [], responseMessageIds };
    const selected = new Set<typeof candidates[number]>();
    let selectedFactCount = 0;
    if (requiredCandidate) {
        selected.add(requiredCandidate);
        selectedFactCount = requiredCandidate.evidence.length;
    }
    for (const candidate of [...candidates].reverse()) {
        if (selected.has(candidate) || selectedFactCount + candidate.evidence.length > 32)
            continue;
        selected.add(candidate);
        selectedFactCount += candidate.evidence.length;
    }
    const evidence: Array<{
        reference: string;
        summary: string;
    }> = [];
    for (const candidate of [...selected].sort((left, right) => left.index - right.index)) {
        responseMessageIds.add(candidate.messageId);
        evidence.push(...candidate.evidence);
    }
    return { evidence, responseMessageIds };
}

export { sessionOpBoundCleanUserInputRequest as boundCleanUserInputRequest };
export { sessionOpContextLimitAuthenticatedAnswerEvidence as contextLimitAuthenticatedAnswerEvidence };
