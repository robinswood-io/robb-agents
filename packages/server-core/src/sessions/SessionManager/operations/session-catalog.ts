import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { refreshInheritedWorkspaceSources } from '../policy.ts';
import { isDeepStrictEqual } from 'node:util';
import { getWorkspaces, getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import type { Workspace, WorkspaceInfo } from '@craft-agent/shared/config';
import type { ActiveSessionInfo, SessionProcessingStatus } from '@craft-agent/core/types';
import type { Session, UnreadSummary } from '@craft-agent/shared/protocol';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import type { ManagedSession } from '../managed-session.ts';
import { isMissionRuntimeOwnedRecovery } from '../review-lifecycle.ts';
import { sessionRuntimeHooks } from '../runtime-platform.ts';
import type { MissionPendingTurnRecoveryClaim } from '../runtime-types.ts';
import { managedToSession } from '../session-presentation.ts';
import { loadSessionsFromDisk as sessionOpLoadSessionsFromDisk } from './session-loading.ts';
import { getUserInputRequests as sessionOpGetUserInputRequests } from './perform-request-user-input.ts';
import { ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';
import { replayPendingPermissionRequests as sessionOpReplayPendingPermissionRequests } from './close-pending-permission-requests-for-stop.ts';

function sessionOpGetWorkspaces(_sessionOperationContext: SessionOperationContext): Workspace[] {
    return getWorkspaces();
}

function sessionOpGetWorkspacesInfo(_sessionOperationContext: SessionOperationContext): WorkspaceInfo[] {
    return getWorkspaces().map(({ rootPath: _rootPath, createdAt: _createdAt, ...info }) => info);
}

function sessionOpGetActiveSessionCount(sessionOperationContext: SessionOperationContext, workspaceId?: string): number {
    let count = 0;
    for (const managed of sessionOperationContext.state.sessions.values()) {
        if (workspaceId && managed.workspace.id !== workspaceId)
            continue;
        if (managed.isProcessing)
            count++;
    }
    return count;
}

function sessionOpGetWorkspaceAutomationSummary(sessionOperationContext: SessionOperationContext, workspaceId: string): {
    automationCount: number;
    schedulerRunning: boolean;
} {
    const workspace = getWorkspaceByNameOrId(workspaceId);
    if (!workspace)
        return { automationCount: 0, schedulerRunning: false };
    const automationSystem = sessionOperationContext.state.automationSystems.get(workspace.rootPath);
    if (!automationSystem)
        return { automationCount: 0, schedulerRunning: false };
    const config = automationSystem.getConfig();
    let automationCount = 0;
    if (config) {
        for (const matchers of Object.values(config.automations)) {
            automationCount += matchers?.length ?? 0;
        }
    }
    return {
        automationCount,
        // SchedulerService is running if the system was created with enableScheduler
        schedulerRunning: !automationSystem.isDisposed(),
    };
}

function sessionOpGetActiveSessionsInfo(sessionOperationContext: SessionOperationContext): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = [];
    for (const managed of sessionOperationContext.state.sessions.values()) {
        if (!managed.isProcessing)
            continue;
        let status: SessionProcessingStatus = 'processing';
        if (managed.stopRequested)
            status = 'idle';
        result.push(omitUndefined<ActiveSessionInfo>({
            sessionId: managed.id,
            workspaceId: managed.workspace.id,
            workspaceName: managed.workspace.name,
            title: managed.name || undefined,
            status,
            triggeredBy: managed.triggeredBy
                ? { automationName: managed.triggeredBy.automationName ?? 'Unknown', timestamp: managed.triggeredBy.timestamp ?? 0 }
                : undefined,
            createdAt: managed.lastMessageAt,
        }));
    }
    return result;
}

/**
 * Reload all sessions from disk.
 * Used after importing sessions to refresh the in-memory session list.
 */
function sessionOpReloadSessions(sessionOperationContext: SessionOperationContext): void {
    sessionOpLoadSessionsFromDisk(sessionOperationContext);
}

function sessionOpGetSessions(sessionOperationContext: SessionOperationContext, workspaceId?: string): Session[] {
    // Returns session metadata only - messages are NOT included to save memory
    // Use getSession(id) to load messages for a specific session
    let sessions = Array.from(sessionOperationContext.state.sessions.values());
    // Filter by workspace if specified (used when switching workspaces)
    if (workspaceId) {
        sessions = sessions.filter(m => m.workspace.id === workspaceId);
    }
    const questionOrigins = sessions.filter(session => session.userInputRequests?.length);
    return sessions
        .map(m => managedToSession(m, { userInputRequests: sessionOpGetUserInputRequests(sessionOperationContext, m, questionOrigins) }))
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
}

/**
 * Resolve the session's workspace from the already-loaded metadata index.
 * Authorization checks must use this instead of getSession(), which owns the
 * intentional lazy-hydration boundary for transcript content.
 */
function sessionOpGetSessionWorkspaceId(sessionOperationContext: SessionOperationContext, sessionId: string): string | null {
    return sessionOperationContext.state.sessions.get(sessionId)?.workspace.id ?? null;
}

/**
 * Aggregate unread state across all workspaces.
 * Excludes hidden, archived and delegated child sessions from counts/indicators.
 */
function sessionOpGetUnreadSummary(sessionOperationContext: SessionOperationContext): UnreadSummary {
    const byWorkspace: Record<string, number> = {};
    const hasUnreadByWorkspace: Record<string, boolean> = {};
    for (const workspace of getWorkspaces()) {
        byWorkspace[workspace.id] = 0;
        hasUnreadByWorkspace[workspace.id] = false;
    }
    for (const session of sessionOperationContext.state.sessions.values()) {
        // Fail closed for internal work even when the direct parent edge was
        // missing from an older/cold metadata snapshot. These are host-owned
        // provenance fields, unlike labels or user-editable titles.
        if (session.hidden || session.isArchived || session.parentSessionId
            || session.delegation
            || session.taskNodeId
            || session.missionWorkItemId
            || session.missionRole === 'worker'
            || session.missionRole === 'reviewer')
            continue;
        if (!session.hasUnread)
            continue;
        const workspaceId = session.workspace.id;
        byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1;
        hasUnreadByWorkspace[workspaceId] = true;
    }
    const totalUnreadSessions = Object.values(byWorkspace).reduce((sum, count) => sum + count, 0);
    return {
        totalUnreadSessions,
        byWorkspace,
        hasUnreadByWorkspace,
    };
}

/**
 * Refresh badge count from current unread state.
 * Called by renderer on mount — ensures badge is set even if the initial
 * emitUnreadSummaryChanged() fired before the renderer was ready.
 */
function sessionOpRefreshBadge(sessionOperationContext: SessionOperationContext): void {
    const summary = sessionOperationContext.owner.getUnreadSummary();
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions);
}

