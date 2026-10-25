import type { SessionOperationContext } from '../operation-context.ts';
import { recoveredInternalMessageOptions } from '../../agent-delivery.ts';
import { normalizeUserInputResponse } from '@craft-agent/core';
import type { UserInputResponse, UserInputResponseResult } from '@craft-agent/core';
import { AbortReason } from '@craft-agent/shared/agent';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import { DELEGATED_TERMINAL_RESULT_PROTOCOL } from '../runtime-policy.ts';
import { userInputAnswerMessageContent } from '../user-input-authority.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { deliverUserInputAnswer as sessionOpDeliverUserInputAnswer, wakeQueuedQuestionAncestors as sessionOpWakeQueuedQuestionAncestors, emitUserInputChanged as sessionOpEmitUserInputChanged } from './perform-request-user-input.ts';
import { clearDelegatedTerminalResultRetry as sessionOpClearDelegatedTerminalResultRetry } from './ensure-delegated-terminal-result-delivery.ts';
import { isCurrentDelegatedDescendant as sessionOpIsCurrentDelegatedDescendant } from './is-current-delegated-descendant.ts';
import { cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries } from './create-autonomous-context-limit-handoff.ts';
import { untrackSyntheticAutomaticMessage as sessionOpUntrackSyntheticAutomaticMessage, removeInFlightSyntheticAutomaticMessages as sessionOpRemoveInFlightSyntheticAutomaticMessages } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';

async function sessionOpRespondToUserInput(sessionOperationContext: SessionOperationContext, sessionId: string, value: UserInputResponse, rpcContext?: {
    callerClientId?: string;
}): Promise<UserInputResponseResult> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        throw new Error('Question session not found');
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformRespondToUserInput(sessionOperationContext, managed, value, rpcContext));
}

