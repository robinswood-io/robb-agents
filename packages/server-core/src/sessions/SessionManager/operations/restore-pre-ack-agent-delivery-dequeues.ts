import type { SessionOperationContext } from '../operation-context.ts';
import { enqueueRecoveredMessageInTranscriptOrder, hasAuthenticatedObjectiveRoot } from '../policy.ts';
import { recoveredInternalMessageOptions } from '../../agent-delivery.ts';
import type { PendingTurnRecovery, ActiveSessionObjective } from '@craft-agent/shared/sessions';
import type { Message } from '@craft-agent/core/types';
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage';
import { YOLO_AUTONOMY_GUIDANCE } from '@craft-agent/shared/agent';
import { buildDelegatedReviewPrompt } from '../../delegated-review-outcome';
import { projectObjectiveAcceptanceCriteria } from '../../objective-acceptance-criteria';
import { formatLegacyAcceptanceScalarDiagnostic } from '../../legacy-acceptance-scalars';
import { formatLegacyGscSiteIdentity } from '../../legacy-gsc-site-identity';
import { isClosedSessionStatus } from '../../session-status-lifecycle';
import { createPendingTurnRecovery } from '../../turn-recovery';
import { buildObjectiveContractPrompt } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { isMissionRuntimeOwnedRecovery } from '../review-lifecycle.ts';
import { sessionLog } from '../runtime-platform.ts';
import { isExactContextLimitNextStepQuestion } from '../user-input-authority.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo } from './is-managed-session-yolo.ts';
import { isAutonomousMessage as sessionOpIsAutonomousMessage } from './is-current-delegated-descendant.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { hasBoundInterruptedTurnRecovery as sessionOpHasBoundInterruptedTurnRecovery } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { contextLimitAuthenticatedAnswerEvidence as sessionOpContextLimitAuthenticatedAnswerEvidence } from './context-limit-authenticated-answer-evidence.ts';

function sessionOpBuildObjectiveRuntimePrompt(sessionOperationContext: SessionOperationContext, managed: ManagedSession, objective: ActiveSessionObjective): string {
    const reviewPrompt = buildDelegatedReviewPrompt({ ...(managed.parentSessionId !== undefined ? { parentSessionId: managed.parentSessionId } : {}), objective,
        ...(managed.enabledSourceSlugs !== undefined ? { sourceSlugs: managed.enabledSourceSlugs } : {}), messages: managed.messages });
    if (reviewPrompt)
        return sessionOpIsManagedSessionYolo(sessionOperationContext, managed)
            ? `${reviewPrompt}\n\n${YOLO_AUTONOMY_GUIDANCE}` : reviewPrompt;
    const projection = projectObjectiveAcceptanceCriteria(objective, managed.messages);
    const contract = buildObjectiveContractPrompt(projection.diagnostic
        ? { ...objective, acceptanceCriteria: projection.criteria } : objective, managed.messages, { humanInputAllowed: !sessionOpIsManagedSessionYolo(sessionOperationContext, managed) });
    return [contract,
        projection.diagnostic && formatLegacyAcceptanceScalarDiagnostic(projection.diagnostic),
        projection.gscSiteIdentity && formatLegacyGscSiteIdentity(projection.gscSiteIdentity),
    ].filter(Boolean).join('\n\n');
}

function sessionOpHasOnlyMachineInbox(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    if (!managed.messageQueue.length || sessionOperationContext.state.queuedMessageDispatches.has(managed.id))
        return false;
    const queuedIds = new Set<string>();
    for (const item of managed.messageQueue) {
        if (!sessionOpIsAutonomousMessage(sessionOperationContext, item.options))
            return false;
        if (!item.messageId) {
            // Only an existing host recovery entry may have no transcript ID.
            if (!item.options?.automaticRecovery)
                return false;
            continue;
        }
        const saved = managed.messages.find(message => message.id === item.messageId);
        if (!saved || saved.role !== 'user' || !saved.isQueued || saved.isPending || saved.content !== item.message)
            return false;
        const origin = item.options?.internalOrigin;
        if (saved.internalOrigin) {
            if (saved.internalOrigin.kind === 'user-input' || !origin || origin.kind !== saved.internalOrigin.kind
                || origin.senderSessionId !== saved.internalOrigin.senderSessionId || origin.deliveryId !== saved.internalOrigin.deliveryId
                || origin.objectiveId !== saved.internalOrigin.objectiveId
                || origin.objectiveRevision !== saved.internalOrigin.objectiveRevision
                || origin.sourceSlug !== saved.internalOrigin.sourceSlug
                || origin.sourceActivationId !== saved.internalOrigin.sourceActivationId)
                return false;
            if (saved.agentDelivery && saved.agentDelivery.id !== origin.deliveryId)
                return false;
        }
        else if (!saved.hidden || !item.options?.hidden || origin || saved.agentDelivery)
            return false;
        queuedIds.add(saved.id);
    }
    return managed.messages.every(message => !message.isQueued || queuedIds.has(message.id));
}

