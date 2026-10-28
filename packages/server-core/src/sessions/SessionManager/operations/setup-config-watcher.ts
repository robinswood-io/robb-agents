import type { SessionOperationContext } from '../operation-context.ts';
import { sessionPersistenceQueue, getHeaderMetadataSignature } from '@craft-agent/shared/sessions';
import { loadWorkspaceSources } from '@craft-agent/shared/sources';
import type { LoadedSource } from '@craft-agent/shared/sources';
import { ConfigWatcher } from '@craft-agent/shared/config';
import type { ConfigWatcherCallbacks } from '@craft-agent/shared/config';
import { AutomationSystem, createPromptHistoryEntry, appendAutomationHistoryEntry } from '@craft-agent/shared/automations';
import { sessionLog } from '../runtime-platform.ts';
import { broadcastSourcesChanged as sessionOpBroadcastSourcesChanged, reloadSourcesForWorkspace as sessionOpReloadSourcesForWorkspace, broadcastStatusesChanged as sessionOpBroadcastStatusesChanged, broadcastLabelsChanged as sessionOpBroadcastLabelsChanged, broadcastAutomationsChanged as sessionOpBroadcastAutomationsChanged, broadcastLlmConnectionsChanged as sessionOpBroadcastLlmConnectionsChanged, broadcastAppThemeChanged as sessionOpBroadcastAppThemeChanged, broadcastDefaultPermissionsChanged as sessionOpBroadcastDefaultPermissionsChanged, broadcastSkillsChanged as sessionOpBroadcastSkillsChanged } from './workspace-configuration.ts';
import { applyExternalSessionMetadata as sessionOpApplyExternalSessionMetadata } from './close-pending-permission-requests-for-stop.ts';

/**
 * Set up ConfigWatcher for a workspace to broadcast live updates
 * (sources added/removed, guide.md changes, etc.)
 * Called eagerly at boot for all workspaces (automations/scheduler) and
 * on client connect (GET_WORKSPACE / SWITCH_WORKSPACE).
 * Idempotent — returns immediately if already watching.
 * workspaceId must be the global config ID (what the renderer knows).
 */
