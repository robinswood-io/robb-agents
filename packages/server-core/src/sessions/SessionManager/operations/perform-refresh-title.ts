import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { createBackendFromConnection } from '@craft-agent/shared/agent/backend';
import { getLlmConnection, getPersistedUiLanguage, resolveTitleLanguageName, getMiniModel } from '@craft-agent/shared/config';
import { isValidWorkingDirectory } from '../../../utils/path-validation';
import { i18n } from '@craft-agent/shared/i18n';
import { updateSessionMetadata } from '@craft-agent/shared/sessions';
import { selectSpreadMessages } from '@craft-agent/shared/utils';
import { invalidateSkillsCache } from '@craft-agent/shared/skills';
import { invalidateContextFileCache } from '@craft-agent/shared/prompts/system';
import type { ManagedSession } from '../managed-session.ts';
import { buildBackendHostRuntimeContext, hasImmutableMissionRoute, hasMissionDispatchTriplet } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, ownsSessionOperation as sessionOpOwnsSessionOperation, assertSessionMutationAdmissionOpen as sessionOpAssertSessionMutationAdmissionOpen } from './track-session-operation.ts';
import { getLastFinalAssistantMessageId as sessionOpGetLastFinalAssistantMessageId } from './session-sources.ts';
import { evaluateAndApplyAutoLabels as sessionOpEvaluateAndApplyAutoLabels } from './perform-adopt-generated-task-orchestrator.ts';

/**
 * Clear active viewing session for a workspace.
 * Called when all windows leave a workspace to ensure read/unread state is correct.
 */
function sessionOpClearActiveViewingSession(sessionOperationContext: SessionOperationContext, workspaceId: string): void {
    sessionOperationContext.state.activeViewingSession.delete(workspaceId);
}

/**
 * Check if a session is currently being viewed by the user
 */
function sessionOpIsSessionBeingViewed(sessionOperationContext: SessionOperationContext, sessionId: string, workspaceId: string): boolean {
    return sessionOperationContext.state.activeViewingSession.get(workspaceId) === sessionId;
}

/**
 * Mark a session as read by setting lastReadMessageId and clearing hasUnread.
 * Called when user navigates to a session (and it's not processing).
 */
async function sessionOpMarkSessionRead(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        // Only mark as read if not currently processing
        // (user is viewing but we want to wait for processing to complete)
        if (managed.isProcessing)
            return;
        let needsPersist = false;
        const updates: {
            lastReadMessageId?: string;
            hasUnread?: boolean;
        } = {};
        // Update lastReadMessageId for legacy/manual unread functionality
        if (managed.messages.length > 0) {
            const lastFinalId = sessionOpGetLastFinalAssistantMessageId(sessionOperationContext, managed.messages);
            if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
                managed.lastReadMessageId = lastFinalId;
                updates.lastReadMessageId = lastFinalId;
                needsPersist = true;
            }
        }
        // Clear hasUnread flag (primary source of truth for NEW badge)
        if (managed.hasUnread) {
            managed.hasUnread = false;
            updates.hasUnread = false;
            needsPersist = true;
        }
        // Persist changes
        if (needsPersist) {
            await updateSessionMetadata(persistenceRootFor(managed), sessionId, updates, managed.persistenceRootIdentity);
            sessionOperationContext.owner["emitUnreadSummaryChanged"]();
        }
    });
}

/**
 * Mark a session as unread by setting hasUnread flag.
 * Called when user manually marks a session as unread via context menu.
 */
async function sessionOpMarkSessionUnread(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        managed.hasUnread = true;
        managed.lastReadMessageId = undefined;
        // Persist to disk
        await updateSessionMetadata(persistenceRootFor(managed), sessionId, { hasUnread: true, lastReadMessageId: undefined }, managed.persistenceRootIdentity);
        sessionOperationContext.owner["emitUnreadSummaryChanged"]();
    });
}

/**
 * Mark all non-hidden, non-archived sessions in a workspace as read.
 * Called from "Mark All Read" context menu on "All Sessions".
 */
