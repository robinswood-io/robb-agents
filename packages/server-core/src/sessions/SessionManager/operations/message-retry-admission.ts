import { assertRetryTurnAnchor } from '../policy.ts';
import type { UserInputRequest } from '@craft-agent/core';
import { RetryTurnAlreadyRunningError } from '../runtime-policy.ts';
import { assertRetryTurnUnblocked as sessionOpAssertRetryTurnUnblocked } from './create-autonomous-context-limit-handoff.ts';
import { canRetryRetainedMachineInbox as sessionOpCanRetryRetainedMachineInbox, hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { retryableContextLimitRequest as sessionOpRetryableContextLimitRequest } from './retryable-context-limit-request.ts';
import { exactUserInputResponse as sessionOpExactUserInputResponse } from './exact-user-input-response.ts';
import type { MessageRetryAdmissionInput } from './message-retry-admission-input.ts';

export function resolveMessageRetryAdmission(
    input: MessageRetryAdmissionInput
) {
    const {
        activeMessageState,
        sessionOperationContext,
        managed,
        explicitRetryIntentAtEntry,
        existingMessageId,
        sessionId,
        explicitRetryAllowanceToken,
    } = input;
const explicitRetry = activeMessageState.options?.automaticRecovery?.cause === 'user_retry';
    const retryWithRetainedInbox = explicitRetry && sessionOpCanRetryRetainedMachineInbox(sessionOperationContext, managed);
    const explicitRetryIntent = explicitRetryIntentAtEntry;
    const cleanExplicitRetry = !!explicitRetry && !existingMessageId && !!explicitRetryIntent
        && explicitRetryIntent.cleanBoundaryMessageId === activeMessageState.options?.automaticRecovery?.dispatchId
        && explicitRetryIntent.cleanContinuationId === activeMessageState.options?.automaticRecovery?.cleanContinuationId;
    const cleanRetryWithRetainedMachineInbox = cleanExplicitRetry
        && explicitRetryIntent?.allowRetainedMachineInbox === true
        && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed);
    let explicitRetryContextLimitRequest: UserInputRequest | undefined;
    let explicitRetryContextLimitRequestBefore: Pick<UserInputRequest, 'status' | 'answeredAt'> | undefined;
    if (explicitRetry) {
        if ((!cleanExplicitRetry && (!existingMessageId
            || existingMessageId !== activeMessageState.options?.automaticRecovery?.originalUserMessageId))
            || !sessionOperationContext.state.retryTurnsInFlight.has(sessionId)) {
            throw new Error('Use the retry command to resume an existing user turn');
        }
        assertRetryTurnAnchor(managed, activeMessageState.options!.automaticRecovery!.originalUserMessageId);
        if (cleanExplicitRetry) {
            const expectedRequestId = explicitRetryIntent!.contextLimitRequestId;
            if (expectedRequestId) {
                const candidate = sessionOpRetryableContextLimitRequest(sessionOperationContext, managed);
                if (!candidate || candidate.id !== expectedRequestId) {
                    throw new Error('The context-limit Retry prompt no longer owns this objective');
                }
                explicitRetryContextLimitRequest = candidate;
                explicitRetryContextLimitRequestBefore = {
                    status: candidate.status,
                    answeredAt: candidate.answeredAt,
                };
                sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed, false, candidate.id);
            }
            else {
                sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed, false, undefined, cleanRetryWithRetainedMachineInbox);
            }
        }
        else {
            sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed);
        }
        if (managed.isProcessing || managed.agent?.isProcessing()) {
            throw new RetryTurnAlreadyRunningError('The session is already processing');
        }
        if (explicitRetryAllowanceToken) {
            const intent = explicitRetryIntent;
            if (!intent || intent.sessionId !== sessionId || intent.userMessageId !== existingMessageId
                && intent.userMessageId !== activeMessageState.options?.automaticRecovery?.originalUserMessageId
                || intent.objectiveId !== (managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId)
                || intent.cancellationEpoch !== (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0)) {
                throw new Error('The explicit Retry allowance no longer belongs to this objective');
            }
        }
    }
    // Only the private existing-message dispatch seam can carry a validated human
    // answer. Public sendMessage options alone cannot impersonate this authority.
    const trustedUserInput = sessionOpExactUserInputResponse(sessionOperationContext, managed, existingMessageId, activeMessageState.message, activeMessageState.options);
    if (activeMessageState.options?.internalOrigin?.kind === 'user-input' && !trustedUserInput) {
        throw new Error('User answers must be submitted through the question response endpoint');
    }
    return {
        explicitRetry,
        retryWithRetainedInbox,
        explicitRetryIntent,
        cleanExplicitRetry,
        cleanRetryWithRetainedMachineInbox,
        explicitRetryContextLimitRequest,
        explicitRetryContextLimitRequestBefore,
        trustedUserInput,
    };
}
