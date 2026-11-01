import type { SessionOperationContext } from '../operation-context.ts';
import { refreshInheritedWorkspaceSources, persistenceRootFor } from '../policy.ts';
import { isDeepStrictEqual } from 'node:util';
import { cleanupSourceRuntimeArtifacts } from '@craft-agent/shared/agent/backend';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { loadAllSources, getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources';
import type { Message } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import { canonicalMissionSourceSlugs, hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, assertSessionRuntimeOperationOwner as sessionOpAssertSessionRuntimeOperationOwner, ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';

// ============================================
// Session Sources
// ============================================
/**
 * Update session's enabled sources
 * If agent exists, builds and applies servers immediately.
 * Otherwise, servers will be built fresh on next message.
 */
async function sessionOpSetSessionSources(sessionOperationContext: SessionOperationContext, sessionId: string, sourceSlugs: string[]): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        throw new Error(`Session not found: ${sessionId}`);
    }
    if (hasImmutableMissionRoute(managed)
        && !isDeepStrictEqual(canonicalMissionSourceSlugs(sourceSlugs), canonicalMissionSourceSlugs(managed.enabledSourceSlugs))) {
        throw new Error('Mission session sources are immutable');
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpSetSessionSourcesWithinOperation(sessionOperationContext, managed, [...sourceSlugs]));
}

async function sessionOpSetSessionSourcesWithinOperation(sessionOperationContext: SessionOperationContext, managed: ManagedSession, sourceSlugs: string[]): Promise<void> {
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    const sessionId = managed.id;
    const workspaceRootPath = managed.workspace.rootPath;
    sessionLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs);
    // Clean up credential cache for sources being disabled (security)
    // This removes decrypted tokens from disk when sources are no longer active
    const previousSlugs = new Set(managed.enabledSourceSlugs || []);
    const newSlugs = new Set(sourceSlugs);
    const disabledSlugs = [...previousSlugs].filter(prevSlug => !newSlugs.has(prevSlug));
    if (disabledSlugs.length > 0) {
        try {
            await cleanupSourceRuntimeArtifacts(workspaceRootPath, disabledSlugs);
        }
        catch (err) {
            sessionLog.warn(`Failed to clean up source runtime artifacts: ${err}`);
        }
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    }
    // Store the selection
    managed.enabledSourceSlugs = sourceSlugs;
    managed.inheritsWorkspaceSourceSlugs = false;
    // If agent exists, build and apply servers immediately
    if (managed.agent) {
        const agent = managed.agent;
        const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs);
        // Pass session path so large API responses can be saved to session folder
        const sessionPath = getSessionStoragePath(persistenceRootFor(managed), sessionId);
        const { mcpServers, apiServers, errors } = await sessionOperationContext.owner.buildSessionSourceServers(managed, sources, sessionPath);
        sessionOpAssertSessionRuntimeOperationOwner(sessionOperationContext, managed, agent);
        if (errors.length > 0) {
            sessionLog.warn(`Source build errors:`, errors);
        }
        // Set all sources for context (agent sees full list with descriptions, including built-ins)
        const allSources = loadAllSources(workspaceRootPath);
        agent.setAllSources(allSources);
        // Set active source servers (tools are only available from these)
        const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug);
        sessionOpAssertSessionRuntimeOperationOwner(sessionOperationContext, managed, agent);
        await agent.setSourceServers(mcpServers, apiServers, intendedSlugs);
        sessionOpAssertSessionRuntimeOperationOwner(sessionOperationContext, managed, agent);
        sessionLog.info(`Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`);
    }
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    // Persist the session with updated sources
    sessionOperationContext.owner["persistSession"](managed);
    // Notify renderer of the source change
    sessionOperationContext.owner["sendEvent"]({
        type: 'sources_changed',
        sessionId,
        enabledSourceSlugs: sourceSlugs,
    }, managed.workspace.id);
    sessionLog.info(`Session ${sessionId} sources updated: ${sourceSlugs.length} sources`);
}

/**
 * Get the enabled source slugs for a session
 */
function sessionOpGetSessionSources(sessionOperationContext: SessionOperationContext, sessionId: string): string[] {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        refreshInheritedWorkspaceSources(managed);
    return managed?.enabledSourceSlugs ?? [];
}

/**
 * Get the last final assistant message ID from a list of messages
 * A "final" message is one where:
 * - role === 'assistant' AND
 * - isIntermediate !== true (not commentary between tool calls)
 * Returns undefined if no final assistant message exists
 */
function sessionOpGetLastFinalAssistantMessageId(_sessionOperationContext: SessionOperationContext, messages: Message[]): string | undefined {
    // Iterate backwards to find the most recent final assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === 'assistant' && !msg.isIntermediate) {
            return msg.id;
        }
    }
    return undefined;
}

/**
 * Read a session's final assistant message TEXT (in-process output reader for
 * the Tasks Conductor). `getLastFinalAssistantMessageId` is private and returns
 * an id; this wraps it to return the message content. Never exposed to agents —
 * child node output is read here, not via any tool/RPC.
 */
function sessionOpGetSessionFinalText(sessionOperationContext: SessionOperationContext, sessionId: string): string | undefined {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return undefined;
    const id = sessionOpGetLastFinalAssistantMessageId(sessionOperationContext, managed.messages);
    if (!id)
        return undefined;
    return managed.messages.find(m => m.id === id)?.content;
}

/**
 * Set which session the user is actively viewing.
 * Called when user navigates to a session. Used to determine whether to mark
 * new messages as unread - if user is viewing, don't mark unread.
 */
function sessionOpSetActiveViewingSession(sessionOperationContext: SessionOperationContext, sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
        sessionOperationContext.state.activeViewingSession.set(workspaceId, sessionId);
        // When user starts viewing a session that's not processing, clear unread
        const managed = sessionOperationContext.state.sessions.get(sessionId);
        if (managed && sessionOpOwnsSessionOperation(sessionOperationContext, managed) && !managed.isProcessing && managed.hasUnread) {
            void sessionOperationContext.owner.markSessionRead(sessionId).catch((error: unknown) => {
                sessionLog.warn(`Failed to mark viewed session ${sessionId} as read:`, error);
            });
        }
    }
    else {
        sessionOperationContext.state.activeViewingSession.delete(workspaceId);
    }
}

export { sessionOpSetSessionSources as setSessionSources };
export { sessionOpSetSessionSourcesWithinOperation as setSessionSourcesWithinOperation };
export { sessionOpGetSessionSources as getSessionSources };
export { sessionOpGetLastFinalAssistantMessageId as getLastFinalAssistantMessageId };
export { sessionOpGetSessionFinalText as getSessionFinalText };
export { sessionOpSetActiveViewingSession as setActiveViewingSession };