async function sessionOpMarkAllSessionsRead(sessionOperationContext: SessionOperationContext, workspaceId: string): Promise<void> {
    const updates: Promise<void>[] = [];
    for (const managed of sessionOperationContext.state.sessions.values()) {
        if (managed.workspace.id !== workspaceId)
            continue;
        if (managed.hidden || managed.isArchived)
            continue;
        if (managed.isProcessing)
            continue;
        if (!managed.hasUnread)
            continue;
        if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed))
            continue;
        updates.push(sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.hasUnread = false;
            await updateSessionMetadata(persistenceRootFor(managed), managed.id, { hasUnread: false }, managed.persistenceRootIdentity);
        }));
    }
    if (updates.length > 0) {
        await Promise.all(updates);
        sessionOperationContext.owner["emitUnreadSummaryChanged"]();
    }
}

async function sessionOpRenameSession(sessionOperationContext: SessionOperationContext, sessionId: string, name: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.name = name;
            sessionOperationContext.owner["persistSession"](managed);
            // Notify renderer of the name change
            sessionOperationContext.owner["sendEvent"]({ type: 'title_generated', sessionId, title: name }, managed.workspace.id);
            // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
            // directories created after the watcher started.
            // https://github.com/oven-sh/bun/issues/15939
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
        });
}

/**
 * Regenerate the session title based on recent messages.
 * Uses the last few user messages to capture what the session has evolved into.
 * Automatically uses the same provider as the session (Claude or OpenAI).
 */
async function sessionOpRefreshTitle(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<{
    success: boolean;
    title?: string;
    error?: string;
}> {
    sessionLog.info(`refreshTitle called for session ${sessionId}`);
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`refreshTitle: Session ${sessionId} not found`);
        return { success: false, error: 'Session not found' };
    }
    if (hasImmutableMissionRoute(managed)) {
        return { success: false, error: 'Title generation is disabled for a route-sealed Mission session' };
    }
    if (hasMissionDispatchTriplet(managed)) {
        return { success: false, error: 'Title generation is disabled for a Mission session' };
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformRefreshTitle(sessionOperationContext, managed));
}

