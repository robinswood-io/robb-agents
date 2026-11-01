/**
 * Config File Watcher
 *
 * Watches configuration files for changes and triggers callbacks.
 * Uses recursive directory watching for simplicity and reliability.
 *
 * Watched paths:
 * - ~/.craft-agent/config.json - Main app configuration
 * - ~/.craft-agent/preferences.json - User preferences
 * - ~/.craft-agent/theme.json - App-level theme overrides
 * - ~/.craft-agent/themes/*.json - Preset theme files (app-level)
 * - ~/.craft-agent/workspaces/{slug}/ - Workspace directory (recursive)
 *   - sources/{slug}/config.json, guide.md, permissions.json
 *   - skills/{slug}/SKILL.md, icon.*
 *   - sessions/{id}/session.jsonl (header metadata only)
 *   - permissions.json
 */
import { existsSync } from "fs";
import { join } from "path";
import { debug } from "../../utils/debug.ts";
import { loadStoredConfig } from "../storage.ts";
import { validateConfig, validatePreferences } from "../validators.ts";
import { permissionsConfigCache } from "../../agent/permissions-config.ts";
import { loadStatusConfig, statusNeedsIconDownload, downloadStatusIcon } from "../../statuses/storage.ts";
import { readSessionHeader } from "../../sessions/jsonl.ts";
import { AUTOMATIONS_CONFIG_FILE } from "../../automations/constants.ts";
import type { ConfigWatcher } from '../watcher.ts';
import { SESSION_META_DEBOUNCE_MS, loadPreferences } from './shared.ts';

/**
   * Handle a file change within the workspace directory
   */
export function handleWorkspaceFileChange(transportOwner: ConfigWatcher, relativePath: string, _eventType: string): void {
    const parts = relativePath.split('/');
    // Workspace-level permissions.json
    if (relativePath === 'permissions.json') {
        transportOwner.debounce('workspace-permissions', () => transportOwner.handleWorkspacePermissionsChange());
        return;
    }
    // Workspace-level automations config file
    if (relativePath === AUTOMATIONS_CONFIG_FILE) {
        debug('[ConfigWatcher] automations config change detected:', relativePath);
        transportOwner.debounce('automations-config', () => transportOwner.handleAutomationsConfigChange());
        return;
    }
    // Sources changes: sources/{slug}/...
    if (parts[0] === 'sources' && parts.length >= 2) {
        const slug = parts[1]!; // Safe: checked parts.length >= 2
        const file = parts[2];
        // Directory-level changes (new/removed source folders)
        if (parts.length === 2) {
            transportOwner.debounce('sources-dir', () => transportOwner.handleSourcesDirChange());
            return;
        }
        // File-level changes
        if (file === 'config.json') {
            transportOwner.debounce(`source-config:${slug}`, () => transportOwner.handleSourceConfigChange(slug));
        }
        else if (file === 'guide.md') {
            transportOwner.debounce(`source-guide:${slug}`, () => transportOwner.handleSourceGuideChange(slug));
        }
        else if (file === 'permissions.json') {
            transportOwner.debounce(`source-permissions:${slug}`, () => transportOwner.handleSourcePermissionsChange(slug));
        }
        return;
    }
    // Skills changes: skills/{slug}/...
    if (parts[0] === 'skills' && parts.length >= 2) {
        const slug = parts[1]!; // Safe: checked parts.length >= 2
        const file = parts[2];
        // Directory-level changes (new/removed skill folders)
        if (parts.length === 2) {
            transportOwner.debounce('skills-dir', () => transportOwner.handleSkillsDirChange());
            return;
        }
        // File-level changes
        if (file === 'SKILL.md') {
            transportOwner.debounce(`skill:${slug}`, () => transportOwner.handleSkillChange(slug));
        }
        else if (file && /^icon\.(svg|png|jpg|jpeg)$/i.test(file)) {
            // Icon file changes also trigger a skill change (to update iconPath)
            transportOwner.debounce(`skill-icon:${slug}`, () => transportOwner.handleSkillChange(slug));
        }
        return;
    }
    // Session metadata changes: sessions/{id}/session.jsonl
    // Detects external modifications (other instances, scripts, manual edits).
    // Only reads line 1 (header) — lightweight even during active streaming.
    if (parts[0] === 'sessions' && parts.length >= 3) {
        const sessionId = parts[1]!;
        const file = parts[2];
        // Only watch actual session files, ignore .tmp (atomic write intermediates)
        if (file === 'session.jsonl') {
            transportOwner.debounce(`session-meta:${sessionId}`, () => transportOwner.handleSessionMetadataChange(sessionId), SESSION_META_DEBOUNCE_MS);
        }
        return;
    }
    // Statuses changes: statuses/...
    if (parts[0] === 'statuses' && parts.length >= 2) {
        const file = parts[1];
        // config.json change
        if (file === 'config.json') {
            transportOwner.debounce('statuses-config', () => transportOwner.handleStatusConfigChange());
            return;
        }
        // Icon file changes: statuses/icons/*.svg, *.png, etc.
        if (file === 'icons' && parts.length >= 3) {
            const iconFilename = parts[2];
            if (iconFilename) {
                transportOwner.debounce(`statuses-icon:${iconFilename}`, () => {
                    transportOwner.handleStatusIconChange(iconFilename);
                });
            }
            return;
        }
    }
    // Labels changes: labels/...
    if (parts[0] === 'labels' && parts.length >= 2) {
        const file = parts[1];
        // config.json change
        if (file === 'config.json') {
            transportOwner.debounce('labels-config', () => transportOwner.handleLabelConfigChange());
            return;
        }
    }
}

