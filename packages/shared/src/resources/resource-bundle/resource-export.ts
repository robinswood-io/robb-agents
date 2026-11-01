import { parseJsonObject } from '../../utils/json.ts';
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
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { MAX_BUNDLE_SIZE_BYTES } from "../../utils/bundle-files.ts";
import type { FolderSourceConfig } from "../../sources/types.ts";
import type { ResourceBundle, SourceBundleEntry, SkillBundleEntry, ExportResourcesOptions, ExportResult } from "../types.ts";
import { exportAutomations } from './automation-export.ts';
import { collectPortableResourceFiles, existingConfinedCollectionDirectory, existingConfinedResourceDirectory, hasFilesystemEntry, loadConfinedSourceConfig } from './resource-paths.ts';
import { PROTECTED_SOURCE_OVERLAY_MARKER, PROTECTED_SOURCE_TRANSACTION_SLUG, sanitizeSourceConfig } from './source-sanitization.ts';
import { acquireSourceTransactionLock, isCanonicalResourceSlug } from './source-transaction.ts';

/**
 * Export workspace resources to a portable ResourceBundle.
 *
 * @param workspaceRootPath - Absolute path to workspace root
 * @param options - Which resources to export
 * @returns Bundle + export warnings
 */
export function exportResources(
  workspaceRootPath: string,
  options: ExportResourcesOptions,
): ExportResult {
  const warnings: string[] = []
  const bundle: ResourceBundle = {
    version: 1,
    exportedAt: Date.now(),
    resources: {},
  }

  // Try to read workspace name for informational purposes
  try {
    const wsConfigPath = join(workspaceRootPath, 'config.json')
    if (existsSync(wsConfigPath)) {
      const wsConfig = parseJsonObject(readFileSync(wsConfigPath, 'utf-8'))
      if (typeof wsConfig["name"] === "string" && wsConfig["name"]) {
        bundle.sourceWorkspace = wsConfig["name"]
      }
    }
  } catch {
    // Non-fatal: sourceWorkspace is informational
  }

  // --- Export sources ---
  if (options.sources) {
    bundle.resources.sources = exportSources(workspaceRootPath, options.sources, warnings)
  }

  // --- Export skills ---
  if (options.skills) {
    bundle.resources.skills = exportSkills(workspaceRootPath, options.skills, warnings)
  }

  // --- Export automations ---
  // Normalize: true → 'all', false/undefined → skip
  const automationSelection = options.automations === true ? 'all' : options.automations
  if (automationSelection) {
    bundle.resources.automations = exportAutomations(workspaceRootPath, automationSelection, warnings)
  }

  // Validate total size
  const bundleJson = JSON.stringify(bundle)
  if (Buffer.byteLength(bundleJson) > MAX_BUNDLE_SIZE_BYTES) {
    warnings.push(`Bundle exceeds ${MAX_BUNDLE_SIZE_BYTES / 1024 / 1024}MB size limit`)
  }

  return { bundle, warnings }
}

function exportSources(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): SourceBundleEntry[] {
  const entries: SourceBundleEntry[] = []
  let sourcesDir: string | undefined
  try {
    sourcesDir = existingConfinedCollectionDirectory(workspaceRootPath, 'sources')
  } catch (error) {
    warnings.push(`Sources export rejected because its workspace boundary is unsafe: ${error}`)
    return entries
  }
  if (!sourcesDir) return entries

  // Determine which slugs to export
  let slugs: string[]
  if (selection === 'all') {
    slugs = readdirSync(sourcesDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } else {
    slugs = selection
  }

  for (const slug of slugs) {
    if (!isCanonicalResourceSlug(slug)) {
      warnings.push(`Source slug '${slug}' is not canonical, skipping`)
      continue
    }
    let sourcePath: string | undefined
    try {
      sourcePath = existingConfinedResourceDirectory(sourcesDir, slug)
    } catch (error) {
      warnings.push(`Source '${slug}' is outside the trusted resource boundary, skipping: ${error}`)
      continue
    }
    if (!sourcePath) {
      warnings.push(`Source '${slug}' not found, skipping`)
      continue
    }

    let releaseSourceLock: () => string | undefined = () => undefined
    if (slug === PROTECTED_SOURCE_TRANSACTION_SLUG) {
      try {
        releaseSourceLock = acquireSourceTransactionLock(sourcesDir, slug, 'resource-export')
      } catch (error) {
        warnings.push(`Source '${slug}' could not be locked for a consistent export: ${error}`)
        continue
      }
    }

    try {
      if (hasFilesystemEntry(join(sourcePath, PROTECTED_SOURCE_OVERLAY_MARKER))) {
        warnings.push(`Source '${slug}' uses a protected local overlay and cannot be exported as a portable resource`)
        continue
      }

      let config: FolderSourceConfig | null
      try {
        config = loadConfinedSourceConfig(sourcePath)
      } catch (error) {
        warnings.push(`Source '${slug}' has unsafe config, skipping: ${error}`)
        continue
      }
      if (!config) {
        warnings.push(`Source '${slug}' has invalid config, skipping`)
        continue
      }

      // Sanitize config
      const { config: sanitizedConfig, warnings: sanitizeWarnings } = sanitizeSourceConfig(config)
      warnings.push(...sanitizeWarnings)

      // Collect all files except config.json (which travels as structured data)
      const files = collectPortableResourceFiles(sourcePath, `Source '${slug}'`, warnings, {
        skipFiles: new Set(['config.json']),
      })

      entries.push({
        slug,
        config: sanitizedConfig,
        files,
      })
    } finally {
      const cleanupWarning = releaseSourceLock()
      if (cleanupWarning) {
        warnings.push(`Source '${slug}': ${cleanupWarning}`)
      }
    }
  }

  return entries
}

function exportSkills(
  workspaceRootPath: string,
  selection: string[] | 'all',
  warnings: string[],
): SkillBundleEntry[] {
  const entries: SkillBundleEntry[] = []
  let skillsDir: string | undefined
  try {
    skillsDir = existingConfinedCollectionDirectory(workspaceRootPath, 'skills')
  } catch (error) {
    warnings.push(`Skills export rejected because its workspace boundary is unsafe: ${error}`)
    return entries
  }
  if (!skillsDir) return entries

  // Determine which slugs to export
  let slugs: string[]
  if (selection === 'all') {
    slugs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
  } else {
    slugs = selection
  }

  for (const slug of slugs) {
    if (!isCanonicalResourceSlug(slug)) {
      warnings.push(`Skill slug '${slug}' is not canonical, skipping`)
      continue
    }
    let skillDir: string | undefined
    try {
      skillDir = existingConfinedResourceDirectory(skillsDir, slug)
    } catch (error) {
      warnings.push(`Skill '${slug}' is outside the trusted resource boundary, skipping: ${error}`)
      continue
    }
    if (!skillDir) {
      warnings.push(`Skill '${slug}' not found, skipping`)
      continue
    }

    // Collect all files in the skill directory
    const files = collectPortableResourceFiles(skillDir, `Skill '${slug}'`, warnings)

    // Validate that SKILL.md is present
    const hasSkillMd = files.some(f => f.relativePath === 'SKILL.md')
    if (!hasSkillMd) {
      warnings.push(`Skill '${slug}' missing SKILL.md, skipping`)
      continue
    }

    entries.push({ slug, files })
  }

  return entries
}