async function sessionOpPerformRefreshTitle(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<{
    success: boolean;
    title?: string;
    error?: string;
}> {
    const sessionId = managed.id;
    // Ensure messages are loaded from disk (lazy loading support)
    await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
    if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
        return { success: false, error: 'Session is being deleted' };
    }
    // Select a spread of user messages (first, middle, last) to capture the session's purpose
    const allUserContents = managed.messages
        .filter((m) => m.role === 'user')
        .map((m) => m.content);
    const userMessages = selectSpreadMessages(allUserContents);
    sessionLog.info(`refreshTitle: Selected ${userMessages.length} spread messages from ${allUserContents.length} total`);
    if (userMessages.length === 0) {
        sessionLog.warn(`refreshTitle: No user messages found`);
        return { success: false, error: 'No user messages to generate title from' };
    }
    // Get the most recent assistant response
    const lastAssistantMsg = managed.messages
        .filter((m) => m.role === 'assistant' && !m.isIntermediate)
        .slice(-1)[0];
    const assistantResponse = lastAssistantMsg?.content ?? '';
    // Resolve title language from the explicitly persisted UI language (disk-backed,
    // race-free vs. main-process i18n async hydration); undefined => auto-detect (#885).
    const titleLanguage = resolveTitleLanguageName();
    const titleOptions = { language: titleLanguage };
    sessionLog.info(`[refreshTitle] language at call time`, {
        sessionId,
        persistedUiLanguage: getPersistedUiLanguage() ?? null,
        resolvedLanguage: i18n.resolvedLanguage ?? null,
        titleLanguage: titleLanguage ?? null,
    });
    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent;
    let isTemporary = false;
    if (!agent && managed.llmConnection) {
        try {
            const connection = getLlmConnection(managed.llmConnection);
            const resolvedMiniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined;
            agent = createBackendFromConnection(managed.llmConnection, {
                workspace: managed.workspace,
                ...(managed.model !== undefined ? { model: managed.model } : {}),
                ...(managed.thinkingLevel !== undefined ? { thinkingLevel: managed.thinkingLevel } : {}),
                isModelRoutePinned: () => managed.modelRoutePinned === true,
                ...(resolvedMiniModel !== undefined ? { miniModel: resolvedMiniModel } : {}),
                session: {
                    id: `title-${managed.id}`,
                    workspaceRootPath: managed.workspace.rootPath,
                    llmConnection: managed.llmConnection,
                    createdAt: Date.now(),
                    lastUsedAt: Date.now(),
                },
                isHeadless: true,
            }, buildBackendHostRuntimeContext()) as AgentInstance;
            await agent.postInit();
            isTemporary = true;
            if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
                agent.destroy();
                return { success: false, error: 'Session is being deleted' };
            }
            sessionLog.info(`refreshTitle: Created temporary agent for session ${sessionId}`);
        }
        catch (error) {
            if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
                return { success: false, error: 'Session is being deleted' };
            }
            sessionLog.error(`refreshTitle: Failed to create temporary agent:`, error);
            return { success: false, error: 'Failed to create agent for title generation' };
        }
    }
    if (!agent) {
        sessionLog.warn(`refreshTitle: No agent and no connection for session ${sessionId}`);
        return { success: false, error: 'No agent available' };
    }
    sessionLog.info(`refreshTitle: Calling agent.regenerateTitle...`);
    // Notify renderer that title regeneration has started (for shimmer effect)
    managed.isAsyncOperationOngoing = true;
    sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id);
    // Keep legacy event for backward compatibility
    sessionOperationContext.owner["sendEvent"]({ type: 'title_regenerating', sessionId, isRegenerating: true }, managed.workspace.id);
    try {
        const title = await agent.regenerateTitle(userMessages, assistantResponse, omitUndefined(titleOptions));
        if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
            return { success: false, error: 'Session is being deleted' };
        }
        sessionLog.info(`refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`);
        if (title) {
            managed.name = title;
            sessionOperationContext.owner["persistSession"](managed);
            // title_generated will also clear isRegeneratingTitle via the event handler
            sessionOperationContext.owner["sendEvent"]({ type: 'title_generated', sessionId, title }, managed.workspace.id);
            sessionLog.info(`Refreshed title for session ${sessionId}: "${title}"`);
            // Evaluate auto-labels on refreshed title + context to update session topic
            sessionOpEvaluateAndApplyAutoLabels(sessionOperationContext, managed, `${title}\n${userMessages.join(' ')}`);
            return { success: true, title };
        }
        // Failed to generate - clear regenerating state
        sessionOperationContext.owner["sendEvent"]({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id);
        return { success: false, error: 'Failed to generate title' };
    }
    catch (error) {
        if (!sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
            return { success: false, error: 'Session is being deleted' };
        }
        // Error occurred - clear regenerating state
        sessionOperationContext.owner["sendEvent"]({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id);
        const message = error instanceof Error ? error.message : 'Unknown error';
        sessionLog.error(`Failed to refresh title for session ${sessionId}:`, error);
        return { success: false, error: message };
    }
    finally {
        // Clean up temporary agent
        if (isTemporary && agent) {
            agent.destroy();
        }
        // Signal async operation end
        managed.isAsyncOperationOngoing = false;
        if (sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
            sessionOperationContext.owner["sendEvent"]({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id);
        }
    }
}

/**
 * Update the working directory for a session.
 *
 * If no messages have been sent yet (no SDK interaction), also updates sdkCwd
 * so the SDK will use the new path for transcript storage. This prevents the
 * confusing "bash shell runs from a different directory" warning when the user
 * changes the working directory before their first message.
 */
function sessionOpUpdateWorkingDirectory(sessionOperationContext: SessionOperationContext, sessionId: string, path: string): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed) {
        sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext, managed);
        if ((hasImmutableMissionRoute(managed) || hasMissionDispatchTriplet(managed))
            && path !== managed.workingDirectory) {
            throw new Error('Mission session working directory is immutable');
        }
        const validation = isValidWorkingDirectory(path);
        if (!validation.valid) {
            sessionLog.warn(`Session ${sessionId}: rejected working directory "${path}" — ${validation.reason}`);
            sessionOperationContext.owner["sendEvent"]({
                type: 'working_directory_error',
                sessionId,
                error: validation.reason!,
            }, managed.workspace.id);
            return;
        }
        managed.workingDirectory = path;
        // Invalidate filesystem caches that depend on working directory
        invalidateContextFileCache(path);
        invalidateSkillsCache();
        // Check if we can also update sdkCwd (safe if no SDK interaction yet)
        // Conditions: no messages sent AND no agent created yet (no SDK session)
        const shouldUpdateSdkCwd = managed.messages.length === 0 &&
            !managed.sdkSessionId &&
            !managed.agent;
        if (shouldUpdateSdkCwd) {
            managed.sdkCwd = path;
            sessionLog.info(`Session ${sessionId}: sdkCwd updated to ${path} (no prior interaction)`);
        }
        // Also update the agent's session config if agent exists
        if (managed.agent) {
            managed.agent.updateWorkingDirectory(path);
            // If agent exists but conditions still allow sdkCwd update (edge case),
            // update the agent's sdkCwd as well
            if (shouldUpdateSdkCwd) {
                managed.agent.updateSdkCwd(path);
            }
        }
        sessionOperationContext.owner["persistSession"](managed);
        // Notify renderer of the working directory change
        sessionOperationContext.owner["sendEvent"]({ type: 'working_directory_changed', sessionId, workingDirectory: path }, managed.workspace.id);
    }
}

