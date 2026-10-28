import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { queuedDirectHumanContinuationIndexForId, cancelSourceActivationPending, commitSourceActivationPending, projectLegacyObjectiveForUserTransition, isLegacyHostObjectiveContractEnabled, rehydrateObjectiveEvidence } from '../policy.ts';
import { canSteerTextPayload } from '../../mid-stream-delivery';
import { resolveSessionConnection } from '@craft-agent/shared/agent/backend';
import { resolveMidStreamBehavior, resolveAgentCostControlPolicy } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { Message } from '@craft-agent/core/types';
import { createPendingTurnRecovery } from '../../turn-recovery';
import { appendCoalescedInternalMessage, selectInternalMessageCoalesceTarget } from '../../internal-message-coalescing';
import { isHostSyntheticObjectiveText, transitionObjectiveContract } from '../../objective-contract';
import { delegatedObjectiveRoleForSession } from '../review-lifecycle.ts';
import { sessionLog } from '../runtime-platform.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, dropDeferredSourceActivations as sessionOpDropDeferredSourceActivations } from './repair-legacy-synthetic-objective-authority.ts';
import { removeInFlightSyntheticAutomaticMessages as sessionOpRemoveInFlightSyntheticAutomaticMessages } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries, grantLiveDirectHumanContinuation as sessionOpGrantLiveDirectHumanContinuation } from './create-autonomous-context-limit-handoff.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { settleQueuedAgentDeliveryDispatch as sessionOpSettleQueuedAgentDeliveryDispatch, completeQueuedAgentDeliveryDispatch as sessionOpCompleteQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import { exactQueuedAgentDeliveryReceipt as sessionOpExactQueuedAgentDeliveryReceipt, buildObjectiveRuntimePrompt as sessionOpBuildObjectiveRuntimePrompt } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { captureUserCorrection as sessionOpCaptureUserCorrection } from './capture-user-correction.ts';
import type { QueuedMessageInput } from './queued-message-input.ts';
import { checkQueuedDeliveryCapacity } from './queued-delivery-capacity.ts';
import { persistQueuedMessage } from './persist-queued-message.ts';

