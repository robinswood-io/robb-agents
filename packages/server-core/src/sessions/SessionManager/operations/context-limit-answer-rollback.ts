import { omitUndefined } from '@craft-agent/shared/utils/json';
import { validAllocatedRecoveryDispatch } from '../policy.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { buildCleanRecoveryContinuationPrompt } from '../../turn-recovery';
import { canonicalUserInputAnswerContents, isExactContextLimitNextStepQuestion } from '../user-input-authority.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage, isExactRepurposedUserInputCleanBoundary as sessionOpIsExactRepurposedUserInputCleanBoundary } from './user-input-recovery.ts';
import { boundCleanUserInputRequest as sessionOpBoundCleanUserInputRequest } from './context-limit-authenticated-answer-evidence.ts';
import { createContextLimitRetryHandoff as sessionOpCreateContextLimitRetryHandoff } from './create-context-limit-retry-handoff.ts';
import type { ObjectiveAdmissionInput } from './objective-admission-input.ts';

export function createContextLimitAnswerRollback(
    objectiveAdmissionInput: ObjectiveAdmissionInput,
    trustedContextLimitAnswer: UserInputRequest | undefined
): () => string | undefined {
    const {
        managed,
        activeMessageState,
        sessionOperationContext,
        userMessage,
        ownsActiveTurn,
        resetProviderResumeStateForCleanBoundary,
        sessionId,
        queuedDispatchToken,
    } = objectiveAdmissionInput;
    return () => {
    const matchingRequests = (managed.userInputRequests ?? []).filter(candidate => (candidate.status === 'answered'
        && candidate.responseMessageId === userMessage.id
        && candidate.sessionId === managed.id
        && candidate.originWorkspaceId === managed.workspace.id
        && candidate.objectiveUserMessageId === managed.activeObjective?.userMessageId));
    if (!ownsActiveTurn() || !trustedContextLimitAnswer
        || matchingRequests.length !== 1 || matchingRequests[0] !== trustedContextLimitAnswer
        || !managed.userInputRequests?.includes(trustedContextLimitAnswer)
        || trustedContextLimitAnswer.status !== 'answered'
        || trustedContextLimitAnswer.responseMessageId !== userMessage.id
        || trustedContextLimitAnswer.objectiveUserMessageId !== managed.activeObjective?.userMessageId
        || !trustedContextLimitAnswer.answers?.length
        || !isExactContextLimitNextStepQuestion(trustedContextLimitAnswer))
        return undefined;
    const pending = managed.pendingTurnRecovery;
    const started = pending?.recoveryDispatch;
    if (!pending || started?.phase !== 'started' || started.id !== userMessage.id
        || started.origin !== 'retry' || started.cause !== 'user_retry'
        || pending.userMessageId !== userMessage.id || pending.lastCause !== 'user_retry'
        || !Number.isFinite(started.startedAt))
        return undefined;
    const matches = managed.messages.flatMap((candidate, index) => (candidate.id === userMessage.id ? [{ candidate, index }] : []));
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match || match.candidate !== userMessage || match.index !== managed.messages.length - 1
        || userMessage.role !== 'user' || userMessage.hidden !== true
        || userMessage.isQueued || userMessage.isPending || userMessage.agentDelivery
        || userMessage.internalOrigin?.kind !== 'user-input'
        || (userMessage.attachments?.length ?? 0) > 0
        || managed.messageQueue.some(item => item.messageId === userMessage.id))
        return undefined;
    let allocatedDispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']> | undefined;
    let allocatedPending: PendingTurnRecovery | undefined;
    if (started.cleanContinuationId) {
        // This closure is reachable only from a setup catch before the first
        // provider event. Lifecycle telemetry may already have emitted an
        // autonomy event, so cold-restart inference is intentionally too
        // strict here. Authenticate the exact repurposed row, then derive the
        // allocated fixed point directly from the live no-provider seam.
        if (!sessionOpIsExactRepurposedUserInputCleanBoundary(sessionOperationContext, managed, trustedContextLimitAnswer, userMessage))
            return undefined;
        allocatedDispatch = { ...started, phase: 'allocated' as const };
        delete allocatedDispatch.startedAt;
        for (let iteration = 0; iteration < 4; iteration += 1) {
            const candidate: PendingTurnRecovery = {
                ...pending,
                recoveryDispatch: allocatedDispatch,
            };
            const contextLimit = sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, candidate);
            const autonomous = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, candidate);
            const matching = [autonomous, contextLimit].find(handoff => (handoff?.id === allocatedDispatch!.cleanContinuationId));
            if (matching) {
                if (validAllocatedRecoveryDispatch(candidate) !== allocatedDispatch
                    || sessionOpBoundCleanUserInputRequest(sessionOperationContext, managed, candidate) !== trustedContextLimitAnswer) {
                    return undefined;
                }
                allocatedPending = candidate;
                break;
            }
            const next = autonomous ?? contextLimit;
            if (!next)
                return undefined;
            allocatedDispatch = { ...allocatedDispatch, cleanContinuationId: next.id };
        }
    }
    else {
        const canonicalAnswers = canonicalUserInputAnswerContents(trustedContextLimitAnswer);
        if (!canonicalAnswers.includes(userMessage.content))
            return undefined;
        const cleanPending: PendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
            ...pending,
            cleanContinuationCount: (pending.cleanContinuationCount ?? 0) + 1,
            recoveryDispatch: undefined,
        });
        const provisionalHandoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, cleanPending);
        if (!provisionalHandoff)
            return undefined;
        const cleanDispatch = { ...started, cleanContinuationId: provisionalHandoff.id };
        delete cleanDispatch.fallbackIntent;
        const nextPending: PendingTurnRecovery = {
            ...cleanPending,
            recoveryDispatch: cleanDispatch,
            cleanContextBoundaryMessageId: userMessage.id,
        };
        const finalHandoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, nextPending);
        const cleanPrompt = finalHandoff && buildCleanRecoveryContinuationPrompt(finalHandoff);
        if (!finalHandoff || !cleanPrompt)
            return undefined;
        nextPending.recoveryDispatch = {
            ...cleanDispatch,
            cleanContinuationId: finalHandoff.id,
        };
        allocatedDispatch = {
            ...nextPending.recoveryDispatch,
            phase: 'allocated' as const,
        };
        delete allocatedDispatch.startedAt;
        // Changing started -> allocated is part of the deterministic handoff
        // identity. Rebind from host state without mutating the live session;
        // only the fully authenticated fixed point is committed below.
        for (let iteration = 0; iteration < 4; iteration += 1) {
            const candidate: PendingTurnRecovery = {
                ...nextPending,
                recoveryDispatch: allocatedDispatch,
            };
            const contextLimit = sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, candidate);
            const autonomous = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, candidate);
            const matching = [autonomous, contextLimit].find(handoff => (handoff?.id === allocatedDispatch!.cleanContinuationId));
            if (matching) {
                if (validAllocatedRecoveryDispatch(candidate) !== allocatedDispatch
                    || sessionOpBoundCleanUserInputRequest(sessionOperationContext, managed, candidate) !== trustedContextLimitAnswer) {
                    return undefined;
                }
                allocatedPending = candidate;
                break;
            }
            const next = autonomous ?? contextLimit;
            if (!next)
                return undefined;
            allocatedDispatch = { ...allocatedDispatch, cleanContinuationId: next.id };
        }
    }
    if (!allocatedDispatch || !allocatedPending)
        return undefined;
    let cleanPrompt: string;
    try {
        cleanPrompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, allocatedPending, allocatedDispatch);
    }
    catch {
        return undefined;
    }
    managed.messages.splice(match.index, 1);
    managed.pendingTurnRecovery = allocatedPending;
    activeMessageState.message = cleanPrompt;
    managed.lastSentMessage = cleanPrompt;
    managed.lastSentOptions = activeMessageState.options;
    resetProviderResumeStateForCleanBoundary(userMessage.id);
    managed.messageQueue = managed.messageQueue.filter(item => (item.messageId !== allocatedDispatch.id
        && item.options?.automaticRecovery?.dispatchId !== allocatedDispatch.id));
    if (sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === queuedDispatchToken) {
        sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
    }
    sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
    sessionOperationContext.owner["setProcessing"](managed, false);
    return allocatedDispatch.id;
};
}
