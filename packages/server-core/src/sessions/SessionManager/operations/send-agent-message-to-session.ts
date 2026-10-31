import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { agentDeliveryId, acknowledgeDurableDelivery, persistAgentDeliveryAttachments } from '../../agent-delivery.ts';
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers';
import { updateSessionMetadata, assertSessionPersistenceRootIdentity } from '@craft-agent/shared/sessions';
import type { FileAttachment } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { readFileAttachment } from '@craft-agent/shared/utils';
import type { AgentMessageType } from '@craft-agent/session-tools-core';
import type { ManagedSession } from '../managed-session.ts';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import { MAX_ANNOTATIONS_PER_MESSAGE, MAX_ANNOTATION_JSON_BYTES } from '../runtime-policy.ts';
import { assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, assertSessionMutationAdmissionOpen as sessionOpAssertSessionMutationAdmissionOpen, trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';

async function sessionOpPerformUpdateSessionModel(sessionOperationContext: SessionOperationContext, managed: ManagedSession, model: string | null, connection?: string): Promise<void> {
    const sessionId = managed.id;
    if (hasImmutableMissionRoute(managed)) {
        throw new Error('Mission session route is immutable');
    }
    managed.model = model ?? undefined;
    managed.modelRoutePinned = model !== null;
    // Also update connection if provided and not already locked
    const pinsCurrentConnection = !!connection
        && (connection === managed.llmConnection || !managed.connectionLocked);
    if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection;
    }
    if (pinsCurrentConnection) {
        managed.connectionRoutePinned = true;
    }
    // Persist to disk (include connection if it was updated)
    const updates: {
        model?: string;
        modelRoutePinned?: boolean;
        llmConnection?: string;
        connectionRoutePinned?: boolean;
    } = omitUndefined({
        model: model ?? undefined,
        modelRoutePinned: model !== null,
    });
    if (connection && !managed.connectionLocked) {
        updates.llmConnection = connection;
    }
    if (pinsCurrentConnection) {
        updates.connectionRoutePinned = true;
    }
    await updateSessionMetadata(persistenceRootFor(managed), sessionId, updates, managed.persistenceRootIdentity);
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    // Refresh the live runtime through the acknowledged async config path.
    // Calling agent.setModel() directly is fire-and-forget for Pi and can leave
    // the persisted/UI model ahead of the subprocess's effective model.
    if (managed.agent) {
        await sessionOperationContext.owner.tryRefreshAgentRuntime(managed, 'session model changed');
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    }
    else {
        sessionLog.info(`[updateSessionModel] No agent yet, model will apply on next agent creation`);
    }
    // Notify renderer of the model change
    sessionOperationContext.owner["sendEvent"]({
        type: 'session_model_changed',
        sessionId,
        model,
        modelRoutePinned: managed.modelRoutePinned === true,
    }, managed.workspace.id);
    sessionLog.info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`);
}

/**
 * Add an annotation to a message and persist the session.
 */
function sessionOpAddMessageAnnotation(sessionOperationContext: SessionOperationContext, sessionId: string, messageId: string, annotation: NonNullable<Message['annotations']>[number]): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`Cannot add annotation: session ${sessionId} not found`);
        return;
    }
    sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext, managed);
    const message = managed.messages.find(m => m.id === messageId);
    if (!message) {
        sessionLog.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`);
        return;
    }
    if (!annotation?.id || !annotation?.target?.selectors?.length) {
        sessionLog.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`);
        return;
    }
    if (annotation.target.source.messageId !== messageId) {
        sessionLog.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`);
        return;
    }
    const safeAnnotation: NonNullable<Message['annotations']>[number] = {
        ...annotation,
        schemaVersion: 1,
        target: {
            ...annotation.target,
            source: {
                ...annotation.target.source,
                sessionId,
                messageId,
            },
        },
    };
    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8');
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
        sessionLog.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`);
        return;
    }
    const existing = message.annotations ?? [];
    if (existing.some(a => a.id === safeAnnotation.id)) {
        sessionLog.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`);
        return;
    }
    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
        sessionLog.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`);
        return;
    }
    message.annotations = [...existing, safeAnnotation];
    sessionOperationContext.owner["persistSession"](managed);
    sessionOperationContext.owner["sendEvent"]({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id);
}

/**
 * Patch an existing annotation on a message.
 */
function sessionOpUpdateMessageAnnotation(sessionOperationContext: SessionOperationContext, sessionId: string, messageId: string, annotationId: string, patch: Partial<NonNullable<Message['annotations']>[number]>): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`Cannot update annotation: session ${sessionId} not found`);
        return;
    }
    sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext, managed);
    const message = managed.messages.find(m => m.id === messageId);
    if (!message) {
        sessionLog.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`);
        return;
    }
    const existing = message.annotations ?? [];
    const idx = existing.findIndex(a => a.id === annotationId);
    if (idx === -1) {
        sessionLog.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`);
        return;
    }
    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
        sessionLog.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`);
        return;
    }
    if (patch.target?.selectors && patch.target.selectors.length === 0) {
        sessionLog.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`);
        return;
    }
    const current = existing[idx]!;
    const updated = {
        ...current,
        ...patch,
        id: current.id,
        schemaVersion: current.schemaVersion,
        target: patch.target
            ? {
                ...current.target,
                ...patch.target,
                source: {
                    ...current.target.source,
                    ...(patch.target.source ?? {}),
                    sessionId,
                    messageId,
                },
            }
            : {
                ...current.target,
                source: {
                    ...current.target.source,
                    sessionId,
                    messageId,
                },
            },
        updatedAt: Date.now(),
    };
    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8');
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
        sessionLog.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`);
        return;
    }
    const next = [...existing];
    next[idx] = updated;
    message.annotations = next;
    sessionOperationContext.owner["persistSession"](managed);
    sessionOperationContext.owner["sendEvent"]({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id);
}

