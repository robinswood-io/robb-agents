import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { loadSession as loadStoredSession, getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import type { SessionDelegation, MissionOrdinaryRouteLock } from '@craft-agent/shared/sessions';
import type { Session, CreateSessionOptions } from '@craft-agent/shared/protocol';
import { storedToMessage } from '@craft-agent/core/types';
import type { TokenUsage } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { repairPersistedFalseCompletion } from '../session-creation.ts';
import { resolveEffectiveSessionSourceSelection } from '../source-selection.ts';
import { restoreDurableRuntimeState as sessionOpRestoreDurableRuntimeState } from './restore-durable-runtime-state.ts';
import { ownsSessionOperation as sessionOpOwnsSessionOperation, trackManagerOperation as sessionOpTrackManagerOperation } from './track-session-operation.ts';

/**
 * Ensure messages are loaded for a managed session.
 * Uses promise deduplication to prevent race conditions when multiple
 * concurrent calls (e.g., rapid session switches + message send) try
 * to load messages simultaneously.
 */
async function sessionOpEnsureMessagesLoaded(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    if (managed.messagesLoaded)
        return;
    // Deduplicate concurrent loads - return existing promise if already loading
    const existingPromise = sessionOperationContext.state.messageLoadingPromises.get(managed.id);
    if (existingPromise) {
        return existingPromise;
    }
    const loadPromise = sessionOpLoadMessagesFromDisk(sessionOperationContext, managed);
    sessionOperationContext.state.messageLoadingPromises.set(managed.id, loadPromise);
    try {
        await loadPromise;
    }
    finally {
        sessionOperationContext.state.messageLoadingPromises.delete(managed.id);
    }
}

/**
 * Internal: Load messages from disk storage into the managed session.
 */
async function sessionOpLoadMessagesFromDisk(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    const storedSession = loadStoredSession(persistenceRootFor(managed), managed.id);
    if (storedSession) {
        managed.messages = (storedSession.messages || []).map(storedToMessage);
        managed.tokenUsage = storedSession.tokenUsage;
        managed.lastReadMessageId = storedSession.lastReadMessageId;
        managed.hasUnread = storedSession.hasUnread; // Explicit unread flag for NEW badge state machine
        Object.assign(managed, resolveEffectiveSessionSourceSelection(storedSession.enabledSourceSlugs, loadWorkspaceConfig(managed.workspace.rootPath)?.defaults?.enabledSourceSlugs));
        managed.sharedUrl = storedSession.sharedUrl;
        managed.sharedId = storedSession.sharedId;
        // Sync name from disk - ensures title persistence across lazy loading
        managed.name = storedSession.name;
        // Restore LLM connection state - ensures correct provider on resume
        if (storedSession.llmConnection) {
            managed.llmConnection = storedSession.llmConnection;
        }
        if (storedSession.connectionLocked) {
            managed.connectionLocked = storedSession.connectionLocked;
        }
        // Sync transferred session summary state from disk
        managed.transferredSessionSummary = storedSession.transferredSessionSummary;
        managed.transferredSessionSummaryApplied = storedSession.transferredSessionSummaryApplied;
        managed.autonomyEvents = storedSession.autonomyEvents;
        sessionLog.debug(`Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`);
        const repairedFalseCompletion = repairPersistedFalseCompletion(managed);
        sessionOpRestoreDurableRuntimeState(sessionOperationContext, managed);
        managed.messagesLoaded = true;
        if (repairedFalseCompletion) {
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
        }
    }
    managed.messagesLoaded = true;
}

/**
 * Get the filesystem path to a session's folder
 */
function sessionOpGetSessionPath(sessionOperationContext: SessionOperationContext, sessionId: string): string | null {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed || !sessionOpOwnsSessionOperation(sessionOperationContext, managed))
        return null;
    return getSessionStoragePath(persistenceRootFor(managed), sessionId);
}

async function sessionOpCreateSession(sessionOperationContext: SessionOperationContext, workspaceId: string, options?: CreateSessionOptions, 
// Transport concern, deliberately NOT on the wire DTO: by default every created session is
// announced to the renderer (see notifySessionCreated). Callers that register the session
// themselves — the `sessions:create` RPC adds it from the return value — pass
// `{ emitCreatedEvent: false }` to avoid a redundant hydrate.
internal?: {
    emitCreatedEvent?: boolean;
    delegation?: SessionDelegation;
    /** Host-owned only; deliberately excluded from the renderer CreateSessionOptions DTO. */
    missionOrdinaryRouteLock?: MissionOrdinaryRouteLock;
}): Promise<Session> {
    return sessionOpTrackManagerOperation(sessionOperationContext, () => sessionOperationContext.owner.performCreateSession(workspaceId, options, internal));
}

