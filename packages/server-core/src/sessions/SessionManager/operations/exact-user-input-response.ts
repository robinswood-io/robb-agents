import type { SessionCompletionEvent } from '../runtime-types.ts';
import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { isImmutableAutomaticRecoveryBlock, isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import type { UserInputRequest } from '@craft-agent/core';
import type { SendMessageOptions } from '@craft-agent/shared/protocol';
import { buildObjectiveValidationEvidenceContext } from '../../objective-validation-context';
import { AUTONOMOUS_SESSION_LIMITS, inspectAutonomousLineage } from '../../autonomous-session-admission';
import { buildAutomaticTurnRecoveryPrompt } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { canonicalUserInputAnswerContents } from '../user-input-authority.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { terminalizeImmutableAutomaticRecoveryBlock as sessionOpTerminalizeImmutableAutomaticRecoveryBlock } from './dispatch-allocated-clean-retry.ts';
import { getLastFinalAssistantMessageId as sessionOpGetLastFinalAssistantMessageId } from './session-sources.ts';
import { providerDispatchAcceptanceUnknown as sessionOpProviderDispatchAcceptanceUnknown } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { getPendingUserInputResponse as sessionOpGetPendingUserInputResponse, isExactRepurposedUserInputCleanBoundary as sessionOpIsExactRepurposedUserInputCleanBoundary } from './user-input-recovery.ts';

async function sessionOpStopImmutableRestartRecovery(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<boolean> {
    const lineage = inspectAutonomousLineage(managed, id => sessionOperationContext.state.sessions.get(id), false, id => { const session = sessionOperationContext.state.sessions.get(id); return !!session && sessionOpHasPendingDecision(sessionOperationContext, session); });
    if (lineage.allowed || !isImmutableAutomaticRecoveryBlock(lineage.reason))
        return false;
    if (!await sessionOpTerminalizeImmutableAutomaticRecoveryBlock(sessionOperationContext, managed, lineage))
        return false;
    const objective = managed.activeObjective;
    await sessionOperationContext.owner.reconcileRecoveredTerminalStatus(managed, 'error');
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.activeObjective !== objective
        || objective?.terminalState === 'active' || managed.isProcessing)
        return true;
    sessionOperationContext.owner.emitObjectiveChanged(managed);
    sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'complete' }>>({
        type: 'complete', sessionId: managed.id, reason: 'error', tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread, backgroundTasksAlive: sessionOperationContext.state.keepBackgroundTasksAlive,
    }), managed.workspace.id);
    const finalMessageId = sessionOpGetLastFinalAssistantMessageId(sessionOperationContext, managed.messages);
    sessionOperationContext.owner.emitSessionComplete(omitUndefined<SessionCompletionEvent>({
        sessionId: managed.id, workspaceId: managed.workspace.id, reason: 'error',
        ...(finalMessageId !== undefined ? { finalMessageId: finalMessageId } : {}),
        finalText: finalMessageId ? managed.messages.find(message => message.id === finalMessageId)?.content : undefined,
        ...(managed.tokenUsage !== undefined ? { tokenUsage: managed.tokenUsage } : {}),
    }));
    return true;
}

function sessionOpAutonomousAdmissionBlock(sessionOperationContext: SessionOperationContext, managed: ManagedSession, spawning = false, checkCapacity = true, spawningRole?: 'worker' | 'reviewer'): string | undefined {
    if (sessionOpProviderDispatchAcceptanceUnknown(sessionOperationContext, managed))
        return 'provider_acceptance_unknown';
    const lineage = inspectAutonomousLineage(managed, id => sessionOperationContext.state.sessions.get(id), spawning, id => { const session = sessionOperationContext.state.sessions.get(id); return !!session && sessionOpHasPendingDecision(sessionOperationContext, session); });
    if (!lineage.allowed)
        return `${lineage.reason}: ${lineage.blockedBy}`;
    if (!checkCapacity)
        return undefined;
    const occupied = new Set([...sessionOperationContext.state.sessions.values()].filter(s => s.isProcessing).map(s => s.id));
    for (const id of sessionOperationContext.state.automaticAdmissionReservations)
        occupied.add(id);
    if (!spawning)
        occupied.delete(managed.id);
    const reviewerParentsToDiscount = new Set<string>();
    for (const id of occupied) {
        const session = sessionOperationContext.state.sessions.get(id);
        if (session?.delegation?.role === 'reviewer' && session.parentSessionId) {
            reviewerParentsToDiscount.add(session.parentSessionId);
        }
    }
    if (spawning && spawningRole === 'reviewer') {
        reviewerParentsToDiscount.add(managed.id);
    }
    else if (!spawning && managed.delegation?.role === 'reviewer' && managed.parentSessionId) {
        reviewerParentsToDiscount.add(managed.parentSessionId);
    }
    for (const parentId of reviewerParentsToDiscount) {
        occupied.delete(parentId);
    }
    if (occupied.size + sessionOperationContext.state.pendingSpawnRoots.size >= AUTONOMOUS_SESSION_LIMITS.maxRestartConcurrent)
        return 'global_capacity';
    let family = [...sessionOperationContext.state.pendingSpawnRoots.values()].filter(root => root === lineage.rootId).length;
    for (const id of occupied) {
        const session = sessionOperationContext.state.sessions.get(id);
        if (session && inspectAutonomousLineage(session, key => sessionOperationContext.state.sessions.get(key)).rootId === lineage.rootId)
            family++;
    }
    if (family >= AUTONOMOUS_SESSION_LIMITS.maxPerRoot)
        return 'root_capacity';
    return undefined;
}

