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
import { platform } from "os";
import { CONFIG_DIR } from "../paths.ts";
import { debug } from "../../utils/debug.ts";
import { readJsonFileSync } from "../../utils/files.ts";
import { type StoredConfig } from "../storage.ts";
import { type ValidationResult } from "../validators.ts";
import type { LoadedSource, SourceGuide } from "../../sources/types.ts";
import type { LoadedSkill } from "../../skills/types.ts";
import type { SessionHeader } from "../../sessions/types.ts";
import type { ThemeOverrides, PresetTheme } from "../theme.ts";

// ============================================================
// Active Watcher Registry (duplicate detection)
// ============================================================
/**
 * Tracks active ConfigWatcher instances by workspace directory.
 * Used to detect duplicate recursive watchers on the same directory tree,
 * which can wedge Bun's event loop on Linux.
 */
export const activeWatchers = new Map<string, string>(); // workspaceDir → creator workspaceId


/** Exported for testing only */
export function _getActiveWatchers(): ReadonlyMap<string, string> {
    return activeWatchers;
}

// ============================================================
// Constants
// ============================================================
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export const PREFERENCES_FILE = join(CONFIG_DIR, 'preferences.json');

// Debounce delay in milliseconds
export const DEBOUNCE_MS = 100;

// Longer debounce for session metadata on Windows where fs.watch() fires
// aggressively for atomic writes (unlink + rename = 2+ events)
export const SESSION_META_DEBOUNCE_MS = platform() === 'win32' ? 300 : DEBOUNCE_MS;

// ============================================================
// Types
// ============================================================
/**
 * User preferences structure (mirrors UserPreferencesSchema)
 */
export interface UserPreferences {
    name?: string;
    timezone?: string;
    location?: {
        city?: string;
        region?: string;
        country?: string;
    };
    notes?: string;
    /** Internal: mirrors Appearance → Language. Maintained by the main-process i18n IPC handler. */
    uiLanguage?: string;
    updatedAt?: number;
}

/**
 * Callbacks for config changes
 */
export interface ConfigWatcherCallbacks {
    /** Called when config.json changes */
    onConfigChange?: (config: StoredConfig) => void;
    /** Called when preferences.json changes */
    onPreferencesChange?: (prefs: UserPreferences) => void;
    /** Called when LLM connections array changes (add/remove/update connections) */
    onLlmConnectionsChange?: (connections: import("../storage.ts").LlmConnection[]) => void;
    // Source callbacks
    /** Called when a specific source config changes (null if deleted) */
    onSourceChange?: (slug: string, source: LoadedSource | null) => void;
    /** Called when a source's guide.md changes */
    onSourceGuideChange?: (slug: string, guide: SourceGuide) => void;
    /** Called when the sources list changes (add/remove folders) */
    onSourcesListChange?: (sources: LoadedSource[]) => void;
    // Skill callbacks
    /** Called when a specific skill changes (null if deleted) */
    onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;
    /** Called when the skills list changes (add/remove folders) */
    onSkillsListChange?: (skills: LoadedSkill[]) => void;
    // Permissions callbacks
    /** Called when app-level default permissions change (~/.craft-agent/permissions/default.json) */
    onDefaultPermissionsChange?: () => void;
    /** Called when workspace permissions.json changes */
    onWorkspacePermissionsChange?: (workspaceId: string) => void;
    /** Called when a source's permissions.json changes */
    onSourcePermissionsChange?: (sourceSlug: string) => void;
    // Status callbacks
    /** Called when statuses config.json changes */
    onStatusConfigChange?: (workspaceId: string) => void;
    /** Called when a status icon file changes */
    onStatusIconChange?: (workspaceId: string, iconFilename: string) => void;
    // Label callbacks
    /** Called when labels config.json changes */
    onLabelConfigChange?: (workspaceId: string) => void;
    // Automations callbacks
    /** Called when automations.json changes */
    onAutomationsConfigChange?: (workspaceId: string) => void;
    // Session callbacks
    /** Called when a session's JSONL header is modified externally (labels, name, flags, etc.) */
    onSessionMetadataChange?: (sessionId: string, header: SessionHeader) => void;
    // Theme callbacks (app-level only)
    /** Called when app-level theme.json changes */
    onAppThemeChange?: (theme: ThemeOverrides | null) => void;
    /** Called when a preset theme file changes (null if deleted) */
    onPresetThemeChange?: (themeId: string, theme: PresetTheme | null) => void;
    /** Called when the preset themes list changes (add/remove files) */
    onPresetThemesListChange?: (themes: PresetTheme[]) => void;
    // Error callbacks
    /** Called when a validation error occurs */
    onValidationError?: (file: string, result: ValidationResult) => void;
    /** Called when an error occurs reading/parsing a file */
    onError?: (file: string, error: Error) => void;
}

// ============================================================
// Preferences Loading
// ============================================================
/**
 * Load preferences from file
 */
export function loadPreferences(): UserPreferences | null {
    if (!existsSync(PREFERENCES_FILE)) {
        return null;
    }
    try {
        return readJsonFileSync<UserPreferences>(PREFERENCES_FILE);
    }
    catch (error) {
        debug('[ConfigWatcher] Error loading preferences', error);
        return null;
    }
}