/**
 * Announce a session to the renderer so it hydrates full metadata (name, parentSessionId, …)
 * instead of fabricating a "New Chat" placeholder from the first streamed event.
 *
 * `createSession` calls this by default, so server-side creators get it for free. Use it
 * directly only for sessions built outside `createSession` (e.g. the SessionBundle import
 * path, which assembles a ManagedSession by hand). The renderer handler is idempotent.
 */
function sessionOpNotifySessionCreated(sessionOperationContext: SessionOperationContext, workspaceId: string, sessionId: string): void {
    sessionOperationContext.owner["sendEvent"]({ type: 'session_created', sessionId }, workspaceId);
}

/** Resolved working directory of a live session (used by the Tasks Conductor so child
 *  sessions inherit the orchestrator's cwd). Undefined if the session has none or is unknown. */
function sessionOpGetSessionWorkingDirectory(sessionOperationContext: SessionOperationContext, sessionId: string): string | undefined {
    return sessionOperationContext.state.sessions.get(sessionId)?.workingDirectory;
}

/** Durable Tasks-Conductor reviewer lookup. The task metadata is persisted in
 * the session header by createSession, so a reviewer created immediately
 * before process loss remains discoverable even if the run output was not yet
 * updated with its id. */
function sessionOpListTaskReviewerSessions(sessionOperationContext: SessionOperationContext, workspaceId: string, taskSlug: string, taskRunId: string, parentSessionId: string): Array<{
    id: string;
    isProcessing: boolean;
    tokenUsage?: TokenUsage;
    finalText?: string;
}> {
    return [...sessionOperationContext.state.sessions.values()]
        .filter(session => session.workspace.id === workspaceId
        && session.taskSlug === taskSlug
        && session.taskRunId === taskRunId
        && session.taskNodeId === '__verdict__'
        && session.missionRole === 'reviewer'
        && session.parentSessionId === parentSessionId
        // UI status is not execution authority. Include a processing reviewer
        // even if its tile was moved while the process was alive; otherwise a
        // restart could create a second reviewer beside it.
        && (session.sessionStatus === 'in-progress' || session.isProcessing))
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
        .map(session => {
            const finalText = sessionOperationContext.owner.getSessionFinalText(session.id);
            return {
                id: session.id,
                isProcessing: session.isProcessing,
                ...(session.tokenUsage ? { tokenUsage: { ...session.tokenUsage } } : {}),
                ...(finalText !== undefined ? { finalText } : {}),
            };
        });
}

/** Durable Tasks-Conductor worker lookup. Task linkage is written in the
 * session header by createSession, so a process loss between creation and the
 * node-spawned log cannot orphan a spending child. */
function sessionOpListTaskWorkerSessions(sessionOperationContext: SessionOperationContext, workspaceId: string, taskSlug: string, taskRunId: string): Array<{
    id: string;
    isProcessing: boolean;
    tokenUsage?: TokenUsage;
    finalText?: string;
}> {
    return [...sessionOperationContext.state.sessions.values()]
        .filter(session => session.workspace.id === workspaceId
        && session.taskSlug === taskSlug
        && session.taskRunId === taskRunId
        && !!session.taskNodeId
        && session.taskNodeId !== '__verdict__'
        && (session.sessionStatus === 'in-progress' || session.isProcessing))
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
        .map(session => {
            const finalText = sessionOperationContext.owner.getSessionFinalText(session.id);
            return {
                id: session.id,
                isProcessing: session.isProcessing,
                ...(session.tokenUsage ? { tokenUsage: { ...session.tokenUsage } } : {}),
                ...(finalText !== undefined ? { finalText } : {}),
            };
        });
}

export { sessionOpEnsureMessagesLoaded as ensureMessagesLoaded };
export { sessionOpLoadMessagesFromDisk as loadMessagesFromDisk };
export { sessionOpGetSessionPath as getSessionPath };
export { sessionOpCreateSession as createSession };
export { sessionOpNotifySessionCreated as notifySessionCreated };
export { sessionOpGetSessionWorkingDirectory as getSessionWorkingDirectory };
export { sessionOpListTaskReviewerSessions as listTaskReviewerSessions };
export { sessionOpListTaskWorkerSessions as listTaskWorkerSessions };
