import type { SessionOperationContext } from '../operation-context.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { ManagedSession } from '../managed-session.ts';
import { canonicalUserInputAnswerContents, userInputAnswerMessageContent } from '../user-input-authority.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import type { Message } from '@craft-agent/core/types';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { boundObjectiveForCleanHandoff, isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { buildObjectiveValidationEvidenceContext } from '../../objective-validation-context';
import { buildAutomaticTurnRecoveryPrompt, buildCleanRecoveryContinuationPrompt, createCleanRecoveryContinuationHandoff } from '../../turn-recovery';
import { buildAutonomyFallbackPrompt } from '../../autonomy-browser-fallback';
import { createContextLimitRetryHandoff as sessionOpCreateContextLimitRetryHandoff } from './create-context-limit-retry-handoff.ts';

function sessionOpGetPendingUserInputResponse(sessionOperationContext: SessionOperationContext, managed: ManagedSession, allowTerminalObjective = false): UserInputRequest | undefined {
    const requests = managed.userInputRequests?.filter(request => request.status === 'answered'
        && request.responseMessageId === managed.pendingTurnRecovery?.userMessageId
        && request.sessionId === managed.id && request.originWorkspaceId === managed.workspace.id
        && request.objectiveUserMessageId === managed.activeObjective?.userMessageId
        && (allowTerminalObjective || !sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))) ?? [];
    const request = requests.length === 1 ? requests[0] : undefined;
    if (!request?.responseMessageId || !request.answers?.length)
        return undefined;
    const rows = managed.messages.filter(message => message.id === request.responseMessageId);
    const row = rows[0];
    return rows.length === 1 && !!row && row.role === 'user' && row.hidden === true
        && !row.isPending && !row.agentDelivery && row.internalOrigin?.kind === 'user-input'
        && (canonicalUserInputAnswerContents(request).includes(row.content)
            || sessionOpIsExactRepurposedUserInputCleanBoundary(sessionOperationContext, managed, request, row))
        ? request
        : undefined;
}

/** A hard context-limit discovered while delivering an authenticated answer
 * may atomically reuse that row as the clean provider boundary. The original
 * request still identifies the human decision, while the only acceptable
 * replacement content is the exact host-rebuilt clean handoff. */
function sessionOpIsExactRepurposedUserInputCleanBoundary(sessionOperationContext: SessionOperationContext, managed: ManagedSession, request: UserInputRequest, row: Message): boolean {
    const pending = managed.pendingTurnRecovery;
    const dispatch = pending?.recoveryDispatch;
    if (!pending || dispatch?.phase !== 'started' || !dispatch.cleanContinuationId
        || dispatch.id !== row.id || request.responseMessageId !== row.id
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return false;
    try {
        return row.content === sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, pending, dispatch);
    }
    catch {
        return false;
    }
}

/** Rebuild only the transient FIFO entry for an allocation that was already
 * committed. The budget, lease and dispatch identity must remain unchanged. */
function sessionOpBuildRecoveryDispatchMessage(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery, dispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']>): string {
    if (dispatch.cleanContinuationId) {
        const contextLimitRetryHandoff = dispatch.origin === 'retry'
            ? sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, pending)
            : undefined;
        const autonomousHandoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, pending);
        const objective = managed.activeObjective;
        const remainingWork = pending.continuationWork ?? objective?.lastOutcome?.remainingWork;
        const boundedObjective = objective ? boundObjectiveForCleanHandoff(managed, objective) : undefined;
        const continuationHandoff = boundedObjective && remainingWork
            ? createCleanRecoveryContinuationHandoff({
                objective: boundedObjective.objective,
                pending,
                objectiveText: boundedObjective.objectiveText,
                // Only fixed host-owned state crosses this boundary. Raw provider
                // or tool text is deliberately excluded.
                evidence: [],
                remainingWork: remainingWork.slice(0, 16),
            })
            : undefined;
        // Different clean-boundary gates deliberately project different bounded
        // contracts. Rebuild all host-valid candidates and select only the one
        // whose deterministic id is already committed by the dispatch; candidate
        // ordering must never rewrite a durable boundary after restart.
        const handoff = [contextLimitRetryHandoff, autonomousHandoff, continuationHandoff]
            .find(candidate => candidate?.id === dispatch.cleanContinuationId);
        const prompt = handoff
            ? buildCleanRecoveryContinuationPrompt(handoff)
            : undefined;
        if (!prompt) {
            const rebuiltCandidates = [contextLimitRetryHandoff, autonomousHandoff, continuationHandoff]
                .map(candidate => candidate?.id)
                .filter((id): id is string => !!id);
            throw new Error(`The clean recovery continuation no longer matches its durable objective handoff (expected ${dispatch.cleanContinuationId}, rebuilt ${rebuiltCandidates.join(',') || 'none'})`);
        }
        return prompt;
    }
    const evidenceContext = managed.activeObjective && (pending.validationGaps?.length
        || managed.activeObjective.terminalReconciliation)
        ? buildObjectiveValidationEvidenceContext(managed.messages, managed.activeObjective, managed.id)
        : undefined;
    const authenticatedAnswer = sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true);
    const authenticatedAnswerContext = authenticatedAnswer?.responseMessageId === pending.userMessageId
        && dispatch.carriedUserInputResponseId === authenticatedAnswer.responseMessageId
        && authenticatedAnswer.answers?.length
        ? userInputAnswerMessageContent(authenticatedAnswer.id, authenticatedAnswer.questions, authenticatedAnswer.answers)
        : undefined;
    return [
        buildAutomaticTurnRecoveryPrompt(pending, dispatch.cause, evidenceContext, dispatch.attempt, isLegacyHostObjectiveContractEnabled(managed) ? managed.activeObjective : undefined),
        authenticatedAnswerContext,
        dispatch.fallbackIntent ? buildAutonomyFallbackPrompt(dispatch.fallbackIntent) : undefined,
    ].filter(Boolean).join('\n\n');
}

export { sessionOpGetPendingUserInputResponse as getPendingUserInputResponse };
export { sessionOpIsExactRepurposedUserInputCleanBoundary as isExactRepurposedUserInputCleanBoundary };
export { sessionOpBuildRecoveryDispatchMessage as buildRecoveryDispatchMessage };
