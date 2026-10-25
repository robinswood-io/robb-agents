import type { SessionOperationContext } from '../operation-context.ts';
import type { PermissionMode } from '@craft-agent/shared/agent';
import { getDefaultLlmConnection } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels';
import type { ManagedSession } from '../managed-session.ts';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import { resolveCreateSessionRouteProvenance } from '../session-creation.ts';
import { resolveSupportsBranching } from '../source-selection.ts';
import { ownsSessionOperation as sessionOpOwnsSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, assertSessionMutationAdmissionOpen as sessionOpAssertSessionMutationAdmissionOpen } from './track-session-operation.ts';

async function sessionOpPerformBindExistingSessionToTask(sessionOperationContext: SessionOperationContext, managed: ManagedSession, taskSlug: string, reconcile?: {
    name?: string;
    projectId?: string;
    workingDirectory?: string;
    model?: string;
    llmConnection?: string;
    permissionMode?: PermissionMode;
}): Promise<boolean> {
    const sessionId = managed.id;
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return false;
    if (hasImmutableMissionRoute(managed)) {
        sessionLog.warn('bindExistingSessionToTask: Mission session is immutable', {
            sessionId, taskSlug,
        });
        return false;
    }
    if (managed.taskSlug) {
        if (managed.taskSlug === taskSlug)
            return true;
        sessionLog.warn('bindExistingSessionToTask: slug mismatch, refusing to rebind', {
            sessionId, existing: managed.taskSlug, requested: taskSlug,
        });
        return false;
    }
    const requestedRoute = reconcile?.model !== undefined || reconcile?.llmConnection !== undefined
        ? resolveCreateSessionRouteProvenance({
            model: reconcile.model,
            modelRoutePinned: reconcile.model !== undefined,
            llmConnection: reconcile.llmConnection
                ?? (reconcile.model !== undefined ? managed.llmConnection : undefined),
            connectionRoutePinned: reconcile.llmConnection !== undefined ? true : undefined,
        }, managed.llmConnection
            ?? loadWorkspaceConfig(managed.workspace.rootPath)?.defaults?.defaultLlmConnection
            ?? getDefaultLlmConnection()
            ?? undefined)
        : undefined;
    if (requestedRoute?.llmConnection && managed.connectionLocked
        && requestedRoute.llmConnection !== managed.llmConnection) {
        sessionLog.warn('bindExistingSessionToTask: locked connection cannot be reconciled', {
            sessionId, current: managed.llmConnection, requested: requestedRoute.llmConnection,
        });
        return false;
    }
    // What actually changes — so we fire canonical live-updates (agent + caches + per-field events)
    // only when needed. A quick-add tile is already live, so these keep its running agent in step.
    const modelChanged = Boolean(reconcile?.model && reconcile.model !== managed.model);
    const connectionChanged = Boolean(requestedRoute?.llmConnection
        && requestedRoute.llmConnection !== managed.llmConnection);
    const cwdChanged = Boolean(reconcile?.workingDirectory && reconcile.workingDirectory !== managed.workingDirectory);
    const modeChanged = Boolean(reconcile?.permissionMode && reconcile.permissionMode !== managed.permissionMode);
    // Promote task metadata (no canonical mutator for these). Connection is set directly because
    // setSessionConnection() refuses a session that has already sent messages (a quick-add tile has);
    // the connection_changed event below keeps the renderer in sync.
    managed.taskSlug = taskSlug;
    managed.taskDraft = false;
    if (reconcile?.projectId !== undefined)
        managed.projectId = reconcile.projectId;
    if (connectionChanged)
        managed.llmConnection = requestedRoute!.llmConnection;
    if (requestedRoute) {
        managed.connectionRoutePinned = requestedRoute.connectionRoutePinned;
        managed.modelRoutePinned = requestedRoute.modelRoutePinned;
    }
    const renamed = Boolean(reconcile?.name && reconcile.name !== managed.name);
    if (renamed)
        managed.name = reconcile!.name!;
    // Route model / cwd / permission mode through the canonical mutators so the LIVE agent, caches,
    // and per-field events stay consistent — not just the on-disk metadata (the split-brain the
    // follow-up review flagged). Synchronous updates run before the first await;
    // the model helper is invoked inside this already-owned lease.
    if (cwdChanged)
        sessionOperationContext.owner.updateWorkingDirectory(sessionId, reconcile!.workingDirectory!);
    if (modeChanged)
        sessionOperationContext.owner.setSessionPermissionMode(sessionId, reconcile!.permissionMode!);
    if (modelChanged)
        await sessionOperationContext.owner["performUpdateSessionModel"](managed, reconcile!.model!);
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    sessionOperationContext.owner["setMetadataWriteGuard"](managed);
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    const changes: {
        taskDraft: boolean;
        taskSlug: string;
        projectId?: string;
    } = { taskDraft: false, taskSlug };
    if (reconcile?.projectId !== undefined)
        changes.projectId = reconcile.projectId;
    sessionOperationContext.owner["sendEvent"]({ type: 'session_metadata_changed', sessionId, changes }, managed.workspace.id);
    if (renamed) {
        sessionOperationContext.owner["sendEvent"]({ type: 'name_changed', sessionId, name: managed.name }, managed.workspace.id);
    }
    if (connectionChanged) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'connection_changed',
            sessionId,
            connectionSlug: managed.llmConnection!,
            supportsBranching: resolveSupportsBranching(managed),
        }, managed.workspace.id);
    }
    const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
    watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
    sessionLog.info('bindExistingSessionToTask: bound existing session', { sessionId, taskSlug, renamed, modelChanged, connectionChanged, cwdChanged, modeChanged });
    return true;
}

/**
 * Set the thinking level for a session. See {@link ThinkingLevel} for valid values.
 * This is sticky and persisted across messages.
 */
function sessionOpSetSessionThinkingLevel(sessionOperationContext: SessionOperationContext, sessionId: string, level: ThinkingLevel): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed) {
        sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext, managed);
        if (hasImmutableMissionRoute(managed)) {
            throw new Error('Mission session route is immutable');
        }
        // Update thinking level in managed session
        managed.thinkingLevel = level;
        managed.thinkingLevelPinned = true;
        // Update the agent's thinking level if it exists
        if (managed.agent) {
            managed.agent.setThinkingLevel(level);
        }
        sessionLog.info(`Session ${sessionId}: thinking level set to ${level}`);
        // Persist to disk
        sessionOperationContext.owner["persistSession"](managed);
    }
}

export { sessionOpPerformBindExistingSessionToTask as performBindExistingSessionToTask };
export { sessionOpSetSessionThinkingLevel as setSessionThinkingLevel };