function sessionOpHasQueuedHumanAuthority(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    if (sessionOperationContext.state.shuttingDown || managed.stopRequested)
        return false;
    return sessionOpQueuedHumanIndex(sessionOperationContext, managed) >= 0;
}

function sessionOpAuthenticatedUserInputRestartPrompt(sessionOperationContext: SessionOperationContext, managed: ManagedSession, request: UserInputRequest): string | undefined {
    const pending = managed.pendingTurnRecovery;
    if (!pending || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)
        || sessionOpGetPendingUserInputResponse(sessionOperationContext, managed) !== request)
        return undefined;
    const evidenceContext = managed.activeObjective && (pending.validationGaps?.length
        || managed.activeObjective.terminalReconciliation)
        ? buildObjectiveValidationEvidenceContext(managed.messages, managed.activeObjective, managed.id)
        : undefined;
    return buildAutomaticTurnRecoveryPrompt(pending, 'app_restart', evidenceContext, pending.attempts + 1, isLegacyHostObjectiveContractEnabled(managed) ? managed.activeObjective : undefined);
}

/** Authenticate the exact durable answer row behind a user-input envelope.
 * Request metadata alone is not authority: transcript identity, hidden
 * provenance and content must all agree uniquely with the active objective. */
function sessionOpExactUserInputResponse(sessionOperationContext: SessionOperationContext, managed: ManagedSession, messageId: string | undefined, content: string, options: SendMessageOptions | undefined): UserInputRequest | undefined {
    if (!messageId || options?.hidden !== true
        || options.internalOrigin?.kind !== 'user-input'
        || options.automaticRecovery || managed.activeObjective?.terminalState !== 'active')
        return undefined;
    const messages = managed.messages.filter(message => message.id === messageId);
    const saved = messages[0];
    if (messages.length !== 1 || !saved || saved.role !== 'user' || saved.hidden !== true
        || saved.isPending || saved.agentDelivery
        || saved.internalOrigin?.kind !== 'user-input')
        return undefined;
    const requests = (managed.userInputRequests ?? []).filter(request => (request.status === 'answered' && request.responseMessageId === messageId
        && request.sessionId === managed.id && request.originWorkspaceId === managed.workspace.id
        && request.objectiveUserMessageId === managed.activeObjective?.userMessageId));
    const request = requests.length === 1 ? requests[0] : undefined;
    if (!request?.answers?.length)
        return undefined;
    // The transcript/FIFO pair is not authority by itself: both can be
    // corrupted together. Recompute the only two answer envelopes the host
    // has ever accepted from the durable answered request.
    const canonicalAnswers = canonicalUserInputAnswerContents(request);
    if (!canonicalAnswers.includes(saved.content)
        && !sessionOpIsExactRepurposedUserInputCleanBoundary(sessionOperationContext, managed, request, saved))
        return undefined;
    if (saved.isQueued === true)
        return content === saved.content ? request : undefined;
    // A crash after the host accepted an answer but before the SDK consumed it
    // requires one additional recovery instruction. Authenticate that suffix
    // by rebuilding it entirely from the current objective/recovery state;
    // never accept an arbitrary prefix/suffix merely because the saved answer
    // row and FIFO agree with each other.
    if (managed.isProcessing || managed.stopRequested
        || managed.messageQueue.some(item => item.messageId === messageId)
        || sessionOperationContext.state.queuedMessageDispatches.has(managed.id))
        return undefined;
    const restartRecoveryPrompt = sessionOpAuthenticatedUserInputRestartPrompt(sessionOperationContext, managed, request);
    return restartRecoveryPrompt
        && content === `${saved.content}\n\n${restartRecoveryPrompt}`
        ? request
        : undefined;
}