async function sessionOpPerformRespondToUserInput(sessionOperationContext: SessionOperationContext, managed: ManagedSession, value: UserInputResponse, rpcContext?: {
    callerClientId?: string;
}): Promise<UserInputResponseResult> {
    const sessionId = managed.id;
    if (sessionOperationContext.state.providerRetryReconciliationTransactions.has(sessionId)
        || sessionOperationContext.state.providerLiveReconciliationTransactions.has(sessionId)) {
        throw new Error('Provider reconciliation is still being persisted; answer the question after it completes');
    }
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    const request = managed.userInputRequests?.find(candidate => candidate.id === value?.requestId);
    if (!request || request.sessionId !== managed.id || request.originWorkspaceId !== managed.workspace.id) {
        throw new Error('Question request does not belong to this session and workspace');
    }
    const response = normalizeUserInputResponse(request, value);
    if (request.status !== 'pending') {
        if (request.status === 'cancelled' && !response.cancelled && response.answers && response.answers.length > 0) {
            request.status = 'pending';
        }
        else {
            const same = request.status === 'cancelled' ? response.cancelled === true
                : !response.cancelled && JSON.stringify(request.answers) === JSON.stringify(response.answers);
            if (!same)
                throw new Error('This question already has a different response');
            const inFlight = sessionOperationContext.state.userInputResponsesInFlight.get(request.id);
            if (inFlight)
                return inFlight;
            const queuedAnswer = request.responseMessageId
                ? managed.messages.find(message => message.id === request.responseMessageId && message.isQueued
                    && message.internalOrigin?.kind === 'user-input') : undefined;
            if (queuedAnswer && !managed.messageQueue.some(item => item.messageId === queuedAnswer.id)
                && !sessionOperationContext.state.queuedMessageDispatches.has(managed.id)) {
                return sessionOpDeliverUserInputAnswer(sessionOperationContext, managed, request, queuedAnswer, rpcContext);
            }
            // Re-acknowledge only after durability; never deliver a duplicate human answer.
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            sessionOpWakeQueuedQuestionAncestors(sessionOperationContext, managed);
            return { status: request.status === 'cancelled' ? 'cancelled' : 'already_answered', responseMessageId: request.responseMessageId };
        }
    }
    const delegatedTerminalRetryQuestion = request.questions.length === 1
        ? request.questions[0]
        : undefined;
    if (response.cancelled) {
        request.status = 'cancelled';
        request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
        if (delegatedTerminalRetryQuestion?.id.startsWith('retry-child-result-')) {
            const failedReceipt = managed.messages.find(message => (message.role === 'user'
                && message.agentDelivery?.status === 'failed'
                && message.agentDelivery.attempts >= 3
                && message.internalOrigin?.kind === 'agent-message'
                && message.content.startsWith(DELEGATED_TERMINAL_RESULT_PROTOCOL)
                && `retry-child-result-${message.internalOrigin.senderSessionId}`.slice(0, 80)
                    === delegatedTerminalRetryQuestion.id));
            if (failedReceipt?.agentDelivery) {
                // Cancelling this exact host question is an explicit decision not to
                // deliver the retained child result. Consume the receipt as a host
                // acknowledgement and terminalize the bound parent objective so a
                // timer cannot recreate the same one-choice prompt forever.
                failedReceipt.agentDelivery.status = 'processed';
                failedReceipt.isQueued = false;
                managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== failedReceipt.id);
                const senderSessionId = failedReceipt.internalOrigin?.kind === 'agent-message'
                    ? failedReceipt.internalOrigin.senderSessionId : undefined;
                if (senderSessionId)
                    sessionOpClearDelegatedTerminalResultRetry(sessionOperationContext, senderSessionId);
                if (managed.activeObjective?.terminalState === 'active'
                    && request.objectiveUserMessageId === managed.activeObjective.userMessageId) {
                    managed.activeObjective.terminalState = 'exhausted';
                    managed.activeObjective.completedAt = Date.now();
                    sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
                    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
                    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
                }
            }
        }
        if (!managed.isProcessing)
            sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        sessionOpEmitUserInputChanged(sessionOperationContext, managed);
        sessionOpWakeQueuedQuestionAncestors(sessionOperationContext, managed);
        return { status: 'cancelled' };
    }
    if (delegatedTerminalRetryQuestion?.id.startsWith('retry-child-result-')
        && response.answers?.[0]?.optionIds.includes('retry-delivery')) {
        const failedReceipt = managed.messages.find(message => (message.role === 'user'
            && message.agentDelivery?.status === 'failed'
            && message.agentDelivery.attempts >= 3
            && message.internalOrigin?.kind === 'agent-message'
            && message.content.startsWith(DELEGATED_TERMINAL_RESULT_PROTOCOL)
            && `retry-child-result-${message.internalOrigin.senderSessionId}`.slice(0, 80)
                === delegatedTerminalRetryQuestion.id));
        if (!failedReceipt?.agentDelivery) {
            throw new Error('The delegated terminal result receipt is no longer available for retry');
        }
        const senderSessionId = failedReceipt.internalOrigin?.kind === 'agent-message'
            ? failedReceipt.internalOrigin.senderSessionId
            : undefined;
        const sender = senderSessionId ? sessionOperationContext.state.sessions.get(senderSessionId) : undefined;
        const currentObjective = managed.activeObjective;
        if (!currentObjective || !request.objectiveUserMessageId
            || request.objectiveUserMessageId !== currentObjective.userMessageId
            || currentObjective.terminalState !== 'active'
            || !sender || !sessionOpIsCurrentDelegatedDescendant(sessionOperationContext, managed, sender)) {
            // Consume the obsolete UI capability without reviving either the old
            // receipt or objective. A repeated response remains an idempotent
            // cancelled acknowledgement rather than a permanent pending prompt.
            request.status = 'cancelled';
            request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            sessionOpEmitUserInputChanged(sessionOperationContext, managed);
            throw new Error('The delegated terminal result belongs to an objective that is no longer active');
        }
        request.status = 'answered';
        request.answers = response.answers;
        request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
        // Preserve replay provenance: the dequeue increments this to two, which
        // activates the cross-tool mutation quarantine before any tool call.
        failedReceipt.agentDelivery = { ...failedReceipt.agentDelivery, status: 'queued', attempts: 1 };
        failedReceipt.isQueued = true;
        if (!managed.messageQueue.some(item => item.messageId === failedReceipt.id)) {
            managed.messageQueue.push({
                message: failedReceipt.content,
                messageId: failedReceipt.id,
                storedAttachments: failedReceipt.attachments,
                options: recoveredInternalMessageOptions(failedReceipt),
            });
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        sessionOpEmitUserInputChanged(sessionOperationContext, managed);
        sessionOpWakeQueuedQuestionAncestors(sessionOperationContext, managed);
        if (!managed.isProcessing)
            sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
        return { status: 'accepted', delivery: 'queued' };
    }
    const hostObjectiveStopQuestion = request.questions.length === 1
        && (request.questions[0]?.id === 'automatic-recovery-next-step'
            || request.questions[0]?.id === 'clean-continuation-unavailable'
            || request.questions[0]?.id === 'context-limit-next-step'
            || request.questions[0]?.id === 'cost-limit-next-step')
        ? request.questions[0]
        : undefined;
    const hostObjectiveStopSelected = !!hostObjectiveStopQuestion
        && response.answers?.some(answer => (answer.questionId === hostObjectiveStopQuestion.id
            && answer.optionIds.includes('stop-objective'))) === true;
    if (hostObjectiveStopSelected) {
        const objective = managed.activeObjective;
        if (!objective || !request.objectiveUserMessageId
            || request.objectiveUserMessageId !== objective.userMessageId
            || objective.terminalState !== 'active') {
            throw new Error('The objective has changed; this stop choice cannot affect it');
        }
        // `stop-objective` is a host authority decision, not guidance for the
        // provider. Fence the current generation before yielding, terminalize
        // the exact objective, and revoke only synthetic automatic work. No
        // hidden answer turn is created and no model/tool call can interpret or
        // ignore this explicit choice.
        request.status = 'answered';
        request.answers = response.answers;
        request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
        sessionOperationContext.state.turnCancellationEpochs.set(managed, (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) + 1);
        sessionOperationContext.state.objectiveAuthorityEpochs.set(managed, (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) + 1);
        objective.terminalState = 'exhausted';
        objective.completedAt = Date.now();
        sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext, managed);
        // An explicit Stop also revokes queued `user_retry` envelopes. They are
        // normally preserved as human-authorized retries, but that older grant
        // cannot outlive this newer host-authenticated stop choice.
        const stoppedRecoveryRows = managed.messageQueue.filter(item => !!item.options?.automaticRecovery);
        managed.messageQueue = managed.messageQueue.filter(item => !item.options?.automaticRecovery);
        for (const item of stoppedRecoveryRows) {
            if (!item.messageId)
                continue;
            const saved = managed.messages.find(message => message.id === item.messageId);
            if (saved?.role !== 'user' || !saved.hidden || !saved.isQueued || saved.agentDelivery
                || saved.content !== item.message)
                continue;
            sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext, managed, saved);
            managed.messages.splice(managed.messages.indexOf(saved), 1);
        }
        sessionOpRemoveInFlightSyntheticAutomaticMessages(sessionOperationContext, managed);
        sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
        sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        if (managed.isProcessing) {
            managed.stopRequested = true;
            managed.wasInterrupted = true;
            managed.agent?.forceAbort(AbortReason.UserStop);
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        sessionOpEmitUserInputChanged(sessionOperationContext, managed);
        sessionOpWakeQueuedQuestionAncestors(sessionOperationContext, managed);
        return { status: 'accepted' };
    }
    if (request.objectiveUserMessageId !== managed.activeObjective?.userMessageId
        || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)) {
        throw new Error('The objective has changed; this answer cannot resume it');
    }
    const message: Message = {
        id: generateMessageId(), role: 'user', timestamp: sessionOpMonotonic(sessionOperationContext), hidden: true, isQueued: true,
        internalOrigin: { kind: 'user-input' },
        content: userInputAnswerMessageContent(request.id, request.questions, response.answers ?? []),
    };
    request.status = 'answered';
    request.answers = response.answers;
    request.answeredAt = Math.max(Date.now(), (request.answeredAt ?? 0) + 1);
    request.responseMessageId = message.id;
    managed.messages.push(message);
    // The answer and its queued model message share one durable session snapshot.
    // Setting the receipt before yielding also serializes simultaneous responses.
    return sessionOpDeliverUserInputAnswer(sessionOperationContext, managed, request, message, rpcContext);
}

export { sessionOpRespondToUserInput as respondToUserInput };
export { sessionOpPerformRespondToUserInput as performRespondToUserInput };