function sessionOpSetupConfigWatcher(sessionOperationContext: SessionOperationContext, workspaceRootPath: string, workspaceId: string): void {
    if (sessionOperationContext.state.shuttingDown)
        return;
    // Check if already watching this workspace
    if (sessionOperationContext.state.configWatchers.has(workspaceRootPath)) {
        return; // Already watching this workspace
    }
    sessionLog.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`);
    const callbacks: ConfigWatcherCallbacks = {
        onSourcesListChange: async (sources: LoadedSource[]) => {
            sessionLog.info(`Sources list changed in ${workspaceRootPath} (${sources.length} sources)`);
            sessionOpBroadcastSourcesChanged(sessionOperationContext, workspaceId, sources);
            await sessionOpReloadSourcesForWorkspace(sessionOperationContext, workspaceRootPath);
        },
        onSourceChange: async (slug: string, source: LoadedSource | null) => {
            sessionLog.info(`Source '${slug}' changed:`, source ? 'updated' : 'deleted');
            const sources = loadWorkspaceSources(workspaceRootPath);
            sessionOpBroadcastSourcesChanged(sessionOperationContext, workspaceId, sources);
            await sessionOpReloadSourcesForWorkspace(sessionOperationContext, workspaceRootPath);
        },
        onSourceGuideChange: (sourceSlug: string) => {
            sessionLog.info(`Source guide changed: ${sourceSlug}`);
            // Broadcast the updated sources list so sidebar picks up guide changes
            // Note: Guide changes don't require session source reload (no server changes)
            const sources = loadWorkspaceSources(workspaceRootPath);
            sessionOpBroadcastSourcesChanged(sessionOperationContext, workspaceId, sources);
        },
        onStatusConfigChange: () => {
            sessionLog.info(`Status config changed in ${workspaceId}`);
            sessionOpBroadcastStatusesChanged(sessionOperationContext, workspaceId);
        },
        onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
            sessionLog.info(`Status icon changed: ${iconFilename} in ${workspaceId}`);
            sessionOpBroadcastStatusesChanged(sessionOperationContext, workspaceId);
        },
        onLabelConfigChange: () => {
            sessionLog.info(`Label config changed in ${workspaceId}`);
            sessionOpBroadcastLabelsChanged(sessionOperationContext, workspaceId);
            // Emit LabelConfigChange event via AutomationSystem
            const automationSystem = sessionOperationContext.state.automationSystems.get(workspaceRootPath);
            if (automationSystem) {
                automationSystem.emitLabelConfigChange().catch((error: unknown) => {
                    sessionLog.error(`[Automations] Failed to emit LabelConfigChange:`, error);
                });
            }
        },
        onAutomationsConfigChange: () => {
            sessionLog.info(`Automations config changed in ${workspaceId}`);
            // Reload automations config via AutomationSystem
            const automationSystem = sessionOperationContext.state.automationSystems.get(workspaceRootPath);
            if (automationSystem) {
                const result = automationSystem.reloadConfig();
                if (result.errors.length === 0) {
                    sessionLog.info(`Reloaded ${result.automationCount} automations for workspace ${workspaceId}`);
                }
                else {
                    sessionLog.error(`Failed to reload automations for workspace ${workspaceId}:`, result.errors);
                }
            }
            // Notify renderer to re-read automations.json
            sessionOpBroadcastAutomationsChanged(sessionOperationContext, workspaceId);
        },
        onLlmConnectionsChange: () => {
            sessionLog.info(`LLM connections changed in ${workspaceId}`);
            sessionOpBroadcastLlmConnectionsChanged(sessionOperationContext);
        },
        onAppThemeChange: (theme) => {
            sessionLog.info(`App theme changed`);
            sessionOpBroadcastAppThemeChanged(sessionOperationContext, theme);
        },
        onDefaultPermissionsChange: () => {
            sessionLog.info('Default permissions changed');
            sessionOpBroadcastDefaultPermissionsChanged(sessionOperationContext);
        },
        onSkillsListChange: async (skills) => {
            sessionLog.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`);
            sessionOpBroadcastSkillsChanged(sessionOperationContext, workspaceId, skills);
        },
        onSkillChange: async (slug, skill) => {
            sessionLog.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted');
            // Broadcast updated list to UI
            const { loadAllSkills } = await import('@craft-agent/shared/skills');
            if (sessionOperationContext.state.shuttingDown)
                return;
            const skills = loadAllSkills(workspaceRootPath);
            sessionOpBroadcastSkillsChanged(sessionOperationContext, workspaceId, skills);
        },
        // Session metadata changes (edits to session.jsonl headers).
        // Detects changes from both internal writes (self) and external sources
        // (other instances, scripts, manual edits).
        onSessionMetadataChange: (sessionId, header) => {
            const managed = sessionOperationContext.state.sessions.get(sessionId);
            if (!managed)
                return;
            // Check if this is our own write echoing back via fs.watch().
            // Self-writes don't need in-memory sync (already up to date), but
            // still need to notify the automation system for event matching.
            const incomingSignature = getHeaderMetadataSignature(header);
            const lastWrittenSignature = sessionPersistenceQueue.getLastWrittenSignature(sessionId, managed.persistenceRootPath);
            const isSelfWrite = !!(lastWrittenSignature && incomingSignature === lastWrittenSignature);
            // A matching self-write is the durable winner currently present on
            // disk. Any older watcher snapshot deferred while that write was in
            // flight is now obsolete; keeping it would re-apply stale metadata at
            // turn completion (most visibly, reverting needs-review to
            // in-progress after set_session_status succeeded).
            if (isSelfWrite && managed.pendingExternalMetadata) {
                managed.pendingExternalMetadata = undefined;
                sessionLog.info(`Discarded superseded deferred metadata for session ${sessionId} after confirmed self-write`);
            }
            // For external writes: sync in-memory state + emit UI events.
            // Skip for self-writes to avoid feedback loops (especially on Windows
            // where fs.watch fires aggressively: unlink + rename = 2+ events).
            if (!isSelfWrite) {
                // Defer external metadata application when:
                // 1. Session is actively processing (agent running), OR
                // 2. Session was just written programmatically (set_session_status/labels tool)
                //    — fs.watch fires during atomic write (unlink+rename) and can read stale data
                const hasWriteGuard = managed._metadataWriteGuardUntil && Date.now() < managed._metadataWriteGuardUntil;
                if (managed.isProcessing || hasWriteGuard) {
                    managed.pendingExternalMetadata = header;
                    if (hasWriteGuard) {
                        sessionLog.info(`Deferred external metadata update for session ${sessionId} (recent programmatic write)`);
                    }
                    else {
                        sessionLog.info(`Deferred external metadata update for session ${sessionId} (processing active)`);
                    }
                }
                else {
                    sessionOpApplyExternalSessionMetadata(sessionOperationContext, managed, header);
                }
            }
            // Always notify automation system — it does its own diffing and needs
            // to see both self-writes and external changes for event matching.
            const automationSystem = sessionOperationContext.state.automationSystems.get(managed.workspace.rootPath);
            if (automationSystem) {
                automationSystem.updateSessionMetadata(sessionId, {
                    ...(header.permissionMode !== undefined ? { permissionMode: header.permissionMode } : {}),
                    ...(header.labels !== undefined ? { labels: header.labels } : {}),
                    ...(header.isFlagged !== undefined ? { isFlagged: header.isFlagged } : {}),
                    ...(header.sessionStatus !== undefined ? { sessionStatus: header.sessionStatus } : {}),
                    ...(header.name !== undefined ? { sessionName: header.name } : {}),
                }).catch((error: unknown) => {
                    sessionLog.error(`[Automations] Failed to update session metadata:`, error);
                });
            }
        },
    };
    const watcher = new ConfigWatcher(workspaceRootPath, callbacks);
    watcher.start();
    sessionOperationContext.state.configWatchers.set(workspaceRootPath, watcher);
    // Initialize AutomationSystem for this workspace (includes scheduler, handlers, and event logging)
    if (!sessionOperationContext.state.automationSystems.has(workspaceRootPath)) {
        const automationSystem = new AutomationSystem({
            workspaceRootPath,
            workspaceId,
            enableScheduler: true,
            onPromptsReady: async (prompts) => {
                // Execute prompt automations by creating new sessions
                const settled = await Promise.allSettled(prompts.map((pending) => sessionOperationContext.owner.executePromptAutomation({
                    workspaceId,
                    workspaceRootPath,
                    prompt: pending.prompt,
                    ...(pending.labels !== undefined ? { labels: pending.labels } : {}),
                    ...(pending.permissionMode !== undefined ? { permissionMode: pending.permissionMode } : {}),
                    mentions: pending.mentions,
                    ...(pending.llmConnection !== undefined ? { llmConnection: pending.llmConnection } : {}),
                    ...(pending.model !== undefined ? { model: pending.model } : {}),
                    ...(pending.thinkingLevel !== undefined ? { thinkingLevel: pending.thinkingLevel } : {}),
                    ...(pending.automationName !== undefined ? { automationName: pending.automationName } : {}),
                    ...(pending.telegramTopic !== undefined ? { telegramTopic: pending.telegramTopic } : {}),
                })));
                // Write enriched history entries (with session IDs and prompt summaries)
                for (const [idx, result] of settled.entries()) {
                    const pending = prompts[idx];
                    if (!pending) throw new Error(`Missing automation prompt for result ${idx}`);
                    if (!pending.matcherId)
                        continue;
                    const entry = createPromptHistoryEntry({
                        matcherId: pending.matcherId,
                        ok: result.status === 'fulfilled',
                        sessionId: result.status === 'fulfilled' ? result.value.sessionId : undefined,
                        prompt: pending.prompt,
                        error: result.status === 'rejected' ? String(result.reason) : undefined,
                    });
                    appendAutomationHistoryEntry(workspaceRootPath, entry).catch((e: unknown) => sessionLog.warn('[Automations] Failed to write history:', e));
                    if (result.status === 'rejected') {
                        sessionLog.error(`[Automations] Failed to execute prompt action ${idx + 1}:`, result.reason);
                    }
                    else {
                        sessionLog.info(`[Automations] Created session ${result.value.sessionId} from prompt action`);
                    }
                }
            },
            onError: (event, error) => {
                sessionLog.error(`Automation failed for ${event}:`, error.message);
            },
        });
        sessionOperationContext.state.automationSystems.set(workspaceRootPath, automationSystem);
        sessionLog.info(`Initialized AutomationSystem for workspace ${workspaceId}`);
    }
}

export { sessionOpSetupConfigWatcher as setupConfigWatcher };
