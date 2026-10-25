import type { FSWatcher } from "fs";
import { expandPath } from "../utils/paths.ts";
import { getWorkspacePath, getWorkspaceSourcesPath, getWorkspaceSkillsPath } from "../workspaces/storage.ts";
import { DEBOUNCE_MS } from './watcher/shared.ts';
import type { ConfigWatcherCallbacks } from './watcher/shared.ts';
import * as watcherLifecycle from './watcher/lifecycle.ts';
import * as watcherWorkspace from './watcher/workspace.ts';
import * as watcherSources from './watcher/sources.ts';
import * as watcherSkills from './watcher/skills.ts';
import * as watcherThemes from './watcher/themes.ts';
export type { UserPreferences, ConfigWatcherCallbacks } from './watcher/shared.ts';
export { _getActiveWatchers, loadPreferences } from './watcher/shared.ts';

// ============================================================
// ConfigWatcher Class
// ============================================================
/**
 * Watches config files and triggers callbacks on changes.
 * Uses recursive directory watching for workspace files.
 */
export class ConfigWatcher {
    private workspaceId: string;
    private callbacks: ConfigWatcherCallbacks;
    private watchers: FSWatcher[] = [];
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private isRunning = false;
    // Track known items for detecting adds/removes
    private knownSources: Set<string> = new Set();
    private knownSkills: Set<string> = new Set();
    private knownThemes: Set<string> = new Set();
    // Track LLM connections for change detection (JSON string for deep comparison)
    private lastLlmConnectionsHash: string = '';
    // Computed paths
    private workspaceDir: string;
    private sourcesDir: string;
    private skillsDir: string;
    constructor(workspaceIdOrPath: string, callbacks: ConfigWatcherCallbacks) {
        this.callbacks = callbacks;
        // Support both workspace ID and workspace root path
        // Paths contain '/' or '\\' (Windows) while IDs don't
        const isPath = workspaceIdOrPath.includes('/') || workspaceIdOrPath.includes('\\');
        if (isPath) {
            this.workspaceDir = expandPath(workspaceIdOrPath);
            // Extract workspace ID from path (last segment) - handle both separators
            this.workspaceId = workspaceIdOrPath.split(/[/\\]/).pop() || workspaceIdOrPath;
        }
        else {
            this.workspaceId = workspaceIdOrPath;
            this.workspaceDir = getWorkspacePath(workspaceIdOrPath);
        }
        this.sourcesDir = getWorkspaceSourcesPath(this.workspaceDir);
        this.skillsDir = getWorkspaceSkillsPath(this.workspaceDir);
    }
    /**
     * Get the workspace slug this watcher is scoped to
     */
    getWorkspaceSlug(): string {
        return this.workspaceId;
    }
    /**
     * Start watching config files
     */
    start(): void {
        return watcherLifecycle.start(this);
    }
    private initLlmConnectionsHash(): void {
        return watcherLifecycle.initLlmConnectionsHash(this);
    }
    /**
     * Manually notify the watcher of a file change.
     * Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
     * files in directories created after the watcher started.
     * See: https://github.com/oven-sh/bun/issues/15939
     * See: https://github.com/oven-sh/bun/issues/15085
     * When these are fixed, this method and its call sites can be removed.
     */
    notifyFileChange(relativePath: string): void {
        return watcherLifecycle.notifyFileChange(this, relativePath);
    }
    /**
     * Stop watching all files
     */
    stop(): void {
        return watcherLifecycle.stop(this);
    }
    private watchGlobalConfigs(): void {
        return watcherLifecycle.watchGlobalConfigs(this);
    }
    private watchWorkspaceDir(): void {
        return watcherLifecycle.watchWorkspaceDir(this);
    }
    private handleWorkspaceFileChange(relativePath: string, eventType: string): void {
        return watcherWorkspace.handleWorkspaceFileChange(this, relativePath, eventType);
    }
    private debounce(key: string, handler: () => void, delayMs: number = DEBOUNCE_MS): void {
        return watcherLifecycle.debounce(this, key, handler, delayMs);
    }
    private scanSources(): void {
        return watcherSources.scanSources(this);
    }
    private handleSourcesDirChange(): void {
        return watcherSources.handleSourcesDirChange(this);
    }
    private handleSourceConfigChange(slug: string): void {
        return watcherSources.handleSourceConfigChange(this, slug);
    }
    private handleSourceGuideChange(slug: string): void {
        return watcherSources.handleSourceGuideChange(this, slug);
    }
    private handleSourcePermissionsChange(slug: string): void {
        return watcherSources.handleSourcePermissionsChange(this, slug);
    }
    private scanSkills(): void {
        return watcherSkills.scanSkills(this);
    }
    private handleSkillsDirChange(): void {
        return watcherSkills.handleSkillsDirChange(this);
    }
    private handleSkillChange(slug: string): void {
        return watcherSkills.handleSkillChange(this, slug);
    }
    private handleWorkspacePermissionsChange(): void {
        return watcherWorkspace.handleWorkspacePermissionsChange(this);
    }
    private handleConfigChange(): void {
        return watcherWorkspace.handleConfigChange(this);
    }
    private handlePreferencesChange(): void {
        return watcherWorkspace.handlePreferencesChange(this);
    }
    private handleStatusConfigChange(): void {
        return watcherWorkspace.handleStatusConfigChange(this);
    }
    private handleStatusIconChange(iconFilename: string): void {
        return watcherWorkspace.handleStatusIconChange(this, iconFilename);
    }
    private handleLabelConfigChange(): void {
        return watcherWorkspace.handleLabelConfigChange(this);
    }
    private handleAutomationsConfigChange(): void {
        return watcherWorkspace.handleAutomationsConfigChange(this);
    }
    private handleSessionMetadataChange(sessionId: string): void {
        return watcherWorkspace.handleSessionMetadataChange(this, sessionId);
    }
    private handleAppThemeChange(): void {
        return watcherThemes.handleAppThemeChange(this);
    }
    private watchAppThemesDir(): void {
        return watcherThemes.watchAppThemesDir(this);
    }
    private watchAppPermissionsDir(): void {
        return watcherThemes.watchAppPermissionsDir(this);
    }
    private handleDefaultPermissionsChange(): void {
        return watcherThemes.handleDefaultPermissionsChange(this);
    }
    private scanAppThemes(): void {
        return watcherThemes.scanAppThemes(this);
    }
    private handlePresetThemeChange(themeId: string): void {
        return watcherThemes.handlePresetThemeChange(this, themeId);
    }
}
// ============================================================
// Factory Function
// ============================================================
/**
 * Create and start a config watcher for a specific workspace.
 * Returns the watcher instance for later cleanup.
 */
export function createConfigWatcher(workspaceId: string, callbacks: ConfigWatcherCallbacks): ConfigWatcher {
    const watcher = new ConfigWatcher(workspaceId, callbacks);
    watcher.start();
    return watcher;
}
