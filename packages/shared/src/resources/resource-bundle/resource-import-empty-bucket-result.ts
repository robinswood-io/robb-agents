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
import { constants, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { canonicalConfinementRoot, openConfinedRegularFile } from "../../missions/confined-file.ts";
import type { ImportBucketResult } from "../types.ts";

export function emptyBucketResult(): ImportBucketResult {
  return { imported: [], skipped: [], failed: [], warnings: [] }
}

/** Bind validation to the exact staged bytes that may be promoted. A caller
 * validation hook is observational: if it changes a file, directory, link, or
 * hidden marker while it runs, its verdict no longer applies to the staged
 * source and the import must fail closed. */
export function stagedSourceTreeFingerprint(stagedDir: string): string {
  const root = canonicalConfinementRoot(stagedDir)
  const hash = createHash('sha256')

  const walk = (directory: string, relativeDirectory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Staged source contains a symbolic link: ${relativePath}`)
      }
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`)
        walk(path, relativePath)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Staged source contains an unsupported filesystem entry: ${relativePath}`)
      }
      const handle = openConfinedRegularFile(root, path, { flags: constants.O_RDONLY })
      try {
        handle.assertStillBound()
        const content = readFileSync(handle.descriptor)
        handle.assertStillBound()
        hash.update(`file\0${relativePath}\0${content.length}\0`)
        hash.update(content)
      } finally {
        handle.close()
      }
    }
  }

  walk(root, '')
  return hash.digest('hex')
}
