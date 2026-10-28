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
import { watch, existsSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { debug } from "../../utils/debug.ts";
import { permissionsConfigCache, getAppPermissionsDir } from "../../agent/permissions-config.ts";
import { loadAppTheme, loadPresetThemes, loadPresetTheme, getAppThemesDir } from "../storage.ts";
import type { ConfigWatcher } from '../watcher.ts';

// ============================================================
  // Theme Handlers (App-Level)
  // ============================================================

  /**
   * Handle app-level theme.json change
   */
export function handleAppThemeChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] App theme.json changed');
    const theme = loadAppTheme();
    transportOwner["callbacks"].onAppThemeChange?.(theme);
}

/**
   * Watch app-level themes directory (~/.craft-agent/themes/)
   */
export function watchAppThemesDir(transportOwner: ConfigWatcher): void {
    const themesDir = getAppThemesDir();
    // Create themes directory if it doesn't exist
    if (!existsSync(themesDir)) {
        mkdirSync(themesDir, { recursive: true });
    }
    try {
        const watcher = watch(themesDir, (_eventType, filename) => {
            if (!filename)
                return;
            // Only handle .json files
            if (filename.endsWith('.json')) {
                const themeId = filename.replace('.json', '');
                transportOwner.debounce(`preset-theme:${themeId}`, () => transportOwner.handlePresetThemeChange(themeId));
            }
        });
        transportOwner.watchers.push(watcher);
        debug('[ConfigWatcher] Watching app themes directory:', themesDir);
    }
    catch (error) {
        debug('[ConfigWatcher] Error watching app themes directory:', error);
    }
}

/**
   * Watch app-level permissions directory (~/.craft-agent/permissions/)
   * Watches for changes to default.json which contains the default read-only patterns
   */
export function watchAppPermissionsDir(transportOwner: ConfigWatcher): void {
    const permissionsDir = getAppPermissionsDir();
    // Create permissions directory if it doesn't exist
    if (!existsSync(permissionsDir)) {
        mkdirSync(permissionsDir, { recursive: true });
    }
    try {
        const watcher = watch(permissionsDir, (_eventType, filename) => {
            if (!filename)
                return;
            // Only watch default.json - this is where the default patterns live
            if (filename === 'default.json') {
                transportOwner.debounce('default-permissions', () => transportOwner.handleDefaultPermissionsChange());
            }
        });
        transportOwner.watchers.push(watcher);
        debug('[ConfigWatcher] Watching app permissions directory:', permissionsDir);
    }
    catch (error) {
        debug('[ConfigWatcher] Error watching app permissions directory:', error);
    }
}

/**
   * Handle default.json permissions change (app-level)
   */
export function handleDefaultPermissionsChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] Default permissions changed');
    // Invalidate the cache so next getMergedConfig() reloads from file
    permissionsConfigCache.invalidateDefaults();
    // Notify callback
    transportOwner["callbacks"].onDefaultPermissionsChange?.();
}

/**
   * Scan app-level themes directory to populate known themes
   */
export function scanAppThemes(transportOwner: ConfigWatcher): void {
    const themesDir = getAppThemesDir();
    if (!existsSync(themesDir)) {
        return;
    }
    try {
        const files = readdirSync(themesDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            const themeId = file.replace('.json', '');
            transportOwner.knownThemes.add(themeId);
        }
        debug('[ConfigWatcher] Known themes:', Array.from(transportOwner.knownThemes));
    }
    catch (error) {
        debug('[ConfigWatcher] Error scanning themes:', error);
    }
}

/**
   * Handle preset theme file change (app-level)
   */
export function handlePresetThemeChange(transportOwner: ConfigWatcher, themeId: string): void {
    debug('[ConfigWatcher] Preset theme changed:', themeId);
    const themesDir = getAppThemesDir();
    const themePath = join(themesDir, `${themeId}.json`);
    if (!existsSync(themePath)) {
        // Theme was deleted
        if (transportOwner.knownThemes.has(themeId)) {
            transportOwner.knownThemes.delete(themeId);
            transportOwner["callbacks"].onPresetThemeChange?.(themeId, null);
            // Also notify list change
            const allThemes = loadPresetThemes();
            transportOwner["callbacks"].onPresetThemesListChange?.(allThemes);
        }
        return;
    }
    // Theme was added or modified
    if (!transportOwner.knownThemes.has(themeId)) {
        transportOwner.knownThemes.add(themeId);
    }
    const theme = loadPresetTheme(themeId);
    transportOwner["callbacks"].onPresetThemeChange?.(themeId, theme);
    // Also notify list change in case name changed (affects sorting)
    const allThemes = loadPresetThemes();
    transportOwner["callbacks"].onPresetThemesListChange?.(allThemes);
}
