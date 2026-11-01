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
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { restoreFiles } from "../../utils/bundle-files.ts";
import { assertMcpTransportWriteAllowed } from "../../sources/mcp-transport-policy.ts";
import { isBuiltinSource } from "../../sources/builtin-sources.ts";
import { validateSourceConfig } from "../../config/validators.ts";
import type { FolderSourceConfig } from "../../sources/types.ts";
import type { SourceBundleEntry, ResourceImportMode, ImportBucketResult, ResourceImportDeps } from "../types.ts";
import { emptyBucketResult, stagedSourceTreeFingerprint } from './resource-import-empty-bucket-result.ts';
import { assertPortableSourceImportAllowed, ensureConfinedCollectionDirectory, existingConfinedResourceDirectory, loadConfinedSourceConfig } from './resource-paths.ts';
import { PROTECTED_SOURCE_TRANSACTION_SLUG } from './source-sanitization.ts';
import { withSourceTransactionLock } from './source-transaction.ts';

// ============================================================
// Import: Sources
// ============================================================

export async function importSources(
  workspaceRootPath: string,
  workspaceId: string,
  entries: SourceBundleEntry[],
  mode: ResourceImportMode,
  deps: ResourceImportDeps,
): Promise<ImportBucketResult> {
  const result = emptyBucketResult()
  let sourcesDir: string
  try {
    sourcesDir = ensureConfinedCollectionDirectory(workspaceRootPath, 'sources')
  } catch (error) {
    const message = `Sources import rejected because its workspace boundary is unsafe: ${error}`
    for (const entry of entries) result.failed.push({ id: entry.slug, error: message })
    return result
  }

  for (const entry of entries) {
    try {
      // Check for reserved slugs
      if (isBuiltinSource(entry.slug)) {
        result.failed.push({ id: entry.slug, error: 'Cannot import builtin source slug' })
        continue
      }
      if (entry.slug === PROTECTED_SOURCE_TRANSACTION_SLUG) {
        result.failed.push({
          id: entry.slug,
          error: 'Protected google-contacts source cannot be imported from a portable resource bundle; use its verified local overlay installer',
        })
        continue
      }

      await withSourceTransactionLock(sourcesDir, entry.slug, async () => {
        const targetDir = join(sourcesDir, entry.slug)
        const existingTarget = existingConfinedResourceDirectory(sourcesDir, entry.slug)
        const exists = existingTarget !== undefined

        if (exists && mode === 'skip') {
          result.skipped.push(entry.slug)
          return
        }

        const existingConfig = existingTarget ? loadConfinedSourceConfig(existingTarget) : null

        // Stage: build in temp dir while holding the same per-source lock as
        // the private overlay installer.
        const tmpDir = join(sourcesDir, `.tmp-${entry.slug}-${randomUUID().slice(0, 8)}`)
        mkdirSync(tmpDir, { recursive: true })

        try {
          // Write sanitized config.json
          writeFileSync(join(tmpDir, 'config.json'), JSON.stringify(entry.config, null, 2))

          // Restore all other files
          restoreFiles(tmpDir, entry.files)

          const validateStagedImport = (): FolderSourceConfig => {
            // Validate the exact descriptor-bound staged config that will be
            // committed. Bundle metadata is not a substitute for staged bytes.
            const stagedConfig = loadConfinedSourceConfig(tmpDir)
            if (!stagedConfig) {
              throw new Error('Invalid staged source config: unreadable config.json')
            }
            const validation = validateSourceConfig(stagedConfig)
            if (!validation.valid) {
              const msgs = validation.errors.map(e => `${e.path}: ${e.message}`).join(', ')
              throw new Error(`Invalid source config: ${msgs}`)
            }
            if (stagedConfig.slug !== entry.slug) {
              throw new Error(`Staged source config slug '${stagedConfig.slug}' does not match '${entry.slug}'`)
            }
            assertMcpTransportWriteAllowed(stagedConfig, existingConfig)

            // This host-owned invariant is deliberately inside the shared
            // import path so a future caller cannot bypass it by omitting an
            // optional dependency hook. Protected overlays are installed and
            // rolled back only by their manifest-verifying installer.
            assertPortableSourceImportAllowed(targetDir, tmpDir)
            return stagedConfig
          }

          validateStagedImport()
          const stagedFingerprint = stagedSourceTreeFingerprint(tmpDir)

          // Give callers a final chance to validate the completely restored
          // source while the current live source and its credentials are still
          // untouched. Throwing/rejecting aborts this entry and only removes the
          // temporary staging directory in the enclosing catch block.
          await deps.validateStagedSource?.(workspaceId, entry.slug, tmpDir)
          if (stagedSourceTreeFingerprint(tmpDir) !== stagedFingerprint) {
            throw new Error('Staged source changed during validateStagedSource; import rejected')
          }
          // Re-run the semantic/overlay invariants immediately before the live
          // source is touched, even though the byte fingerprint is unchanged.
          validateStagedImport()

          // On overwrite: clear credentials + remove old dir
          if (exists) {
            // Clear all credential types for this slug
            try {
              await deps.clearSourceCredentials(workspaceId, entry.slug)
            } catch (err) {
              result.warnings.push(`Source '${entry.slug}': failed to clear credentials: ${err}`)
            }
            // Credential cleanup is asynchronous and therefore re-opens the
            // staging TOCTOU window even after the validation hook returned.
            // Bind the promotion to the original staged bytes one final time;
            // from this point through rename there are no further awaits.
            if (stagedSourceTreeFingerprint(tmpDir) !== stagedFingerprint) {
              throw new Error('Staged source changed during credential cleanup; import rejected')
            }
            validateStagedImport()
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
      }, warning => result.warnings.push(`Source '${entry.slug}': ${warning}`))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.failed.push({ id: entry.slug, error: message })
    }
  }

  return result
}
