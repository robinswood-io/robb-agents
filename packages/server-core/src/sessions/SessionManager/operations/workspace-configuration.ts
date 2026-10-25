import type { SessionOperationContext } from '../operation-context.ts';
import { refreshInheritedWorkspaceSources, persistenceRootFor, assertSpecializedMissionSourceSelection, ordinaryMissionSourceBuildOptions } from '../policy.ts';
import { getLlmConnection, getDefaultLlmConnection, resetManagedAnthropicAuthEnvVars, getWorkspaces, migrateLegacyCredentials, migrateLegacyLlmConnectionsConfig, migrateOrphanedDefaultConnections, resolveAuthEnvVars } from '@craft-agent/shared/config';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { loadAllSources, isSourceUsable } from '@craft-agent/shared/sources';
import type { LoadedSource } from '@craft-agent/shared/sources';
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth';
import { getCredentialManager } from '@craft-agent/shared/credentials';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import { resetSummarizationClient } from '@craft-agent/shared/utils';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { buildServersFromSources } from '../source-build.ts';
import { ownsSessionOperation as sessionOpOwnsSessionOperation, trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, assertSessionRuntimeOperationOwner as sessionOpAssertSessionRuntimeOperationOwner } from './track-session-operation.ts';
import { getCollectionSummarizer as sessionOpGetCollectionSummarizer } from './try-refresh-agent-runtime.ts';
import { loadSessionsFromDisk as sessionOpLoadSessionsFromDisk } from './session-loading.ts';
import { startRuntimeEvictionSweep as sessionOpStartRuntimeEvictionSweep } from './evict-idle-session-runtimes.ts';
import { startCompletedChatRetention as sessionOpStartCompletedChatRetention } from './session-lifecycle.ts';

/**
 * Reload sources for all sessions in a workspace, skipping those currently processing.
 */
async function sessionOpReloadSourcesForWorkspace(sessionOperationContext: SessionOperationContext, workspaceRootPath: string): Promise<void> {
    if (sessionOperationContext.state.shuttingDown)
        return;
    for (const [_, managed] of sessionOperationContext.state.sessions) {
        if (sessionOperationContext.state.shuttingDown)
            return;
        if (managed.workspace.rootPath === workspaceRootPath) {
            if (managed.isProcessing) {
                sessionLog.info(`Skipping source reload for session ${managed.id} (processing)`);
                continue;
            }
            try {
                // reloadSessionSources owns the single deletion fence for this
                // watcher callback. Calls made from an already-fenced send path use
                // reloadSessionSourcesWithinOperation directly below.
                await sessionOpReloadSessionSources(sessionOperationContext, managed);
            }
            catch (error) {
                // Deletion detaches the exact ManagedSession synchronously. A reload
                // which was admitted just before that boundary is expected to abort
                // at its next await rather than re-applying source state to the
                // retiring runtime.
                if (sessionOperationContext.state.shuttingDown || !sessionOpOwnsSessionOperation(sessionOperationContext, managed)) {
                    sessionLog.info(`Cancelled source reload for deleting session ${managed.id}`);
                    if (sessionOperationContext.state.shuttingDown)
                        return;
                    continue;
                }
                throw error;
            }
        }
    }
}

function sessionOpBroadcastSourcesChanged(sessionOperationContext: SessionOperationContext, workspaceId: string, sources: LoadedSource[]): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionOperationContext.state.eventSink(RPC_CHANNELS.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, sources);
}

function sessionOpBroadcastStatusesChanged(sessionOperationContext: SessionOperationContext, workspaceId: string): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionLog.info(`Broadcasting statuses changed for ${workspaceId}`);
    sessionOperationContext.state.eventSink(RPC_CHANNELS.statuses.CHANGED, { to: 'workspace', workspaceId }, workspaceId);
}

function sessionOpBroadcastLabelsChanged(sessionOperationContext: SessionOperationContext, workspaceId: string): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionLog.info(`Broadcasting labels changed for ${workspaceId}`);
    sessionOperationContext.state.eventSink(RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId);
}

function sessionOpBroadcastAutomationsChanged(sessionOperationContext: SessionOperationContext, workspaceId: string): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionLog.info(`Broadcasting automations changed for ${workspaceId}`);
    sessionOperationContext.state.eventSink(RPC_CHANNELS.automations.CHANGED, { to: 'workspace', workspaceId }, workspaceId);
}