function sessionOpCanRetryRetainedMachineInbox(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return !sessionOperationContext.state.shuttingDown && !managed.stopRequested && !managed.isProcessing
        && ((sessionOpHasTerminalObjectiveState(sessionOperationContext, managed) && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
            || (sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, managed) && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed)));
}

/** Stop may retain only an already-ACKed, typed agent receipt whose durable
 * transcript row and FIFO envelope agree exactly. Hidden nudges, human rows,
 * duplicate ids and prose that merely resembles a receipt never qualify. */
function sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext: SessionOperationContext, managed: ManagedSession, item: ManagedSession['messageQueue'][number]): Message | undefined {
    const origin = item.options?.internalOrigin;
    const messageType = origin?.kind === 'agent-message' ? origin.agentMessageType : undefined;
    const sender = origin?.kind === 'agent-message' && origin.senderSessionId
        ? sessionOperationContext.state.sessions.get(origin.senderSessionId)
        : undefined;
    if (!item.messageId || item.options?.hidden !== true
        || origin?.kind !== 'agent-message' || !messageType
        || !(['progress', 'result', 'question', 'decision'] as const).includes(messageType)
        || !origin.senderSessionId || !origin.deliveryId
        || !sender || sender.workspace.id !== managed.workspace.id
        || managed.messageQueue.filter(candidate => candidate.messageId === item.messageId).length !== 1) {
        return undefined;
    }
    const byMessageId = managed.messages.filter(message => message.id === item.messageId);
    const byDeliveryId = managed.messages.filter(message => message.agentDelivery?.id === origin.deliveryId);
    const receipt = byMessageId[0];
    if (byMessageId.length !== 1 || byDeliveryId.length !== 1 || byDeliveryId[0] !== receipt
        || receipt?.role !== 'user' || receipt.hidden !== true || receipt.isQueued !== true
        || receipt.isPending || receipt.content !== item.message
        || receipt.agentDelivery?.status !== 'queued'
        || receipt.agentDelivery.id !== origin.deliveryId
        || receipt.agentDelivery.attachmentsSha256 !== origin.attachmentsSha256
        || receipt.internalOrigin?.kind !== 'agent-message'
        || receipt.internalOrigin.senderSessionId !== origin.senderSessionId
        || receipt.internalOrigin.deliveryId !== origin.deliveryId
        || receipt.internalOrigin.agentMessageType !== origin.agentMessageType
        || receipt.internalOrigin.attachmentsSha256 !== origin.attachmentsSha256)
        return undefined;
    return receipt;
}

/** A FIFO row can already be dequeued, or durably claimed while runtime
 * preparation is still in progress. Stop invalidates that private token and
 * restores the same receipt once without spending an attempt until the exact
 * synchronous provider handoff has begun. */
