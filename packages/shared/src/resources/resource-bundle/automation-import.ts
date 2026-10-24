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
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { AUTOMATIONS_CONFIG_FILE, AUTOMATIONS_DEAD_LETTER_FILE, AUTOMATIONS_HISTORY_FILE, AUTOMATIONS_RETRY_QUEUE_FILE } from "../../automations/constants.ts";
import { validateAutomationsConfig } from "../../automations/validation.ts";
import { generateShortId } from "../../automations/resolve-config-path.ts";
import type { AutomationMatcher } from "../../automations/types.ts";
import type { AutomationBundleEntry, ResourceImportMode, ImportBucketResult } from "../types.ts";
import { emptyBucketResult } from './resource-import-empty-bucket-result.ts';

// ============================================================
// Import: Automations
// ============================================================

/** Display label for an automation entry (name if available, otherwise ID) */
function automationLabel(entry: AutomationBundleEntry): string {
  return entry.name ?? entry.id
}

/**
 * Find a matcher by ID across all event arrays.
 * Returns { event, index } if found, undefined otherwise.
 */
function findMatcherById(
  automations: Record<string, AutomationMatcher[]>,
  id: string,
): { event: string; index: number } | undefined {
  for (const [event, matchers] of Object.entries(automations)) {
    for (let i = 0; i < matchers.length; i++) {
      if (matchers[i]?.id === id) return { event, index: i }
    }
  }
  return undefined
}

/**
 * Filter JSONL file to remove entries matching a set of matcher IDs.
 * Used for selective history/retry-queue cleanup on overwrite.
 */
function filterJsonlByMatcherIds(filePath: string, idsToRemove: Set<string>): void {
  if (!existsSync(filePath) || idsToRemove.size === 0) return

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n')
    const kept: string[] = []

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        if (entry.matcherId && idsToRemove.has(entry.matcherId)) continue
        // History entries use automationId
        if (entry.automationId && idsToRemove.has(entry.automationId)) continue
        kept.push(line)
      } catch {
        // Keep unparseable lines (don't silently drop data)
        kept.push(line)
      }
    }

    writeFileSync(filePath, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf-8')
  } catch {
    // Non-critical: cleanup failure doesn't block import
  }
}

export function importAutomations(
  workspaceRootPath: string,
  entries: AutomationBundleEntry[],
  mode: ResourceImportMode,
): ImportBucketResult {
  const result = emptyBucketResult()
  const configPath = join(workspaceRootPath, AUTOMATIONS_CONFIG_FILE)

  // Read existing config (if present)
  let existingConfig: { version?: number; automations: Record<string, AutomationMatcher[]> }

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
      const validation = validateAutomationsConfig(raw)
      if (validation.valid && validation.config) {
        existingConfig = {
          version: (raw as Record<string, unknown>).version as number | undefined,
          automations: validation.config.automations as Record<string, AutomationMatcher[]>,
        }
      } else if (mode === 'overwrite') {
        // Existing config is invalid but we're overwriting — start fresh
        result.warnings.push('Existing automations.json is invalid, starting fresh in overwrite mode')
        existingConfig = { version: 2, automations: {} }
      } else {
        // Skip mode + invalid existing config — can't safely merge
        const errorMsg = `Cannot merge into invalid existing automations.json: ${validation.errors.join('; ')}`
        for (const entry of entries) {
          result.failed.push({ id: automationLabel(entry), error: errorMsg })
        }
        return result
      }
    } catch (err) {
      if (mode === 'overwrite') {
        result.warnings.push(`Existing automations.json is unreadable (${err}), starting fresh in overwrite mode`)
        existingConfig = { version: 2, automations: {} }
      } else {
        const errorMsg = `Cannot read existing automations.json: ${err}`
        for (const entry of entries) {
          result.failed.push({ id: automationLabel(entry), error: errorMsg })
        }
        return result
      }
    }
  } else {
    // No existing file — create new
    existingConfig = { version: 2, automations: {} }
  }

  const overwrittenIds = new Set<string>()

  // Merge entries
  for (const entry of entries) {
    // Backfill ID if missing
    const id = entry.id || generateShortId()
    const matcher: AutomationMatcher = { ...entry.matcher, id }
    const label = entry.name ?? id

    // Check if automation with this ID already exists
    const existing = findMatcherById(existingConfig.automations, id)

    if (existing) {
      if (mode === 'skip') {
        result.skipped.push(label)
        continue
      }
      // Overwrite: remove old, insert new at same position
      existingConfig.automations[existing.event]!.splice(existing.index, 1)
      // Clean up empty event arrays
      if (existingConfig.automations[existing.event]!.length === 0) {
        delete existingConfig.automations[existing.event]
      }
      overwrittenIds.add(id)
    }

    // Insert into the target event's matcher array
    if (!existingConfig.automations[entry.event]) {
      existingConfig.automations[entry.event] = []
    }
    existingConfig.automations[entry.event]!.push(matcher)
    result.imported.push(label)
  }

  // Validate the merged full config (schema + semantic: regex, cron, timezone, conditions)
  const mergedValidation = validateAutomationsConfig({
    version: existingConfig.version,
    automations: existingConfig.automations,
  })

  if (!mergedValidation.valid) {
    // Reject the entire import — merged config is invalid
    const errorMsg = `Merged automations config is invalid: ${mergedValidation.errors.join('; ')}`
    result.imported = []
    result.skipped = []
    for (const entry of entries) {
      result.failed.push({ id: automationLabel(entry), error: errorMsg })
    }
    return result
  }

  // Write atomically: temp file + rename
  try {
    const configObj = {
      version: existingConfig.version ?? 2,
      automations: existingConfig.automations,
    }
    const tmpPath = configPath + `.tmp-${randomUUID().slice(0, 8)}`
    writeFileSync(tmpPath, JSON.stringify(configObj, null, 2) + '\n', 'utf-8')
    renameSync(tmpPath, configPath)
  } catch (err) {
    const errorMsg = `Failed to write automations.json: ${err}`
    result.imported = []
    for (const entry of entries) {
      result.failed.push({ id: automationLabel(entry), error: errorMsg })
    }
    return result
  }

  // Selectively clear history + retry queue for overwritten matcher IDs
  if (overwrittenIds.size > 0) {
    const historyPath = join(workspaceRootPath, AUTOMATIONS_HISTORY_FILE)
    const retryPath = join(workspaceRootPath, AUTOMATIONS_RETRY_QUEUE_FILE)
    const deadLetterPath = join(workspaceRootPath, AUTOMATIONS_DEAD_LETTER_FILE)
    filterJsonlByMatcherIds(historyPath, overwrittenIds)
    filterJsonlByMatcherIds(retryPath, overwrittenIds)
    filterJsonlByMatcherIds(deadLetterPath, overwrittenIds)
    result.warnings.push(`Cleared history/retry/dead-letter entries for ${overwrittenIds.size} overwritten automation(s)`)
  }

  return result
}