// ============================================================
  // Safe Mode & Config Handlers
  // ============================================================

  /**
   * Handle workspace permissions.json change
   */
export function handleWorkspacePermissionsChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] Workspace permissions.json changed:', transportOwner["workspaceId"]);
    // Invalidate cache
    permissionsConfigCache.invalidateWorkspace(transportOwner["workspaceDir"]);
    // Notify callback
    transportOwner["callbacks"].onWorkspacePermissionsChange?.(transportOwner["workspaceId"]);
}

/**
   * Handle config.json change
   */
export function handleConfigChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] config.json changed');
    const validation = validateConfig();
    if (!validation.valid) {
        debug('[ConfigWatcher] Config validation failed:', validation.errors);
        transportOwner["callbacks"].onValidationError?.('config.json', validation);
        return;
    }
    const config = loadStoredConfig();
    if (config) {
        transportOwner["callbacks"].onConfigChange?.(config);
        // Check for LLM connections changes
        // Use JSON hash comparison for deep equality check
        const connections = config.llmConnections || [];
        const currentHash = JSON.stringify(connections);
        if (currentHash !== transportOwner.lastLlmConnectionsHash) {
            debug('[ConfigWatcher] LLM connections changed');
            transportOwner.lastLlmConnectionsHash = currentHash;
            transportOwner["callbacks"].onLlmConnectionsChange?.(connections);
        }
    }
    else {
        transportOwner["callbacks"].onError?.('config.json', new Error('Failed to load config'));
    }
}

/**
   * Handle preferences.json change
   */
export function handlePreferencesChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] preferences.json changed');
    const validation = validatePreferences();
    if (!validation.valid) {
        debug('[ConfigWatcher] Preferences validation failed:', validation.errors);
        transportOwner["callbacks"].onValidationError?.('preferences.json', validation);
        return;
    }
    const prefs = loadPreferences();
    if (prefs) {
        transportOwner["callbacks"].onPreferencesChange?.(prefs);
    }
}

// ============================================================
  // Statuses Handlers
  // ============================================================

  /**
   * Handle statuses config.json change
   * Downloads icons for any status with URL icon and no local file
   */
export function handleStatusConfigChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] Statuses config.json changed:', transportOwner["workspaceId"]);
    // Load config and check for icons that need downloading
    const config = loadStatusConfig(transportOwner["workspaceDir"]);
    for (const status of config.statuses) {
        if (statusNeedsIconDownload(transportOwner["workspaceDir"], status)) {
            debug('[ConfigWatcher] Downloading status icon:', status.id);
            downloadStatusIcon(transportOwner["workspaceDir"], status.id, status.icon!)
                .then((iconPath) => {
                if (iconPath) {
                    debug('[ConfigWatcher] Status icon downloaded:', status.id, iconPath);
                    // Re-emit config change to update UI with new icon
                    transportOwner["callbacks"].onStatusConfigChange?.(transportOwner["workspaceId"]);
                }
            })
                .catch((err: unknown) => {
                debug('[ConfigWatcher] Status icon download failed:', status.id, err);
            });
        }
    }
    transportOwner["callbacks"].onStatusConfigChange?.(transportOwner["workspaceId"]);
}

/**
   * Handle status icon file change
   */
export function handleStatusIconChange(transportOwner: ConfigWatcher, iconFilename: string): void {
    debug('[ConfigWatcher] Status icon changed:', transportOwner["workspaceId"], iconFilename);
    transportOwner["callbacks"].onStatusIconChange?.(transportOwner["workspaceId"], iconFilename);
}

// ============================================================
  // Labels Handlers
  // ============================================================

  /**
   * Handle labels config.json change.
   */
export function handleLabelConfigChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] Labels config.json changed:', transportOwner["workspaceId"]);
    transportOwner["callbacks"].onLabelConfigChange?.(transportOwner["workspaceId"]);
}

/**
   * Handle automations config change.
   */
export function handleAutomationsConfigChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] automations config changed:', transportOwner["workspaceId"]);
    transportOwner["callbacks"].onAutomationsConfigChange?.(transportOwner["workspaceId"]);
}

// ============================================================
  // Session Metadata Handlers
  // ============================================================

  /**
   * Handle session.jsonl change — reads only line 1 (header) and emits if valid.
   * This enables detection of external metadata changes (labels, name, flags)
   * made by other instances, scripts, or manual edits.
   */
export function handleSessionMetadataChange(transportOwner: ConfigWatcher, sessionId: string): void {
    const sessionFile = join(transportOwner["workspaceDir"], 'sessions', sessionId, 'session.jsonl');
    if (!existsSync(sessionFile)) {
        return;
    }
    const header = readSessionHeader(sessionFile);
    if (header) {
        transportOwner["callbacks"].onSessionMetadataChange?.(sessionId, header);
    }
}