function sessionOpRestorePreAckAgentDeliveryDequeues(sessionOperationContext: SessionOperationContext, managed: ManagedSession, settleUncertainStopAsConsumed = false): number {
    let changed = 0;
    for (const [messageId, dispatch] of [...sessionOperationContext.state.queuedAgentDeliveryDispatches.entries()]) {
        if (dispatch.sessionId !== managed.id)
            continue;
        const receipt = managed.messages.find(message => message.id === messageId);
        const origin = receipt?.internalOrigin;
        const messageType = origin?.kind === 'agent-message' ? origin.agentMessageType : undefined;
        const uncertainChildDispatch = dispatch.providerStarted !== true
            && (dispatch.providerDispatchUncertain === true
                || !!receipt?.providerDispatch)
            && receipt?.role === 'user' && receipt.hidden === true
            && (receipt.agentDelivery?.status === 'queued' || receipt.agentDelivery?.status === 'processing')
            && origin?.kind === 'agent-message' && receipt.agentDelivery.id === dispatch.deliveryId
            && origin.deliveryId === dispatch.deliveryId;
        const recoverablePreAckClaim = dispatch.providerStarted !== true
            && dispatch.providerDispatchUncertain !== true
            && !receipt?.providerDispatch
            && receipt?.role === 'user' && receipt.hidden === true
            && (receipt.agentDelivery?.status === 'queued' || receipt.agentDelivery?.status === 'processing')
            && origin?.kind === 'agent-message' && !!messageType
            && (['progress', 'result', 'question', 'decision'] as const).includes(messageType)
            && receipt.agentDelivery.id === dispatch.deliveryId
            && origin.deliveryId === dispatch.deliveryId;
        if (settleUncertainStopAsConsumed && uncertainChildDispatch && receipt?.agentDelivery) {
            // The prompt left the host process, so Stop cannot distinguish a child
            // that accepted it from one whose preflight response is merely delayed.
            // Conservatively consume this exact receipt instead of replaying a
            // potentially mutating provider turn. The durable timestamp preserves
            // why no automatic redelivery is allowed after restart.
            receipt.isQueued = false;
            receipt.agentDelivery.status = 'processed';
            receipt.agentDelivery.providerDispatchUncertainAt ??= Date.now();
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== messageId);
            if (managed.activeAgentDelivery?.deliveryId === dispatch.deliveryId) {
                managed.activeAgentDelivery = undefined;
            }
            changed++;
        }
        else if (recoverablePreAckClaim && receipt?.agentDelivery) {
            receipt.isQueued = true;
            receipt.agentDelivery.status = 'queued';
            if (dispatch.attemptsBeforeClaim !== undefined) {
                receipt.agentDelivery.attempts = dispatch.attemptsBeforeClaim;
            }
            if (managed.activeAgentDelivery?.deliveryId === dispatch.deliveryId) {
                managed.activeAgentDelivery = undefined;
            }
            changed++;
        }
        if (recoverablePreAckClaim && receipt
            && !managed.messageQueue.some(item => item.messageId === messageId)) {
            enqueueRecoveredMessageInTranscriptOrder(managed, {
                message: receipt.content,
                messageId: receipt.id,
                ...(receipt.attachments !== undefined ? { storedAttachments: receipt.attachments } : {}),
                options: recoveredInternalMessageOptions(receipt),
            });
        }
        if (sessionOperationContext.state.queuedMessageDispatches.get(managed.id) === dispatch.dispatchToken) {
            sessionOperationContext.state.queuedMessageDispatches.delete(managed.id);
        }
        sessionOperationContext.state.queuedAgentDeliveryDispatches.delete(messageId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    }
    return changed;
}

function sessionOpPartitionQueueForStop(sessionOperationContext: SessionOperationContext, managed: ManagedSession): {
    retained: ManagedSession['messageQueue'];
    cleared: ManagedSession['messageQueue'];
} {
    const retained: ManagedSession['messageQueue'] = [];
    const cleared: ManagedSession['messageQueue'] = [];
    for (const item of managed.messageQueue) {
        const receipt = sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, item);
        if (receipt) {
            retained.push({
                message: receipt.content,
                messageId: receipt.id,
                ...(receipt.attachments !== undefined ? { storedAttachments: receipt.attachments } : {}),
                options: recoveredInternalMessageOptions(receipt),
            });
        }
        else
            cleared.push(item);
    }
    return { retained, cleared };
}

/** A stopped child receipt is runnable only while the Stop transaction can
 * bind it to the exact current objective. Otherwise keep the transcript
 * evidence as a failed delivery, but remove all FIFO authority so a cold
 * restart cannot inject it into an unrelated or missing objective. */
function sessionOpQuarantineUnboundStoppedAgentDeliveries(sessionOperationContext: SessionOperationContext, managed: ManagedSession, retained: ManagedSession['messageQueue']): void {
    if (!retained.length || sessionOpHasBoundInterruptedTurnRecovery(sessionOperationContext, managed))
        return;
    const retainedIds = new Set(retained.map(item => item.messageId).filter((id): id is string => !!id));
    managed.messageQueue = managed.messageQueue.filter(item => !(item.messageId && retainedIds.has(item.messageId)));
    for (const message of managed.messages) {
        if (!retainedIds.has(message.id) || message.role !== 'user' || !message.agentDelivery)
            continue;
        message.isQueued = false;
        message.agentDelivery.status = 'failed';
    }
    sessionLog.warn('Quarantined stopped agent deliveries without an objective-bound recovery snapshot', {
        sessionId: managed.id,
        deliveryCount: retainedIds.size,
    });
}

function sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return sessionOpHasBoundInterruptedTurnRecovery(sessionOperationContext, managed)
        && managed.messageQueue.some(item => !!sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, item));
}