/**
 * Broadcast global unread summary to all workspace windows.
 */
function sessionOpEmitUnreadSummaryChanged(sessionOperationContext: SessionOperationContext): void {
    const summary = sessionOperationContext.owner.getUnreadSummary();
    // Update badge via runtime hook — host decides whether/how to render badges
    sessionRuntimeHooks.updateBadgeCount(summary.totalUnreadSessions);
    if (!sessionOperationContext.state.eventSink)
        return;
    // Broadcast to renderers for UI updates (session list dots, etc.)
    sessionOperationContext.state.eventSink(RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED, { to: 'all' }, summary);
}

/**
 * Get a single session by ID with all messages loaded.
 * Used for lazy loading session messages when session is selected.
 * Messages are loaded from disk on first access to reduce memory usage.
 */
async function sessionOpGetSession(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<Session | null> {
    const m = sessionOperationContext.state.sessions.get(sessionId);
    if (!m || !sessionOpOwnsSessionOperation(sessionOperationContext, m))
        return null;
    // A caller comparing a durable execution boundary must observe current
    // workspace defaults, not the source snapshot from process startup.
    refreshInheritedWorkspaceSources(m);
    // Lazy-load messages from disk if not yet loaded
    await sessionOperationContext.owner["ensureMessagesLoaded"](m);
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, m))
        return null;
    // Renderer state is in-memory; re-emit any still-live request when a
    // session is reopened/reloaded so the agent cannot wait on an invisible UI.
    sessionOpReplayPendingPermissionRequests(sessionOperationContext, m);
    return managedToSession(m, { messages: m.messages, userInputRequests: sessionOpGetUserInputRequests(sessionOperationContext, m) });
}

