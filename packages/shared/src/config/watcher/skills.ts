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
import { loadSkill, loadAllSkills, invalidateSkillsCache, skillNeedsIconDownload, downloadSkillIcon } from "../../skills/storage.ts";
import type { ConfigWatcher } from '../watcher.ts';

// ============================================================
  // Skills Handlers
  // ============================================================

  /**
   * Scan skills directory to populate known skills
   */
export function scanSkills(transportOwner: ConfigWatcher): void {
    if (!existsSync(transportOwner.skillsDir)) {
        mkdirSync(transportOwner.skillsDir, { recursive: true });
        return;
    }
    try {
        const entries = readdirSync(transportOwner.skillsDir);
        for (const entry of entries) {
            const entryPath = join(transportOwner.skillsDir, entry);
            if (statSync(entryPath).isDirectory()) {
                transportOwner.knownSkills.add(entry);
            }
        }
        debug('[ConfigWatcher] Known skills:', Array.from(transportOwner.knownSkills));
    }
    catch (error) {
        debug('[ConfigWatcher] Error scanning skills:', error);
    }
}

/**
   * Handle skills directory change (add/remove folders)
   */
export function handleSkillsDirChange(transportOwner: ConfigWatcher): void {
    debug('[ConfigWatcher] Skills directory changed');
    if (!existsSync(transportOwner.skillsDir)) {
        // Directory was deleted
        const removed = Array.from(transportOwner.knownSkills);
        transportOwner.knownSkills.clear();
        for (const slug of removed) {
            transportOwner["callbacks"].onSkillChange?.(slug, null);
        }
        transportOwner["callbacks"].onSkillsListChange?.([]);
        return;
    }
    try {
        const entries = readdirSync(transportOwner.skillsDir);
        const currentFolders = new Set<string>();
        for (const entry of entries) {
            const entryPath = join(transportOwner.skillsDir, entry);
            if (statSync(entryPath).isDirectory()) {
                currentFolders.add(entry);
            }
        }
        // Find added folders
        for (const folder of currentFolders) {
            if (!transportOwner.knownSkills.has(folder)) {
                debug('[ConfigWatcher] New skill folder:', folder);
                transportOwner.knownSkills.add(folder);
                const skill = loadSkill(transportOwner["workspaceDir"], folder);
                if (skill) {
                    transportOwner["callbacks"].onSkillChange?.(folder, skill);
                }
            }
        }
        // Find removed folders
        for (const folder of transportOwner.knownSkills) {
            if (!currentFolders.has(folder)) {
                debug('[ConfigWatcher] Removed skill folder:', folder);
                transportOwner.knownSkills.delete(folder);
                transportOwner["callbacks"].onSkillChange?.(folder, null);
            }
        }
        // Invalidate cache before reloading so we get fresh results
        invalidateSkillsCache();
        const allSkills = loadAllSkills(transportOwner["workspaceDir"]);
        transportOwner["callbacks"].onSkillsListChange?.(allSkills);
    }
    catch (error) {
        debug('[ConfigWatcher] Error handling skills dir change:', error);
        transportOwner["callbacks"].onError?.('skills/', error as Error);
    }
}

/**
   * Handle skill SKILL.md or icon change.
   * If the skill has an icon URL in metadata but no local icon file,
   * downloads the icon and emits another change event after completion.
   */
export function handleSkillChange(transportOwner: ConfigWatcher, slug: string): void {
    debug('[ConfigWatcher] Skill changed:', slug);
    const skill = loadSkill(transportOwner["workspaceDir"], slug);
    transportOwner["callbacks"].onSkillChange?.(slug, skill);
    // Check if we need to download an icon from URL
    // This happens when SKILL.md has icon: "https://..." but no local icon.* file exists
    if (skill && skillNeedsIconDownload(skill)) {
        debug('[ConfigWatcher] Skill needs icon download:', slug, skill.metadata.icon);
        // Download asynchronously - don't block the watcher
        downloadSkillIcon(skill.path, skill.metadata.icon!)
            .then((iconPath) => {
            if (iconPath) {
                // Reload the skill with the new icon and emit another change
                const updatedSkill = loadSkill(transportOwner["workspaceDir"], slug);
                debug('[ConfigWatcher] Icon downloaded, emitting updated skill:', slug);
                transportOwner["callbacks"].onSkillChange?.(slug, updatedSkill);
            }
        })
            .catch((error: unknown) => {
            debug('[ConfigWatcher] Icon download failed for skill:', slug, error);
        });
    }
}