export async function enqueueSessionMessage(input: QueuedMessageInput): Promise<void> {
    const {
        existingMessageId,
        trustedUserInput,
        managed,
        message,
        attachments,
        storedAttachments,
        options,
        sessionOperationContext,
        queuedDispatchToken,
        sessionId,
        onAck,
        waitingForInbox,
        forceDirectHumanQueue,
        durableMessageId,
        deliveryId,
        authenticatedSourceActivation,
        sourceActivationDispatchToken,
        directHumanStopWon,
        sourceActivationOrigin,
        sourceActivationStillCurrent,
        queueCostLimitContinuationBehindDelivery,
    } = input;
    // A user turn may win the race while a dequeued message is awaiting
    // hydration. Put back the same record instead of manufacturing a copy.
    if (existingMessageId && !trustedUserInput) {
        const existing = managed.messages.find(m => m.id === existingMessageId);
        if (!existing)
            throw new Error(`Existing message ${existingMessageId} not found`);
        existing.isQueued = true;
        if (!managed.messageQueue.some(item => item.messageId === existingMessageId)) {
            managed.messageQueue.unshift({ message, ...(attachments !== undefined ? { attachments: attachments } : {}), ...(storedAttachments !== undefined ? { storedAttachments: storedAttachments } : {}), ...(options !== undefined ? { options: options } : {}), messageId: existingMessageId });
        }
        sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext, existingMessageId, queuedDispatchToken);
        sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        onAck?.(existingMessageId);
        return;
    }
    if (!options?.hidden) {
        managed.autonomyFallbackAttemptedTools = new Set();
    }
    const connection = resolveSessionConnection(managed.llmConnection, undefined);
    // Fallback to 'steer' when no connection is resolvable — preserves
    // today's exact behavior (call redirect, take whatever it returns).
    const isInternalMessage = Boolean(options?.internalOrigin) && !trustedUserInput;
    // A question answer must be consumed as a durable turn. A backend may
    // accept redirect() just before completion yet never read that steer;
    // late undelivered feedback can arrive after the complete event. Keep
    // the answer queued until its existing record is actually dispatched.
    const behavior = waitingForInbox || trustedUserInput || isInternalMessage || forceDirectHumanQueue ? 'queue'
        : connection ? resolveMidStreamBehavior(connection) : 'steer';
    const userMessage: Message = trustedUserInput
        ? managed.messages.find(candidate => candidate.id === existingMessageId)!
        : {
            // A queued automatic recovery must keep the same host-issued identity
            // as its durable dispatch. Cold restore can then distinguish that
            // exact synthetic FIFO row from user-input and agent deliveries.
            id: durableMessageId(),
            role: 'user',
            content: message,
            timestamp: sessionOpMonotonic(sessionOperationContext),
            ...(storedAttachments !== undefined ? { attachments: storedAttachments } : {}),
            ...(options?.badges !== undefined ? { badges: options?.badges } : {}),
            ...(options?.hidden ? { hidden: true } : {}),
            ...(options?.internalOrigin ? { internalOrigin: options.internalOrigin } : {}),
            ...(options?.internalOrigin?.deliveryId ? {
                isQueued: true,
                agentDelivery: { id: options.internalOrigin.deliveryId, status: 'queued' as const, attempts: 0, ...(options.internalOrigin.attachmentsSha256 !== undefined ? { attachmentsSha256: options.internalOrigin.attachmentsSha256 } : {}) },
            } : {}),
        };
    const steeredObjective = trustedUserInput ? managed.activeObjective
        : !options?.hidden && !options?.internalOrigin && !isHostSyntheticObjectiveText(message) ? transitionObjectiveContract({
            existing: projectLegacyObjectiveForUserTransition(managed),
            messageId: userMessage.id,
            text: message,
            ...(managed.tokenUsage?.costUsd !== undefined ? { lifetimeCostUsd: managed.tokenUsage?.costUsd } : {}),
            ...(managed.tokenUsage?.totalTokens !== undefined ? { lifetimeTokens: managed.tokenUsage?.totalTokens } : {}),
            delegatedRole: delegatedObjectiveRoleForSession(managed),
        }) : undefined;
    const agent = managed.agent;
    let steered = false;
    let finishToolAdmissionRebind: ((committed: boolean) => void) | undefined;
    const steeringMessage = steeredObjective && isLegacyHostObjectiveContractEnabled(managed)
        ? `${message}\n\n${sessionOpBuildObjectiveRuntimePrompt(sessionOperationContext, managed, steeredObjective)}`
        : message;
    // Redirect transports only text. Keep attachments and model-input options
    // on the durable full-payload queue even when this connection prefers steer.
    const steerablePayload = canSteerTextPayload(attachments, storedAttachments, options);
    if (behavior === 'steer' && steerablePayload) {
        steered = agent?.redirect(steeringMessage) ?? false;
    }
    // For 'queue': skip redirect entirely. The current turn is undisturbed.
    sessionLog.info('mid-stream send', {
        sessionId,
        behavior,
        steered,
        queueLengthBefore: managed.messageQueue.length,
        backend: agent ? agent.constructor.name : 'none',
        connectionSlug: connection?.slug,
    });
    if (isInternalMessage && !deliveryId
        && options?.internalOrigin?.kind !== 'source-activation') {
        const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
        const maxQueuedMessages = resolveAgentCostControlPolicy(workspaceConfig?.costControl)
            .coordination.maxQueuedMessages;
        const senderSessionId = options?.internalOrigin?.senderSessionId;
        const coalesceTarget = selectInternalMessageCoalesceTarget(managed.messageQueue, senderSessionId, maxQueuedMessages);
        if (coalesceTarget) {
            appendCoalescedInternalMessage(coalesceTarget, message);
            const existingQueuedMessage = coalesceTarget.messageId
                ? managed.messages.find(existing => existing.id === coalesceTarget.messageId)
                : undefined;
            if (existingQueuedMessage)
                existingQueuedMessage.content = coalesceTarget.message;
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            if (coalesceTarget.messageId)
                onAck?.(coalesceTarget.messageId);
            sessionLog.info('coalesced internal agent update', {
                sessionId,
                senderSessionId,
                queueLength: managed.messageQueue.length,
            });
            return;
        }
    }
    if (isInternalMessage && deliveryId
        && options?.internalOrigin?.kind === 'agent-message'
        && options.internalOrigin.agentMessageType === 'progress'
        && options.internalOrigin.senderSessionId
        && !options.internalOrigin.attachmentsSha256
        && !storedAttachments?.length) {
        const senderSessionId = options.internalOrigin.senderSessionId;
        const coalesceCandidate = [...managed.messageQueue].reverse().find(candidate => {
            const origin = candidate.options?.internalOrigin;
            if (origin?.kind !== 'agent-message'
                || origin.senderSessionId !== senderSessionId
                || origin.agentMessageType !== 'progress'
                || origin.attachmentsSha256)
                return false;
            const receipt = sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, candidate);
            return !!receipt
                && !sessionOperationContext.state.queuedAgentDeliveryDispatches.has(receipt.id)
                && managed.messages.every(existing => existing === receipt || existing.agentDelivery?.id !== deliveryId);
        });
        const receipt = coalesceCandidate
            ? sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, coalesceCandidate)
            : undefined;
        if (coalesceCandidate && receipt?.agentDelivery && receipt.internalOrigin?.kind === 'agent-message') {
            appendCoalescedInternalMessage(coalesceCandidate, message);
            receipt.content = coalesceCandidate.message;
            coalesceCandidate.options!.internalOrigin!.deliveryId = deliveryId;
            receipt.internalOrigin.deliveryId = deliveryId;
            receipt.agentDelivery.id = deliveryId;
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            onAck?.(receipt.id);
            sessionLog.info('coalesced queued agent progress delivery', {
                sessionId,
                senderSessionId,
                deliveryId,
                queueLength: managed.messageQueue.length,
            });
            return;
        }
    }
    const yieldingRecoveries = checkQueuedDeliveryCapacity(input);
    userMessage.isQueued = !steered;
    if (!trustedUserInput)
        managed.messages.push(userMessage);
    const pendingSourceActivationForQueue = managed.autoRetryPending;
    if (authenticatedSourceActivation && pendingSourceActivationForQueue
        && pendingSourceActivationForQueue.dispatchToken === sourceActivationDispatchToken) {
        pendingSourceActivationForQueue.messageId = userMessage.id;
    }
    if (steered && steeredObjective) {
        const cancelledQuestions = !trustedUserInput && managed.activeObjective?.userMessageId !== steeredObjective.userMessageId
            ? sessionOperationContext.owner["cancelPendingUserInput"](managed, true) : undefined;
        managed.pendingUserSteers ??= new Map();
        managed.pendingUserSteers.set(steeringMessage, {
            queued: { message, ...(attachments !== undefined ? { attachments: attachments } : {}), ...(storedAttachments !== undefined ? { storedAttachments: storedAttachments } : {}), ...(options !== undefined ? { options: options } : {}), messageId: userMessage.id, ...(options?.optimisticMessageId !== undefined ? { optimisticMessageId: options?.optimisticMessageId } : {}) },
            ...(managed.activeObjective !== undefined ? { objectiveBefore: managed.activeObjective } : {}),
            objectiveAfter: steeredObjective,
            ...(managed.pendingTurnRecovery !== undefined ? { recoveryBefore: managed.pendingTurnRecovery } : {}),
        });
        // The accepted user message and its host-side contract must move
        // together. Queued messages do not supersede the running objective.
        const sameActiveObjective = managed.activeObjective?.terminalState === 'active'
            && managed.activeObjective.userMessageId === steeredObjective.userMessageId;
        managed.activeObjective = steeredObjective;
        managed.pendingTurnRecovery = sameActiveObjective && managed.pendingTurnRecovery
            ? { ...managed.pendingTurnRecovery, userMessageId: userMessage.id }
            : createPendingTurnRecovery(userMessage.id);
        managed.lastSentMessage = message;
        managed.lastSentAttachments = attachments;
        managed.lastSentStoredAttachments = storedAttachments;
        managed.lastSentOptions = options;
        rehydrateObjectiveEvidence(managed);
        const admissionBinding = agent ? sessionOperationContext.state.runtimeToolAdmissionBindings.get(agent) : undefined;
        if (admissionBinding && admissionBinding.managed === managed
            && admissionBinding.generation === managed.processingGeneration) {
            let releaseRebind!: () => void;
            const rebindStep = new Promise<void>(resolve => { releaseRebind = resolve; });
            const precedingRebind = admissionBinding.pendingRebind;
            const rebindChain = precedingRebind
                ? precedingRebind.then(() => rebindStep)
                : rebindStep;
            admissionBinding.pendingRebind = rebindChain;
            finishToolAdmissionRebind = committed => {
                if (committed
                    && sessionOperationContext.state.sessions.get(managed.id) === managed
                    && managed.agent === agent
                    && managed.isProcessing
                    && admissionBinding.generation === managed.processingGeneration
                    && managed.activeObjective === steeredObjective
                    && managed.messages.filter(candidate => candidate.role === 'user').at(-1) === userMessage) {
                    admissionBinding.activeObjective = steeredObjective;
                    admissionBinding.authorityEpoch = sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0;
                    admissionBinding.userMessage = userMessage;
                    admissionBinding.userMessageId = userMessage.id;
                    admissionBinding.messageCountAtHandoff = managed.messages.length;
                    admissionBinding.lastSentOptions = options;
                    admissionBinding.automaticRecovery = options?.automaticRecovery;
                    admissionBinding.pendingTurnRecovery = managed.pendingTurnRecovery;
                    admissionBinding.recoveryDispatch = managed.pendingTurnRecovery?.recoveryDispatch;
                    delete admissionBinding.liveToolFallbackIntent;
                }
                releaseRebind();
                void rebindChain.finally(() => {
                    if (admissionBinding.pendingRebind === rebindChain)
                        delete admissionBinding.pendingRebind;
                });
            };
        }
        if (cancelledQuestions) {
            try {
                await cancelledQuestions;
            }
            catch (error) {
                finishToolAdmissionRebind?.(false);
                throw error;
            }
        }
    }
    // Emit to UI — 'accepted' iff a steer succeeded; 'queued' otherwise
    // (covers both queue-direct and queue-after-abort paths).
    sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'user_message' }>>({
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: steered ? 'accepted' : 'queued',
        optimisticMessageId: options?.optimisticMessageId
    }), managed.workspace.id);
    if (!steered) {
        // Push for FIFO replay on next onProcessingStopped tick. Same shape
        // for both queue-direct (current turn still running) and
        // queue-after-abort (backend already aborted) — the replay path in
        // processNextQueuedMessage is identical.
        const queuedMessage = { message, attachments, storedAttachments, options, messageId: userMessage.id, optimisticMessageId: options?.optimisticMessageId };
        if (yieldingRecoveries.length) {
            // Only a delivery from the exact delegated lineage may move the
            // synthetic wait. Keep every real inbox record in acceptance order
            // and retain the already-budgeted recovery behind it. Synthetic
            // recovery does not consume the child's one durable delivery slot.
            const yieldingSet = new Set(yieldingRecoveries);
            managed.messageQueue = managed.messageQueue.filter(item => !yieldingSet.has(item));
            managed.messageQueue.push(queuedMessage);
            managed.messageQueue.push(...yieldingRecoveries);
        }
        else
            managed.messageQueue.push(queuedMessage);
        if (!isInternalMessage && !trustedUserInput && behavior === 'steer' && steerablePayload)
            managed.wasInterrupted = true;
        if (!options?.hidden && !isInternalMessage && !trustedUserInput) {
            // A visible human continuation supersedes a pre-chat automatic
            // recovery immediately. Its own acknowledgement flush must persist
            // removal of the exact hidden row even if the older recovery flush
            // never resumes before the process exits.
            sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext, managed);
            sessionOpRemoveInFlightSyntheticAutomaticMessages(sessionOperationContext, managed);
        }
    }
    const { finishFreshAgentDeliveryAppend, fenceDirectContinuation, rejectStoppedDirectContinuation } = await persistQueuedMessage(input, steered, userMessage, steeringMessage, finishToolAdmissionRebind);
    if (options?.internalOrigin?.kind === 'agent-message' && !existingMessageId
        && sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)) {
        const terminalState = managed.activeObjective?.terminalState;
        const queuedIndex = managed.messageQueue.findIndex(item => item.messageId === userMessage.id);
        const messageIndex = managed.messages.indexOf(userMessage);
        const untouchedQueuedReceipt = messageIndex >= 0
            && userMessage.isQueued === true && userMessage.agentDelivery?.status === 'queued';
        const exactDequeuedDispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(userMessage.id);
        const exactUnclaimedDequeue = exactDequeuedDispatch?.sessionId === sessionId
            && exactDequeuedDispatch.deliveryId === userMessage.agentDelivery?.id
            && exactDequeuedDispatch.claimed === false;
        try {
            if (untouchedQueuedReceipt && (queuedIndex >= 0 || exactUnclaimedDequeue)) {
                // The recipient terminalized while the first durable queue write was
                // in flight. The row may still be in FIFO, or processNextQueuedMessage
                // may have removed it while its deferred dispatch remains unclaimed.
                // Invalidate that reservation and roll back only a receipt whose
                // durable status is still queued. A receipt already advanced to
                // processing belongs to that dispatch and must not be removed here.
                if (queuedIndex >= 0)
                    managed.messageQueue.splice(queuedIndex, 1);
                if (exactUnclaimedDequeue) {
                    if (sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === exactDequeuedDispatch.dispatchToken) {
                        sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
                        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
                    }
                    else if (!sessionOperationContext.state.queuedMessageDispatches.has(sessionId) && !managed.isProcessing) {
                        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
                    }
                    sessionOpCompleteQueuedAgentDeliveryDispatch(sessionOperationContext, userMessage.id, exactDequeuedDispatch.dispatchToken);
                }
                managed.messages.splice(messageIndex, 1);
                sessionOperationContext.owner["persistSession"](managed);
                await sessionOperationContext.owner.flushSession(managed.id);
            }
        }
        finally {
            finishFreshAgentDeliveryAppend();
        }
        throw new Error(`Target session objective is terminal (${terminalState}); no agent message was queued. Reuse its completed result. A new delegation is valid only when the objective or version genuinely changed, and grants no new authority.`);
    }
    finishFreshAgentDeliveryAppend();
    if (sourceActivationOrigin) {
        const sourceAccepted = sourceActivationStillCurrent()
            && (!authenticatedSourceActivation
                || commitSourceActivationPending(managed, sourceActivationDispatchToken, userMessage.id));
        if (!sourceAccepted) {
            cancelSourceActivationPending(managed);
            sessionOpDropDeferredSourceActivations(sessionOperationContext, managed, true);
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            return;
        }
    }
    // A provider-accepted steer is durable but intentionally has no FIFO
    // row (`isQueued=false`). Only the queue path needs the exact-row
    // capability check before it may wake a closed/interrupted session.
    // Applying that check to a steer drops its acknowledgement and skips
    // correction learning even though the flush above already committed it.
    if (fenceDirectContinuation && directHumanStopWon()) {
        await rejectStoppedDirectContinuation();
    }
    if (fenceDirectContinuation && (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.sessions.get(sessionId) !== managed
        || (!steered
            && queuedDirectHumanContinuationIndexForId(managed, userMessage.id) < 0))) {
        return;
    }
    if (fenceDirectContinuation && !steered) {
        sessionOpGrantLiveDirectHumanContinuation(sessionOperationContext, managed, userMessage.id);
    }
    onAck?.(userMessage.id);
    if (steered && !options?.hidden && !options?.internalOrigin) {
        const correctionGeneration = managed.processingGeneration;
        await sessionOpCaptureUserCorrection(sessionOperationContext, managed, userMessage);
        if (sessionOperationContext.state.shuttingDown || managed.stopRequested || managed.processingGeneration !== correctionGeneration)
            return;
    }
    // The old provider may finish synchronously when its permission is
    // denied above. Its stop callback sees the durability fence and cannot
    // dequeue yet, so retry the exact-capability drain after the flush.
    if (!managed.isProcessing && !managed.stopRequested
        && (waitingForInbox || fenceDirectContinuation || queueCostLimitContinuationBehindDelivery)) {
        sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
    }
    return;
}
