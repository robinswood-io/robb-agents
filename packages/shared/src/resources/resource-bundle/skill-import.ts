/**
 * Resource Bundle — Export/Import Logic
 *
 * Exports workspace resources (sources, skills, automations) to a portable
 * ResourceBundle, and imports bundles into a target workspace.
 *
 * Key behaviors:
 * - Source configs are sanitized (secrets stripped, auth state reset)
 * - All non-hidden files are included per resource (not just known file types)
 * - Import uses staging + atomic rename per resource (single watcher event)
 * - Source overwrite clears stored credentials
 * - Automations overwrite clears history + retry queue
 * - Relies on existing ConfigWatcher for change notifications (no manual events)
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { restoreFiles } from "../../utils/bundle-files.ts";
import type { SkillBundleEntry, ResourceImportMode, ImportBucketResult } from "../types.ts";
import { emptyBucketResult } from './resource-import-empty-bucket-result.ts';
import { ensureConfinedCollectionDirectory, existingConfinedResourceDirectory } from './resource-paths.ts';

// ============================================================
// Import: Skills
// ============================================================

export function importSkills(
  workspaceRootPath: string,
  entries: SkillBundleEntry[],
  mode: ResourceImportMode,
): ImportBucketResult {
  const result = emptyBucketResult()
  let skillsDir: string
  try {
    skillsDir = ensureConfinedCollectionDirectory(workspaceRootPath, 'skills')
  } catch (error) {
    const message = `Skills import rejected because its workspace boundary is unsafe: ${error}`
    for (const entry of entries) result.failed.push({ id: entry.slug, error: message })
    return result
  }

  for (const entry of entries) {
    try {
      const targetDir = join(skillsDir, entry.slug)
      const exists = existingConfinedResourceDirectory(skillsDir, entry.slug) !== undefined

      if (exists && mode === 'skip') {
        result.skipped.push(entry.slug)
        continue
      }

      // Stage: build in temp dir
      const tmpDir = join(skillsDir, `.tmp-${entry.slug}-${randomUUID().slice(0, 8)}`)
      mkdirSync(tmpDir, { recursive: true })

      try {
        // Restore all files
        restoreFiles(tmpDir, entry.files)

        // Validate: SKILL.md should exist
        if (!existsSync(join(tmpDir, 'SKILL.md'))) {
          result.failed.push({ id: entry.slug, error: 'SKILL.md missing after restore' })
          rmSync(tmpDir, { recursive: true })
          continue
        }

        // On overwrite: remove old dir
        if (exists) {
          rmSync(targetDir, { recursive: true })
        }

        // Atomic replace: rename temp → target
        renameSync(tmpDir, targetDir)
        result.imported.push(entry.slug)
      } catch (err) {
        // Clean up temp dir on failure
        if (existsSync(tmpDir)) {
          rmSync(tmpDir, { recursive: true })
        }
        throw err
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: entry.slug, error: message })
    }
  }

  return result
}