function sessionOpBroadcastAppThemeChanged(sessionOperationContext: SessionOperationContext, theme: import('@craft-agent/shared/config').ThemeOverrides | null): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionLog.info(`Broadcasting app theme changed`);
    sessionOperationContext.state.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme);
}

function sessionOpBroadcastLlmConnectionsChanged(sessionOperationContext: SessionOperationContext): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionLog.info('Broadcasting LLM connections changed');
    sessionOperationContext.state.eventSink(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' });
}

function sessionOpBroadcastSkillsChanged(sessionOperationContext: SessionOperationContext, workspaceId: string, skills: import('@craft-agent/shared/skills').LoadedSkill[]): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`);
    sessionOperationContext.state.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills);
}

function sessionOpBroadcastDefaultPermissionsChanged(sessionOperationContext: SessionOperationContext): void {
    if (!sessionOperationContext.state.eventSink)
        return;
    sessionLog.info('Broadcasting default permissions changed');
    sessionOperationContext.state.eventSink(RPC_CHANNELS.permissions.DEFAULTS_CHANGED, { to: 'all' }, null);
}

function sessionOpReloadSessionSources(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpReloadSessionSourcesWithinOperation(sessionOperationContext, managed));
}

/** Reload implementation for callers which already hold the session
 * operation fence (notably the send path). Keeping admission outside this
 * helper avoids nested leases while deletion is draining callbacks. */
async function sessionOpReloadSessionSourcesWithinOperation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    if (managed.missionCapabilityLock) {
        // A watcher must never replace a governed turn's source config/guide
        // snapshot. Drift is observed and the next dispatch fails closed.
        assertSpecializedMissionSourceSelection(managed, managed.enabledSourceSlugs ?? []);
        await sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed);
        sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
        return;
    }
    const inheritedSelectionChanged = refreshInheritedWorkspaceSources(managed);
    if (inheritedSelectionChanged) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'sources_changed',
            sessionId: managed.id,
            enabledSourceSlugs: managed.enabledSourceSlugs ?? [],
        }, managed.workspace.id);
    }
    if (!managed.agent)
        return; // No agent = nothing to update (fresh build on next message)
    const workspaceRootPath = managed.workspace.rootPath;
    sessionLog.info(`Reloading sources for session ${managed.id}`);
    // Reload all sources from disk (craft-agents-docs is always available as MCP server)
    const allSources = loadAllSources(workspaceRootPath);
    const agent = managed.agent;
    // Rebuild MCP and API servers for session's enabled sources
    const enabledSlugs = managed.enabledSourceSlugs || [];
    const enabledSources = allSources.filter(s => enabledSlugs.includes(s.config.slug) && isSourceUsable(s));
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(persistenceRootFor(managed), managed.id);
    const { mcpServers, apiServers } = await sessionOperationContext.owner["buildSessionSourceServers"](managed, enabledSources, sessionPath);
    sessionOpAssertSessionRuntimeOperationOwner(sessionOperationContext, managed, agent);
    agent.setAllSources(allSources);
    const intendedSlugs = enabledSources.map(s => s.config.slug);
    sessionOpAssertSessionRuntimeOperationOwner(sessionOperationContext, managed, agent);
    await agent.setSourceServers(mcpServers, apiServers, intendedSlugs);
    sessionOpAssertSessionRuntimeOperationOwner(sessionOperationContext, managed, agent);
    sessionLog.info(`Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`);
}

function sessionOpBuildSessionSourceServers(sessionOperationContext: SessionOperationContext, managed: ManagedSession, sources: LoadedSource[], sessionPath: string): ReturnType<typeof buildServersFromSources> {
    return buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, sessionOpGetCollectionSummarizer(sessionOperationContext, managed), managed.missionCapabilityLock ? () => sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed) : undefined, managed.missionCapabilityLock, ordinaryMissionSourceBuildOptions(managed));
}

/**
 * Reinitialize authentication environment variables.
 * Call this after onboarding or settings changes to pick up new credentials.
 *
 * SECURITY NOTE: These env vars are propagated to the SDK subprocess via options.ts.
 * Bun's automatic .env loading is disabled in the subprocess (--env-file=/dev/null)
 * to prevent a user's project .env from injecting ANTHROPIC_API_KEY and overriding
 * OAuth auth — Claude Code prioritizes API key over OAuth token when both are set.
 * See: https://github.com/lukilabs/craft-agents-oss/issues/39
 */
/**
 * Reinitialize authentication environment variables.
 *
 * Uses the default LLM connection to determine which credentials to set.
 *
 * @param connectionSlug - Optional connection slug to use (overrides default)
 */
async function sessionOpReinitializeAuth(sessionOperationContext: SessionOperationContext, connectionSlug?: string): Promise<void> {
    try {
        const manager = getCredentialManager();
        // Get the connection to use (explicit parameter or default)
        const slug = connectionSlug || getDefaultLlmConnection();
        if (!slug) {
            sessionLog.warn('No LLM connection slug available for reinitializeAuth');
            resetManagedAnthropicAuthEnvVars();
            resetSummarizationClient();
            return;
        }
        const connection = slug ? getLlmConnection(slug) : null;
        // Restore managed auth env vars to their baseline before applying this connection.
        resetManagedAnthropicAuthEnvVars();
        if (!connection) {
            sessionLog.error(`No LLM connection found for slug: ${slug}`);
            resetSummarizationClient();
            return;
        }
        sessionLog.info(`Reinitializing auth for connection: ${slug} (${connection.authType})`);
        // Resolve auth env vars via shared utility (provider-agnostic)
        const result = await resolveAuthEnvVars(connection, slug!, manager, getValidClaudeOAuthToken);
        if (!result.success) {
            sessionLog.error(`Auth resolution failed for ${slug}: ${result.warning}`);
        }
        else {
            // Apply resolved env vars to process.env
            for (const [key, value] of Object.entries(result.envVars)) {
                process.env[key] = value;
            }
            sessionLog.info(`Auth env vars set for connection: ${slug}`);
        }
        // Reset cached summarization client so it picks up new credentials/base URL
        resetSummarizationClient();
    }
    catch (error) {
        sessionLog.error('Failed to reinitialize auth:', error);
        throw error;
    }
}

async function sessionOpInitialize(sessionOperationContext: SessionOperationContext): Promise<void> {
    try {
        // Backfill missing `models` arrays on existing LLM connections
        migrateLegacyLlmConnectionsConfig();
        // Fix defaultLlmConnection if it points to a non-existent connection
        migrateOrphanedDefaultConnections();
        // Migrate legacy credentials to LLM connection format (one-time migration)
        // This ensures credentials saved before LLM connections are available via the new system
        await migrateLegacyCredentials();
        // Set up authentication environment variables (critical for SDK to work)
        await sessionOperationContext.owner.reinitializeAuth();
        // Eagerly activate ConfigWatcher + AutomationSystem for every workspace so
        // the scheduler and event handlers start at boot — not lazily on first
        // client connect. This is critical for headless servers where no UI may
        // ever connect, yet scheduled/event-driven automations must still fire.
        const workspaces = getWorkspaces();
        for (const workspace of workspaces) {
            sessionOperationContext.owner.setupConfigWatcher(workspace.rootPath, workspace.id);
        }
        // Load existing sessions from disk
        sessionOpLoadSessionsFromDisk(sessionOperationContext);
        sessionOpStartRuntimeEvictionSweep(sessionOperationContext);
        sessionOpStartCompletedChatRetention(sessionOperationContext);
        // Signal that initialization is complete — IPC handlers waiting on initGate will proceed
        sessionOperationContext.state.initGate.markReady();
    }
    catch (error) {
        sessionOperationContext.state.initGate.markFailed(error);
        throw error;
    }
}

export { sessionOpReloadSourcesForWorkspace as reloadSourcesForWorkspace };
export { sessionOpBroadcastSourcesChanged as broadcastSourcesChanged };
export { sessionOpBroadcastStatusesChanged as broadcastStatusesChanged };
export { sessionOpBroadcastLabelsChanged as broadcastLabelsChanged };
export { sessionOpBroadcastAutomationsChanged as broadcastAutomationsChanged };
export { sessionOpBroadcastAppThemeChanged as broadcastAppThemeChanged };
export { sessionOpBroadcastLlmConnectionsChanged as broadcastLlmConnectionsChanged };
export { sessionOpBroadcastSkillsChanged as broadcastSkillsChanged };
export { sessionOpBroadcastDefaultPermissionsChanged as broadcastDefaultPermissionsChanged };
export { sessionOpReloadSessionSources as reloadSessionSources };
export { sessionOpReloadSessionSourcesWithinOperation as reloadSessionSourcesWithinOperation };
export { sessionOpBuildSessionSourceServers as buildSessionSourceServers };
export { sessionOpReinitializeAuth as reinitializeAuth };
export { sessionOpInitialize as initialize };
