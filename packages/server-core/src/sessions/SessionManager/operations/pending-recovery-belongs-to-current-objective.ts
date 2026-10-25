import type { SessionOperationContext } from '../operation-context.ts';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import type { ManagedSession } from '../managed-session.ts';
import { canonicalUserInputAnswerContents } from '../user-input-authority.ts';
import { boundCleanUserInputRequest as sessionOpBoundCleanUserInputRequest } from './context-limit-authenticated-answer-evidence.ts';

function sessionOpIsCleanSetupRetryBlocked(sessionOperationContext: SessionOperationContext, dispatch: PendingTurnRecovery['recoveryDispatch'] | undefined): boolean {
    return !!dispatch?.cleanContinuationId
        && Number.isFinite(dispatch.setupRetryBlockedAt)
        && dispatch.setupRetryBlockedAt! > 0;
}

/** A recovery snapshot may be exposed to Retry only when its durable anchor
 * still belongs to the active objective. Hidden question answers need both
 * their host-owned request record and their exact transcript provenance. */
function sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): boolean {
    const objective = managed.activeObjective;
    if (!objective)
        return false;
    const isAcceptedVisibleAnchor = (messageId: string): boolean => {
        const matches = managed.messages.filter(candidate => candidate.id === messageId);
        const message = matches[0];
        if (matches.length !== 1 || !message || message.role !== 'user' || message.hidden || message.isQueued || message.isPending
            || message.agentDelivery)
            return false;
        if (!message.internalOrigin)
            return true;
        return messageId === objective.userMessageId
            && (message.internalOrigin.kind === 'spawned-session'
                ? message.internalOrigin.senderSessionId === managed.parentSessionId
                : message.internalOrigin.kind === 'automation' && !!managed.triggeredBy);
    };
    const latestVisibleAnchorId = objective.lastUserMessageId ?? objective.userMessageId;
    if (!isAcceptedVisibleAnchor(latestVisibleAnchorId))
        return false;
    if ((pending.userMessageId === objective.userMessageId
        || pending.userMessageId === latestVisibleAnchorId)
        && isAcceptedVisibleAnchor(pending.userMessageId))
        return true;
    const requests = managed.userInputRequests?.filter(candidate => (candidate.status === 'answered'
        && candidate.responseMessageId === pending.userMessageId
        && candidate.sessionId === managed.id
        && candidate.originWorkspaceId === managed.workspace.id
        && candidate.objectiveUserMessageId === objective.userMessageId)) ?? [];
    const request = requests.length === 1 ? requests[0] : undefined;
    if (!request?.answers?.length)
        return false;
    const boundCleanRequest = sessionOpBoundCleanUserInputRequest(sessionOperationContext, managed, pending);
    const answers = managed.messages.filter(candidate => candidate.id === pending.userMessageId);
    const answer = answers[0];
    if (boundCleanRequest === request && answers.length === 0)
        return true;
    if (boundCleanRequest === request && answers.length === 1 && !!answer
        && answer.role === 'user' && answer.hidden === true && !answer.isQueued
        && !answer.isPending && !answer.agentDelivery
        && (answer.internalOrigin === undefined || answer.internalOrigin.kind === 'user-input')) {
        return true;
    }
    return answers.length === 1 && !!answer && answer.role === 'user' && answer.hidden === true
        && !answer.isPending && !answer.agentDelivery
        && answer.internalOrigin?.kind === 'user-input'
        && (canonicalUserInputAnswerContents(request).includes(answer.content)
            || boundCleanRequest === request && !answer.isQueued);
}

export { sessionOpIsCleanSetupRetryBlocked as isCleanSetupRetryBlocked };
export { sessionOpPendingRecoveryBelongsToCurrentObjective as pendingRecoveryBelongsToCurrentObjective };