/**
 * Update the model for a session
 * Pass null to clear the session-specific model (will use global config)
 * @param connection - Optional LLM connection slug (only applied if not already locked)
 */
async function sessionOpUpdateSessionModel(sessionOperationContext: SessionOperationContext, sessionId: string, _workspaceId: string, model: string | null, connection?: string): Promise<void> {
    sessionLog.info(`[updateSessionModel] sessionId=${sessionId}, model=${model}, connection=${connection}`);
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOperationContext.owner["performUpdateSessionModel"](managed, model, connection));
}

/**
 * Update the content of a specific message in a session
 * Used by preview window to save edited content back to the original message
 */
function sessionOpUpdateMessageContent(sessionOperationContext: SessionOperationContext, sessionId: string, messageId: string, content: string): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`Cannot update message: session ${sessionId} not found`);
        return;
    }
    sessionOpAssertSessionMutationAdmissionOpen(sessionOperationContext, managed);
    const message = managed.messages.find(m => m.id === messageId);
    if (!message) {
        sessionLog.warn(`Cannot update message: message ${messageId} not found in session ${sessionId}`);
        return;
    }
    // Update the message content
    message.content = content;
    // Persist the updated session
    sessionOperationContext.owner["persistSession"](managed);
    sessionLog.info(`Updated message ${messageId} content in session ${sessionId}`);
}

export { sessionOpClearActiveViewingSession as clearActiveViewingSession };
export { sessionOpIsSessionBeingViewed as isSessionBeingViewed };
export { sessionOpMarkSessionRead as markSessionRead };
export { sessionOpMarkSessionUnread as markSessionUnread };
export { sessionOpMarkAllSessionsRead as markAllSessionsRead };
export { sessionOpRenameSession as renameSession };
export { sessionOpRefreshTitle as refreshTitle };
export { sessionOpPerformRefreshTitle as performRefreshTitle };
export { sessionOpUpdateWorkingDirectory as updateWorkingDirectory };
export { sessionOpUpdateSessionModel as updateSessionModel };
export { sessionOpUpdateMessageContent as updateMessageContent };
