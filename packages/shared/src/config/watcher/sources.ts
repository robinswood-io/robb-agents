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
import { existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { debug } from "../../utils/debug.ts";
import { validateSource } from "../validators.ts";
import { loadSource, loadWorkspaceSources, loadSourceGuide, sourceNeedsIconDownload, downloadSourceIcon } from "../../sources/storage.ts";
import { permissionsConfigCache } from "../../agent/permissions-config.ts";
import type { ConfigWatcher } from '../watcher.ts';

// ============================================================
  // Sources Handlers
  // ============================================================

  /**
   * Scan sources directory to populate known sources
   */
export function scanSources(transportOwner: ConfigWatcher): void {
    if (!existsSync(transportOwner["sourcesDir"])) {
        mkdirSync(transportOwner["sourcesDir"], { recursive: true });
        return;
    }
    try {
        const entries = readdirSync(transportOwner["sourcesDir"]);
        for (const entry of entries) {
            const entryPath = join(transportOwner["sourcesDir"], entry);
            if (statSync(entryPath).isDirectory()) {
                transportOwner["knownSources"].add(entry);
            }
        }
        debug('[ConfigWatcher] Known sources:', Array.from(transportOwner["knownSources"]));
    }
    catch (error) {
        debug('[ConfigWatcher] Error scanning sources:', error);
    }
}

/**
   * Handle sources directory change (add/remove folders)
   */
export function handleSourcesDirChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] Sources directory changed');
    if (!existsSync(transportOwner["sourcesDir"])) {
        // Directory was deleted
        const removed = Array.from(transportOwner["knownSources"]);
        transportOwner["knownSources"].clear();
        for (const slug of removed) {
            transportOwner["callbacks"].onSourceChange?.(slug, null);
        }
        transportOwner["callbacks"].onSourcesListChange?.([]);
        return;
    }
    try {
        const entries = readdirSync(transportOwner["sourcesDir"]);
        const currentFolders = new Set<string>();
        for (const entry of entries) {
            const entryPath = join(transportOwner["sourcesDir"], entry);
            if (statSync(entryPath).isDirectory()) {
                currentFolders.add(entry);
            }
        }
        // Find added folders
        for (const folder of currentFolders) {
            if (!transportOwner["knownSources"].has(folder)) {
                debug('[ConfigWatcher] New source folder:', folder);
                transportOwner["knownSources"].add(folder);
                const source = loadSource(transportOwner["workspaceDir"], folder);
                if (source) {
                    transportOwner["callbacks"].onSourceChange?.(folder, source);
                }
            }
        }
        // Find removed folders
        for (const folder of transportOwner["knownSources"]) {
            if (!currentFolders.has(folder)) {
                debug('[ConfigWatcher] Removed source folder:', folder);
                transportOwner["knownSources"].delete(folder);
                transportOwner["callbacks"].onSourceChange?.(folder, null);
            }
        }
        // Notify list change
        const allSources = loadWorkspaceSources(transportOwner["workspaceDir"]);
        transportOwner["callbacks"].onSourcesListChange?.(allSources);
    }
    catch (error) {
        debug('[ConfigWatcher] Error handling sources dir change:', error);
        transportOwner["callbacks"].onError?.('sources/', error as Error);
    }
}

/**
   * Handle source config.json change
   * Downloads icon if URL specified and no local icon exists
   */
export function handleSourceConfigChange(transportOwner: ConfigWatcher, slug: string): void {
    debug('[ConfigWatcher] Source config changed:', slug);
    const validation = validateSource(transportOwner["workspaceDir"], slug);
    if (!validation.valid) {
        debug('[ConfigWatcher] Source validation failed:', slug, validation.errors);
        transportOwner["callbacks"].onValidationError?.(`sources/${slug}/config.json`, validation);
        return;
    }
    const source = loadSource(transportOwner["workspaceDir"], slug);
    // Check if icon needs to be downloaded (URL in config, no local file)
    if (source && sourceNeedsIconDownload(transportOwner["workspaceDir"], slug, source.config)) {
        debug('[ConfigWatcher] Downloading source icon:', slug);
        downloadSourceIcon(transportOwner["workspaceDir"], slug, source.config.icon!)
            .then((iconPath) => {
            if (iconPath) {
                debug('[ConfigWatcher] Source icon downloaded:', slug, iconPath);
                // Re-emit source change with updated icon path
                const updatedSource = loadSource(transportOwner["workspaceDir"], slug);
                transportOwner["callbacks"].onSourceChange?.(slug, updatedSource);
            }
        })
            .catch((err: unknown) => {
            debug('[ConfigWatcher] Source icon download failed:', slug, err);
        });
    }
    transportOwner["callbacks"].onSourceChange?.(slug, source);
}

/**
   * Handle source guide.md change
   */
export function handleSourceGuideChange(transportOwner: ConfigWatcher, slug: string): void {
    debug('[ConfigWatcher] Source guide changed:', slug);
    const guide = loadSourceGuide(transportOwner["workspaceDir"], slug);
    if (guide) {
        transportOwner["callbacks"].onSourceGuideChange?.(slug, guide);
    }
    // Also emit full source change
    const source = loadSource(transportOwner["workspaceDir"], slug);
    if (source) {
        transportOwner["callbacks"].onSourceChange?.(slug, source);
    }
}

/**
   * Handle source permissions.json change
   */
export function handleSourcePermissionsChange(transportOwner: ConfigWatcher, slug: string): void {
    debug('[ConfigWatcher] Source permissions.json changed:', slug);
    // Invalidate cache
    permissionsConfigCache.invalidateSource(transportOwner["workspaceDir"], slug);
    // Notify callback
    transportOwner["callbacks"].onSourcePermissionsChange?.(slug);
}