/**
 * Repair an older host's accepted business answer that was stranded by its
 * hard-limit gate. Header metadata only selects a candidate: the unique,
 * canonical final transcript row and current objective provide authority.
 * The new dispatch is a separate clean, durable continuation; the answer
 * itself is never replayed into the old provider session.
 */
async function sessionOpResumeOrphanedContextAnswerAfterRestart(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    const objective = managed?.activeObjective;
    const compaction = managed?.contextCompactionAttempt;
    if (!managed || !objective || objective.terminalState !== 'active'
        || managed.pendingTurnRecovery || managed.isProcessing || managed.stopRequested
        || sessionOperationContext.state.shuttingDown || isMissionRuntimeOwnedRecovery(managed)
        || isClosedSessionStatus(loadStatusConfig(managed.workspace.rootPath), managed.sessionStatus)
        || compaction?.hardLimitFollowUpAttempted !== true
        || compaction.objectiveRootId !== objective.userMessageId
        || !compaction.hardLimitTokens
        || (managed.tokenUsage?.contextTokens ?? 0) < compaction.hardLimitTokens
        || objective.lastOutcome?.state !== 'continue'
        || objective.lastOutcome.blocker != null)
        return;
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    if (sessionOperationContext.state.sessions.get(sessionId) !== managed || managed.activeObjective !== objective
        || managed.pendingTurnRecovery || managed.isProcessing || managed.stopRequested
        || sessionOperationContext.state.shuttingDown || managed.messageQueue.length > 0
        || sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed)
        || managed.pendingAuthRequestId || managed.pendingAuthRequest
        || !hasAuthenticatedObjectiveRoot(managed, objective))
        return;
    const finalRow = managed.messages.at(-1);
    if (!finalRow || finalRow.role !== 'user' || finalRow.hidden !== true
        || finalRow.isQueued || finalRow.isPending || finalRow.agentDelivery
        || finalRow.providerDispatch || finalRow.internalOrigin?.kind !== 'user-input'
        || finalRow.timestamp <= compaction.attemptedAt)
        return;
    const matches = (managed.userInputRequests ?? []).filter(request => (request.status === 'answered' && request.responseMessageId === finalRow.id
        && request.sessionId === managed.id
        && request.originWorkspaceId === managed.workspace.id
        && request.objectiveUserMessageId === objective.userMessageId
        && !isExactContextLimitNextStepQuestion(request)));
    if (matches.length !== 1)
        return;
    const evidence = sessionOpContextLimitAuthenticatedAnswerEvidence(sessionOperationContext, managed, objective, finalRow.id);
    if (!evidence?.responseMessageIds.has(finalRow.id))
        return;
    const pending: PendingTurnRecovery = {
        ...createPendingTurnRecovery(finalRow.id, finalRow.timestamp),
        lastCause: 'objective_continue',
        continuationOrigin: 'objective_continue',
        continuationWork: objective.lastOutcome.remainingWork,
    };
    const handoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, pending);
    if (!handoff)
        return;
    managed.pendingTurnRecovery = pending;
    const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'objective_continue', undefined, handoff.remainingWork, undefined, undefined, true);
    if (!queued) {
        if (managed.pendingTurnRecovery === pending)
            managed.pendingTurnRecovery = undefined;
        return;
    }
    sessionLog.info('Recovered authenticated answer stranded by old hard-limit gate', {
        sessionId, responseMessageId: finalRow.id,
    });
    if (!managed.isProcessing && managed.messageQueue.length > 0) {
        sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
    }
}

export { sessionOpBuildObjectiveRuntimePrompt as buildObjectiveRuntimePrompt };
export { sessionOpHasOnlyMachineInbox as hasOnlyMachineInbox };
export { sessionOpCanRetryRetainedMachineInbox as canRetryRetainedMachineInbox };
export { sessionOpExactQueuedAgentDeliveryReceipt as exactQueuedAgentDeliveryReceipt };
export { sessionOpRestorePreAckAgentDeliveryDequeues as restorePreAckAgentDeliveryDequeues };
export { sessionOpPartitionQueueForStop as partitionQueueForStop };
export { sessionOpQuarantineUnboundStoppedAgentDeliveries as quarantineUnboundStoppedAgentDeliveries };
export { sessionOpHasAnyRetainedStoppedAgentDelivery as hasAnyRetainedStoppedAgentDelivery };
export { sessionOpResumeOrphanedContextAnswerAfterRestart as resumeOrphanedContextAnswerAfterRestart };
