import type { SessionOperationContext } from '../operation-context.ts';
import { randomUUID } from 'node:crypto';
import { sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import type { SessionHeader } from '@craft-agent/shared/sessions';
import { pendingPermissionCanReplay } from '../../permission-request-lifecycle';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { sanitizeParentSessionLabels } from '../session-creation.ts';
import { deniedPermissionToolUseIds as sessionOpDeniedPermissionToolUseIds } from './message-authority.ts';
import { markPermissionToolNotExecuted as sessionOpMarkPermissionToolNotExecuted, rejectPendingPrivilegedApproval as sessionOpRejectPendingPrivilegedApproval, denyPermissionOnRecordedRuntime as sessionOpDenyPermissionOnRecordedRuntime, expirePendingPermissionRequest as sessionOpExpirePendingPermissionRequest } from './expire-pending-permission-request.ts';

/** A provider callback can race the expiry cleanup that is tearing its
 * runtime down. Refuse it before creating broker state or replacing the
 * durable human-handoff marker; a later UI response then has no capability
 * to approve the obsolete request. */
function sessionOpRejectPermissionRequestOutsideActiveGeneration(sessionOperationContext: SessionOperationContext, managed: ManagedSession, request: {
    requestId: string;
    toolUseId?: string;
}, runtimeAgent: AgentInstance | null | undefined): boolean {
    const generation = managed.processingGeneration;
    const runtimeGeneration = runtimeAgent
        ? sessionOperationContext.state.runtimeProcessingGenerations.get(runtimeAgent)
        : undefined;
    const startedTools = sessionOperationContext.state.checkpointToolStarts.get(managed);
    const toolOwner = request.toolUseId ? startedTools?.calls.get(request.toolUseId) : undefined;
    const activeObjectiveId = managed.activeObjective?.userMessageId;
    const toolOwnerMismatch = !!toolOwner && (startedTools?.generation !== generation || toolOwner.objectiveId !== activeObjectiveId);
    const expiredToolReceipt = !!request.toolUseId && managed.messages.some(message => (message.role === 'tool'
        && message.toolUseId === request.toolUseId
        && message.toolStatus === 'error'
        && message.toolExecuted === false));
    const reject = !runtimeAgent
        || managed.agent !== runtimeAgent
        || !managed.isProcessing
        || managed.stopRequested
        || managed.activeObjective?.terminalState !== 'active'
        || sessionOperationContext.state.permissionExpiryStopGenerations.get(managed) === generation
        || toolOwnerMismatch
        || expiredToolReceipt;
    if (!reject)
        return false;
    // A stale runtime can legally reuse a provider tool ID that now belongs to
    // the current generation. Runtime ownership outranks the current
    // checkpoint in that case; otherwise the stale callback could tombstone
    // the live call and cause its real result to be ignored/retried.
    const staleRuntime = !!runtimeAgent && runtimeAgent !== managed.agent;
    const deniedGeneration = staleRuntime
        ? runtimeGeneration
        : (toolOwner ? startedTools?.generation : runtimeGeneration)
            ?? (runtimeAgent === managed.agent ? generation : undefined);
    if (request.toolUseId && deniedGeneration !== undefined) {
        sessionOpDeniedPermissionToolUseIds(sessionOperationContext, managed, deniedGeneration).add(request.toolUseId);
        const collidesWithCurrentGeneration = staleRuntime
            && !!toolOwner
            && startedTools?.generation === generation;
        if (!collidesWithCurrentGeneration
            && sessionOpMarkPermissionToolNotExecuted(sessionOperationContext, managed, request))
            sessionOperationContext.owner["persistSession"](managed);
    }
    sessionLog.warn('Rejected permission request outside its active generation', {
        sessionId: managed.id,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        generation,
        isProcessing: managed.isProcessing,
        stopRequested: managed.stopRequested,
        objectiveState: managed.activeObjective?.terminalState,
        toolOwnerObjectiveId: toolOwner?.objectiveId,
        activeObjectiveId,
        currentRuntime: !!runtimeAgent && managed.agent === runtimeAgent,
    });
    runtimeAgent?.respondToPermission(request.requestId, false, false);
    return true;
}

async function sessionOpClosePendingPermissionRequestsForStop(sessionOperationContext: SessionOperationContext, managed: ManagedSession, generation: number): Promise<void> {
    const cohort = [...sessionOperationContext.state.pendingPermissionRequests.entries()].filter(([, metadata]) => (metadata.sessionId === managed.id && metadata.processingGeneration === generation));
    if (!cohort.length)
        return;
    // Revoke every approval capability before the first provider callback.
    for (const [requestId, metadata] of cohort) {
        sessionOperationContext.state.pendingPermissionRequests.delete(requestId);
        clearTimeout(metadata.timeout);
        sessionOpRejectPendingPrivilegedApproval(sessionOperationContext, requestId, metadata);
    }
    const deniedToolUseIds = sessionOpDeniedPermissionToolUseIds(sessionOperationContext, managed, generation);
    for (const [, metadata] of cohort) {
        if (metadata.toolUseId)
            deniedToolUseIds.add(metadata.toolUseId);
    }
    let receiptChanged = false;
    for (const [, metadata] of cohort) {
        receiptChanged = sessionOpMarkPermissionToolNotExecuted(sessionOperationContext, managed, metadata) || receiptChanged;
        try {
            sessionOperationContext.owner["emitExecutionTelemetry"](managed, {
                schemaVersion: 1,
                eventId: randomUUID(),
                timestamp: Date.now(),
                name: 'permission.resolved',
                correlation: { workspaceId: managed.workspace.id, sessionId: managed.id },
                permissionKind: metadata.type ?? metadata.toolName ?? 'unknown',
                resolution: 'denied',
                durationMs: Math.max(0, Date.now() - metadata.requestedAt),
            });
        }
        catch (error) {
            sessionLog.warn('Could not publish stopped permission telemetry', {
                sessionId: managed.id,
                requestId: metadata.request.requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (receiptChanged) {
        try {
            sessionOperationContext.owner["persistSession"](managed);
        }
        catch (error) {
            sessionLog.warn('Failed to enqueue stopped permission receipts', {
                sessionId: managed.id,
                generation,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        try {
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        catch (error) {
            sessionLog.warn('Failed to flush stopped permission receipts', {
                sessionId: managed.id,
                generation,
                error: error instanceof Error ? error.message : String(error),
            });
            try {
                sessionOperationContext.owner["persistSession"](managed);
            }
            catch (persistError) {
                sessionLog.warn('Failed to re-enqueue stopped permission receipts', {
                    sessionId: managed.id,
                    generation,
                    error: persistError instanceof Error ? persistError.message : String(persistError),
                });
            }
        }
    }
    for (const [requestId, metadata] of cohort) {
        sessionOpDenyPermissionOnRecordedRuntime(sessionOperationContext, requestId, metadata);
    }
}

function sessionOpReplayPendingPermissionRequests(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    const now = Date.now();
    for (const [requestId, metadata] of sessionOperationContext.state.pendingPermissionRequests.entries()) {
        if (metadata.sessionId !== managed.id)
            continue;
        if (!pendingPermissionCanReplay(metadata.requestedAt, metadata.expiresAt, now)) {
            sessionOpExpirePendingPermissionRequest(sessionOperationContext, requestId);
            continue;
        }
        sessionOperationContext.owner["sendEvent"]({
            type: 'permission_request',
            sessionId: managed.id,
            request: metadata.request,
        }, managed.workspace.id);
    }
}

/**
 * Apply external session header metadata to in-memory state and emit UI events.
 * Returns true if any in-memory metadata field changed.
 */
function sessionOpApplyExternalSessionMetadata(sessionOperationContext: SessionOperationContext, managed: ManagedSession, header: SessionHeader): boolean {
    const sessionId = managed.id;
    let changed = false;
    // Labels
    const oldLabels = JSON.stringify(managed.labels ?? []);
    const persistedLabels = JSON.stringify(header.labels ?? []);
    const sanitizedLabels = sanitizeParentSessionLabels(managed.id, managed.parentSessionId, header.labels);
    const newLabels = JSON.stringify(sanitizedLabels ?? []);
    if (oldLabels !== newLabels) {
        managed.labels = sanitizedLabels;
        sessionOperationContext.owner["sendEvent"]({ type: 'labels_changed', sessionId, labels: sanitizedLabels ?? [] }, managed.workspace.id);
        changed = true;
    }
    // Even if runtime state was already canonical, repair an externally written
    // corrupt header instead of silently accepting it until the next restart.
    if (persistedLabels !== newLabels)
        changed = true;
    // Flagged
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
        managed.isFlagged = header.isFlagged ?? false;
        sessionOperationContext.owner["sendEvent"]({ type: header.isFlagged ? 'session_flagged' : 'session_unflagged', sessionId }, managed.workspace.id);
        changed = true;
    }
    // Session status
    if (managed.sessionStatus !== header.sessionStatus) {
        managed.sessionStatus = header.sessionStatus;
        sessionOperationContext.owner["sendEvent"]({ type: 'session_status_changed', sessionId, sessionStatus: header.sessionStatus ?? '' }, managed.workspace.id);
        changed = true;
    }
    // Name
    if (managed.name !== header.name) {
        managed.name = header.name;
        sessionOperationContext.owner["sendEvent"]({ type: 'name_changed', sessionId, name: header.name }, managed.workspace.id);
        changed = true;
    }
    // Project binding (no dedicated event today — handled via metaChanged broadcast)
    if (managed.projectId !== header.projectId) {
        managed.projectId = header.projectId;
        changed = true;
    }
    // Kanban column (mutable via drag; reconcile external/multi-window changes)
    if (managed.kanbanColumn !== header.kanbanColumn) {
        managed.kanbanColumn = header.kanbanColumn;
        changed = true;
    }
    if (changed) {
        sessionLog.info(`External metadata change detected for session ${sessionId}`);
        // Prevent stale pending writes from reverting externally-updated metadata.
        sessionPersistenceQueue.cancel(sessionId, managed.persistenceRootPath);
        sessionOperationContext.owner["persistSession"](managed);
    }
    return changed;
}

export { sessionOpRejectPermissionRequestOutsideActiveGeneration as rejectPermissionRequestOutsideActiveGeneration };
export { sessionOpClosePendingPermissionRequestsForStop as closePendingPermissionRequestsForStop };
export { sessionOpReplayPendingPermissionRequests as replayPendingPermissionRequests };
export { sessionOpApplyExternalSessionMetadata as applyExternalSessionMetadata };