/**
 * Remove an annotation from a message and persist the session.
 */
function sessionOpRemoveMessageAnnotation(sessionOperationContext: SessionOperationContext, sessionId: string, messageId: string, annotationId: string): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`Cannot remove annotation: session ${sessionId} not found`);
        return;
    }
    sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext, managed);
    const message = managed.messages.find(m => m.id === messageId);
    if (!message) {
        sessionLog.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`);
        return;
    }
    const existing = message.annotations ?? [];
    if (!existing.some(a => a.id === annotationId)) {
        sessionLog.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`);
        return;
    }
    message.annotations = existing.filter(a => a.id !== annotationId);
    sessionOperationContext.owner["persistSession"](managed);
    sessionOperationContext.owner["sendEvent"]({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id);
}

/**
 * Deliver a cross-session message while holding an operation lease on the
 * recipient. Attachment authorization can yield; without this lease a
 * concurrent recipient deletion could commit and the later bundle write
 * would recreate its attachments directory outside the persistence fence.
 * The injectable validator is a narrow deterministic test seam.
 */
function sessionOpSendAgentMessageToSession(sessionOperationContext: SessionOperationContext, sender: ManagedSession, target: ManagedSession, message: string, attachments?: Array<{
    path: string;
    name?: string;
}>, messageType: AgentMessageType = 'progress', validateAttachmentPath: typeof validateFilePath = validateFilePath) {
    return sessionOpTrackSessionOperation(sessionOperationContext, target, async () => {
        let fileAttachments: FileAttachment[] | undefined;
        if (attachments?.length) {
            const builtAttachments: FileAttachment[] = [];
            for (const attachmentInput of attachments) {
                try {
                    const extraDirs = getWorkspaceAllowedDirs(sender.workspace.id);
                    const safePath = await validateAttachmentPath(attachmentInput.path, extraDirs);
                    const attachment = readFileAttachment(safePath);
                    if (!attachment)
                        throw new Error('Attachment was not readable');
                    if (attachmentInput.name)
                        attachment.name = attachmentInput.name;
                    builtAttachments.push(attachment);
                }
                catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    throw new Error(`send_agent_message attachment could not be delivered: ${detail}`);
                }
            }
            if (builtAttachments.length > 0)
                fileAttachments = builtAttachments;
        }
        // Deletion closes ownership synchronously while attachment validation can
        // yield. Never write a bundle or dispatch after that linearization point.
        if (sessionOperationContext.state.retiringSessions.has(target) || sessionOperationContext.state.sessions.get(target.id) !== target) {
            throw new Error(`Target session ${target.id} is being deleted`);
        }
        if (sessionOpHasTerminalObjectiveState(sessionOperationContext, target)) {
            throw new Error(`Target session objective is terminal (${target.activeObjective?.terminalState}); no agent message was queued. Reuse its completed result. A new delegation is valid only when the objective or version genuinely changed, and grants no new authority.`);
        }
        const targetBusy = target.isProcessing === true;
        const deliveryId = agentDeliveryId(sender.id, sender.activeObjective?.objectiveId ?? sender.id, target.id, message, fileAttachments);
        const attachmentsSha256 = persistAgentDeliveryAttachments(assertSessionPersistenceRootIdentity(target.persistenceRootIdentity), target.id, fileAttachments);
        const messageId = await acknowledgeDurableDelivery(ack => sessionOperationContext.owner.sendMessage(target.id, message, fileAttachments, undefined, {
            hidden: true,
            internalOrigin: {
                kind: 'agent-message',
                senderSessionId: sender.id,
                deliveryId,
                ...(attachmentsSha256 !== undefined ? { attachmentsSha256: attachmentsSha256 } : {}),
                agentMessageType: messageType,
            },
        }, undefined, undefined, ack), error => sessionLog.error('Agent delivery processing failed', {
            sessionId: target.id,
            deliveryId,
            error,
        }));
        const receipt = target.messages.find(candidate => candidate.id === messageId)?.agentDelivery;
        const status = receipt?.status ?? 'queued';
        // The durable receipt, not the target's pre-dispatch busy snapshot,
        // decides what we acknowledge. A freshly fsynced receipt is queued until
        // the recipient durably advances it to processing.
        return {
            delivery: status === 'queued' ? ('queued' as const) : ('delivered' as const),
            targetBusy,
            receiptId: deliveryId,
            status,
        };
    });
}

export { sessionOpPerformUpdateSessionModel as performUpdateSessionModel };
export { sessionOpAddMessageAnnotation as addMessageAnnotation };
export { sessionOpUpdateMessageAnnotation as updateMessageAnnotation };
export { sessionOpRemoveMessageAnnotation as removeMessageAnnotation };
export { sessionOpSendAgentMessageToSession as sendAgentMessageToSession };