function sessionOpQueuedHumanIndex(sessionOperationContext: SessionOperationContext, managed: ManagedSession): number {
    return managed.messageQueue.findIndex((item, index) => {
        if (item.options?.internalOrigin?.kind === 'user-input') {
            return managed.messageQueue.findIndex(candidate => candidate.messageId === item.messageId) === index
                && managed.messageQueue.filter(candidate => candidate.messageId === item.messageId).length === 1
                && !!sessionOpExactUserInputResponse(sessionOperationContext, managed, item.messageId, item.message, item.options);
        }
        if (!item.messageId || item.options?.hidden || item.options?.internalOrigin || item.options?.automaticRecovery)
            return false;
        const savedRows = managed.messages.filter(message => message.id === item.messageId);
        const saved = savedRows[0];
        return savedRows.length === 1
            && managed.messageQueue.findIndex(candidate => candidate.messageId === item.messageId) === index
            && managed.messageQueue.filter(candidate => candidate.messageId === item.messageId).length === 1
            && saved?.role === 'user' && saved.isQueued && !saved.isPending && !saved.hidden
            && !saved.internalOrigin && !saved.agentDelivery && saved.content === item.message;
    });
}

/** Authenticate one durable typed inter-session receipt without assigning it
 * any ancestry authority. This keeps ordinary parent→child, sibling and
 * independent-session relays on the normal admission path. */
function sessionOpAuthenticatedTypedAgentDeliverySender(sessionOperationContext: SessionOperationContext, managed: ManagedSession, item: ManagedSession['messageQueue'][number], ownedDispatchToken?: symbol): ManagedSession | undefined {
    const origin = item.options?.internalOrigin;
    if (origin?.kind !== 'agent-message'
        || !origin.agentMessageType
        || !origin.senderSessionId || !origin.deliveryId || !item.messageId)
        return undefined;
    const sender = sessionOperationContext.state.sessions.get(origin.senderSessionId);
    if (!sender || sender.workspace.id !== managed.workspace.id)
        return undefined;
    const receipts = managed.messages.filter(message => message.agentDelivery?.id === origin.deliveryId);
    if (receipts.length !== 1)
        return undefined;
    const receipt = receipts[0]!;
    if (receipt.id !== item.messageId || receipt.role !== 'user' || receipt.hidden !== true
        || receipt.isQueued !== true || receipt.content !== item.message
        || receipt.agentDelivery?.status !== 'queued'
        || receipt.internalOrigin?.kind !== 'agent-message'
        || receipt.internalOrigin.senderSessionId !== origin.senderSessionId
        || receipt.internalOrigin.deliveryId !== origin.deliveryId
        || receipt.internalOrigin.agentMessageType !== origin.agentMessageType
        || receipt.internalOrigin.attachmentsSha256 !== origin.attachmentsSha256)
        return undefined;
    if (ownedDispatchToken) {
        const dispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(receipt.id);
        if (sessionOperationContext.state.queuedMessageDispatches.get(managed.id) !== ownedDispatchToken
            || dispatch?.dispatchToken !== ownedDispatchToken
            || dispatch.sessionId !== managed.id || dispatch.deliveryId !== origin.deliveryId)
            return undefined;
    }
    else if (managed.messageQueue.filter(queued => queued.messageId === receipt.id).length !== 1) {
        return undefined;
    }
    return sender;
}

export { sessionOpStopImmutableRestartRecovery as stopImmutableRestartRecovery };
export { sessionOpAutonomousAdmissionBlock as autonomousAdmissionBlock };
export { sessionOpHasQueuedHumanAuthority as hasQueuedHumanAuthority };
export { sessionOpAuthenticatedUserInputRestartPrompt as authenticatedUserInputRestartPrompt };
export { sessionOpExactUserInputResponse as exactUserInputResponse };
export { sessionOpQueuedHumanIndex as queuedHumanIndex };
export { sessionOpAuthenticatedTypedAgentDeliverySender as authenticatedTypedAgentDeliverySender };
