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
import { watch, existsSync, mkdirSync } from "fs";
import { CONFIG_DIR } from "../paths.ts";
import { debug } from "../../utils/debug.ts";
import { perf } from "../../utils/perf.ts";
import { loadStoredConfig } from "../storage.ts";
import type { ConfigWatcher } from '../watcher.ts';
import { activeWatchers } from './shared.ts';

export function start(transportOwner: ConfigWatcher): void {
    if (transportOwner.isRunning) {
        return;
    }
    const span = perf.span('configWatcher.start', { workspaceId: transportOwner["workspaceId"] });
    transportOwner.isRunning = true;
    // Detect duplicate recursive watchers on the same directory tree
    const existingOwner = activeWatchers.get(transportOwner["workspaceDir"]);
    if (existingOwner) {
        debug(`[ConfigWatcher] WARNING: duplicate watcher for ${transportOwner["workspaceDir"]} (already owned by: ${existingOwner}, new: ${transportOwner["workspaceId"]})`);
    }
    activeWatchers.set(transportOwner["workspaceDir"], transportOwner["workspaceId"]);
    debug('[ConfigWatcher] Starting for workspace:', transportOwner["workspaceId"]);
    // Ensure workspace directory exists
    if (!existsSync(transportOwner["workspaceDir"])) {
        mkdirSync(transportOwner["workspaceDir"], { recursive: true });
    }
    span.mark('ensureDir');
    // Watch global config files
    transportOwner.watchGlobalConfigs();
    span.mark('watchGlobalConfigs');
    // Watch workspace directory recursively
    transportOwner.watchWorkspaceDir();
    span.mark('watchWorkspaceDir');
    // Watch app-level themes directory
    transportOwner.watchAppThemesDir();
    span.mark('watchAppThemesDir');
    // Watch app-level permissions directory
    transportOwner.watchAppPermissionsDir();
    span.mark('watchAppPermissionsDir');
    // Initial scan to populate known sources, skills, and themes
    transportOwner.scanSources();
    span.mark('scanSources');
    transportOwner.scanSkills();
    span.mark('scanSkills');
    transportOwner.scanAppThemes();
    span.mark('scanAppThemes');
    // Initialize LLM connections hash for change detection
    transportOwner.initLlmConnectionsHash();
    span.mark('initLlmConnectionsHash');
    debug('[ConfigWatcher] Started watching files');
    span.end();
}

/**
   * Initialize LLM connections hash for change detection
   */
export function initLlmConnectionsHash(transportOwner: ConfigWatcher): void {
    const config = loadStoredConfig();
    if (config) {
        const connections = config.llmConnections || [];
        transportOwner.lastLlmConnectionsHash = JSON.stringify(connections);
    }
}

export function notifyFileChange(transportOwner: ConfigWatcher, relativePath: string): void {
    if (!transportOwner.isRunning)
        return;
    transportOwner.handleWorkspaceFileChange(relativePath, 'change');
}

export function stop(transportOwner: ConfigWatcher): void {
    if (!transportOwner.isRunning) {
        return;
    }
    transportOwner.isRunning = false;
    activeWatchers.delete(transportOwner["workspaceDir"]);
    // Clear all debounce timers
    for (const timer of transportOwner.debounceTimers.values()) {
        clearTimeout(timer);
    }
    transportOwner.debounceTimers.clear();
    // Close all watchers
    for (const watcher of transportOwner.watchers) {
        watcher.close();
    }
    transportOwner.watchers = [];
    transportOwner["knownSources"].clear();
    transportOwner.knownSkills.clear();
    transportOwner.knownThemes.clear();
    debug('[ConfigWatcher] Stopped');
}

/**
   * Watch global config files (config.json, preferences.json)
   */
export function watchGlobalConfigs(transportOwner: ConfigWatcher): void {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }
    try {
        // Watch the config directory for changes to config.json, preferences.json, and theme.json
        const watcher = watch(CONFIG_DIR, (_eventType, filename) => {
            if (!filename)
                return;
            if (filename === 'config.json') {
                transportOwner.debounce('config.json', () => transportOwner.handleConfigChange());
            }
            else if (filename === 'preferences.json') {
                transportOwner.debounce('preferences.json', () => transportOwner.handlePreferencesChange());
            }
            else if (filename === 'theme.json') {
                transportOwner.debounce('app-theme', () => transportOwner.handleAppThemeChange());
            }
        });
        transportOwner.watchers.push(watcher);
        debug('[ConfigWatcher] Watching global configs:', CONFIG_DIR);
    }
    catch (error) {
        debug('[ConfigWatcher] Error watching global configs:', error);
    }
}

/**
   * Watch workspace directory recursively
   */
export function watchWorkspaceDir(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] Setting up workspace watcher for:', transportOwner["workspaceDir"]);
    try {
        const watcher = watch(transportOwner["workspaceDir"], { recursive: true }, (eventType, filename) => {
            if (!filename)
                return;
            // Normalize path separators
            const normalizedPath = filename.replace(/\\/g, '/');
            transportOwner.handleWorkspaceFileChange(normalizedPath, eventType);
        });
        transportOwner.watchers.push(watcher);
        debug('[ConfigWatcher] Watching workspace recursively:', transportOwner["workspaceDir"]);
    }
    catch (error) {
        debug('[ConfigWatcher] Error watching workspace directory:', error);
    }
}

/**
   * Debounce a handler by key
   */
export function debounce(transportOwner: ConfigWatcher, key: string, handler: () => void, delayMs: number): void {
    const existing = transportOwner.debounceTimers.get(key);
    if (existing) {
        clearTimeout(existing);
    }
    const timer = setTimeout(() => {
        transportOwner.debounceTimers.delete(key);
        handler();
    }, delayMs);
    transportOwner.debounceTimers.set(key, timer);
}