function sessionOpMissionPendingTurnRecoveryClaimMismatch(sessionOperationContext: SessionOperationContext, managed: ManagedSession, claim: MissionPendingTurnRecoveryClaim): string | undefined {
    if (!sessionOperationContext.state.missionRuntimeOwnedRestoredRecoverySessionIds.has(managed.id)) {
        return 'the session has no restored Mission recovery awaiting ownership';
    }
    if (!isMissionRuntimeOwnedRecovery(managed)) {
        return 'the session is not a pending Mission dispatch';
    }
    if (managed.missionId !== claim.missionId
        || managed.missionWorkItemId !== claim.missionWorkItemId
        || managed.missionDispatchId !== claim.missionDispatchId) {
        return 'the Mission dispatch identity differs';
    }
    if (managed.permissionMode !== claim.boundary.permissionMode) {
        return 'the Mission permission mode differs';
    }
    const actualSourceSlugs = [...new Set(managed.enabledSourceSlugs ?? [])]
        .sort((left, right) => left.localeCompare(right));
    const expectedSourceSlugs = [...new Set(claim.boundary.enabledSourceSlugs)]
        .sort((left, right) => left.localeCompare(right));
    if (!isDeepStrictEqual(actualSourceSlugs, expectedSourceSlugs)) {
        return 'the Mission source boundary differs';
    }
    if (!isDeepStrictEqual(managed.executionIsolation, claim.boundary.executionIsolation)) {
        return 'the Mission execution isolation differs';
    }
    if (!isDeepStrictEqual(managed.missionOrdinaryRouteLock, claim.boundary.ordinaryRouteLock)) {
        return 'the Mission ordinary route lock differs';
    }
    if (managed.missionRouteLockSha256 !== claim.boundary.specializedRouteLockSha256) {
        return 'the Mission specialized route lock differs';
    }
    if (managed.llmConnection !== claim.boundary.llmConnection
        || managed.model !== claim.boundary.model
        || managed.thinkingLevel !== claim.boundary.thinkingLevel) {
        return 'the Mission provider route differs';
    }
    if (managed.workingDirectory !== claim.boundary.workingDirectory) {
        return 'the Mission working directory differs';
    }
    if (managed.missionRole !== claim.boundary.missionRole) {
        return 'the Mission role differs';
    }
    if (managed.connectionRoutePinned !== claim.boundary.connectionRoutePinned
        || managed.modelRoutePinned !== claim.boundary.modelRoutePinned
        || managed.thinkingLevelPinned !== claim.boundary.thinkingLevelPinned) {
        return 'the Mission provider pin state differs';
    }
    return undefined;
}

export { sessionOpGetWorkspaces as getWorkspaces };
export { sessionOpGetWorkspacesInfo as getWorkspacesInfo };
export { sessionOpGetActiveSessionCount as getActiveSessionCount };
export { sessionOpGetWorkspaceAutomationSummary as getWorkspaceAutomationSummary };
export { sessionOpGetActiveSessionsInfo as getActiveSessionsInfo };
export { sessionOpReloadSessions as reloadSessions };
export { sessionOpGetSessions as getSessions };
export { sessionOpGetSessionWorkspaceId as getSessionWorkspaceId };
export { sessionOpGetUnreadSummary as getUnreadSummary };
export { sessionOpRefreshBadge as refreshBadge };
export { sessionOpEmitUnreadSummaryChanged as emitUnreadSummaryChanged };
export { sessionOpGetSession as getSession };
export { sessionOpMissionPendingTurnRecoveryClaimMismatch as missionPendingTurnRecoveryClaimMismatch };
