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
import { constants, lstatSync, readFileSync, realpathSync } from "fs";
import { join, basename } from "path";
import { type BundleFile, collectDirectoryFiles } from "../../utils/bundle-files.ts";
import { canonicalConfinementRoot, ensureConfinedDirectory, openConfinedRegularFile } from "../../missions/confined-file.ts";
import { safeJsonParse } from "../../utils/files.ts";
import type { FolderSourceConfig } from "../../sources/types.ts";
import { PROTECTED_SOURCE_OVERLAY_MARKER, SENSITIVE_RESOURCE_FILE_EXTENSIONS, SENSITIVE_RESOURCE_FILE_NAMES } from './source-sanitization.ts';

export function hasFilesystemEntry(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return false
    throw new Error(`Cannot inspect protected source overlay boundary: ${path}`)
  }
}

export function errnoCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined
}

export function existingConfinedCollectionDirectory(
  workspaceRootPath: string,
  collection: 'sources' | 'skills',
): string | undefined {
  const workspaceRoot = canonicalConfinementRoot(workspaceRootPath)
  const directory = join(workspaceRoot, collection)
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(directory)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error(`Resource ${collection} directory is not a real confined directory: ${directory}`)
  }
  return directory
}

export function ensureConfinedCollectionDirectory(
  workspaceRootPath: string,
  collection: 'sources' | 'skills',
): string {
  return ensureConfinedDirectory(workspaceRootPath, collection)
}

export function existingConfinedResourceDirectory(
  collectionDirectory: string,
  slug: string,
): string | undefined {
  const target = join(collectionDirectory, slug)
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(target)
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(target) !== target) {
    throw new Error(`Resource '${slug}' is not a real confined directory: ${target}`)
  }
  return target
}

export function loadConfinedSourceConfig(sourceDirectory: string): FolderSourceConfig | null {
  const configPath = join(sourceDirectory, 'config.json')
  let handle: ReturnType<typeof openConfinedRegularFile>
  try {
    handle = openConfinedRegularFile(sourceDirectory, configPath, {
      flags: constants.O_RDONLY,
    })
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null
    throw new Error(`Source config must be a confined regular file: ${configPath}: ${error}`)
  }
  try {
    const raw = readFileSync(handle.descriptor, 'utf8')
    handle.assertStillBound()
    try {
      const parsed = safeJsonParse(raw)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as FolderSourceConfig
        : null
    } catch {
      return null
    }
  } finally {
    handle.close()
  }
}

export function assertPortableSourceImportAllowed(targetDir: string, stagedDir: string): void {
  if (hasFilesystemEntry(join(targetDir, PROTECTED_SOURCE_OVERLAY_MARKER))) {
    throw new Error(
      'Protected source overlay cannot be replaced through resource import; use its verified overlay installer',
    )
  }
  if (hasFilesystemEntry(join(stagedDir, PROTECTED_SOURCE_OVERLAY_MARKER))) {
    throw new Error(
      'Portable resource imports cannot create a protected source overlay marker; use a verified overlay installer',
    )
  }
}

export function isSensitiveResourceBundleFile(relativePath: string): boolean {
  const fileName = basename(relativePath).toLowerCase()
  if (SENSITIVE_RESOURCE_FILE_NAMES.has(fileName)) return true
  if (SENSITIVE_RESOURCE_FILE_EXTENSIONS.some(extension => fileName.endsWith(extension))) return true
  const metadataExtensions = ['.json', '.yaml', '.yml', '.toml', '.ini']
  const extension = metadataExtensions.find(candidate => fileName.endsWith(candidate))
  if (!extension) return false
  const stem = fileName.slice(0, -extension.length)
  const firstSeparator = [...stem].findIndex(character => character === '-' || character === '_' || character === '.')
  const category = firstSeparator === -1 ? stem : stem.slice(0, firstSeparator)
  return ['credential', 'secret', 'token', 'oauth', 'auth'].includes(category)
}

export function collectPortableResourceFiles(
  directory: string,
  label: string,
  warnings: string[],
  options?: { skipFiles?: Set<string> },
): BundleFile[] {
  return collectDirectoryFiles(directory, options).filter((file) => {
    if (!isSensitiveResourceBundleFile(file.relativePath)) return true
    warnings.push(`${label}: excluded sensitive file '${file.relativePath}' from export`)
    return false
  })
}
