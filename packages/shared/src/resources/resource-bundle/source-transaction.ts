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
import { closeSync, fstatSync, fsyncSync, lstatSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { execFileSync } from "node:child_process";
import { errnoCode, hasFilesystemEntry } from './resource-paths.ts';
import { PROTECTED_SOURCE_TRANSACTION_SLUG, RESOURCE_SLUG_PATTERN, SOURCE_TRANSACTION_LOCK_PREFIX } from './source-sanitization.ts';

export function isCanonicalResourceSlug(slug: string): boolean {
  return RESOURCE_SLUG_PATTERN.test(slug)
}

function sourceTransactionLockPath(sourcesDir: string, slug: string): string {
  if (!isCanonicalResourceSlug(slug)) {
    throw new Error(`Invalid source transaction slug '${slug}'`)
  }
  return join(sourcesDir, `${SOURCE_TRANSACTION_LOCK_PREFIX}${slug}.lock`)
}

function fsyncDirectorySync(directory: string): void {
  if (process.platform === 'win32') return
  const descriptor = openSync(directory, 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function processStartIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const commandEnd = raw.lastIndexOf(')')
      if (commandEnd < 0) return undefined
      const fieldsAfterCommand = raw.slice(commandEnd + 2).trim().split(/\s+/u)
      const startTicks = fieldsAfterCommand[19]
      return bootId && startTicks ? `linux:${bootId}:${startTicks}` : undefined
    }
    if (process.platform === 'darwin' || process.platform === 'freebsd') {
      const value = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().replace(/\s+/gu, ' ')
      return value ? `ps-lstart:${value}` : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

export function acquireSourceTransactionLock(
  sourcesDir: string,
  slug: string,
  operation: 'resource-import' | 'resource-export',
): () => string | undefined {
  const lockPath = sourceTransactionLockPath(sourcesDir, slug)
  const partialPath = `${lockPath}.partial-${process.pid}-${randomUUID()}`
  let descriptor: number
  try {
    descriptor = openSync(partialPath, 'wx', 0o600)
  } catch (error) {
    throw new Error(`Cannot initialize source transaction lock for '${slug}': ${error}`)
  }

  let acquired: ReturnType<typeof fstatSync> | undefined
  let published = false
  let conflict = false
  try {
    acquired = fstatSync(descriptor)
    const identity = processStartIdentity(process.pid)
    writeFileSync(descriptor, JSON.stringify({
      schemaVersion: 1,
      slug,
      pid: process.pid,
      operation,
      createdAtUnixMs: Date.now(),
      ...(identity ? { ownerProcessIdentity: identity } : {}),
    }) + '\n')
    fsyncSync(descriptor)
    try {
      // The public lock pathname becomes visible only after its complete,
      // durable receipt exists. link(2) supplies atomic no-replace semantics.
      linkSync(partialPath, lockPath)
      published = true
    } catch (error) {
      if (errnoCode(error) === 'EEXIST') conflict = true
      throw error
    }
    fsyncDirectorySync(sourcesDir)
    unlinkSync(partialPath)
    fsyncDirectorySync(sourcesDir)
  } catch (error) {
    const cleanupErrors: string[] = []
    try {
      if (published && acquired) {
        const current = lstatSync(lockPath)
        if (current.isFile() && current.dev === acquired.dev && current.ino === acquired.ino) {
          unlinkSync(lockPath)
          fsyncDirectorySync(sourcesDir)
        } else {
          cleanupErrors.push(`lock changed before initialization cleanup: ${lockPath}`)
        }
      } else if (published) {
        cleanupErrors.push(`lock identity was not captured: ${lockPath}`)
      }
    } catch (cleanupError) {
      cleanupErrors.push(`cannot clean up uninitialized lock: ${cleanupError}`)
    }
    try {
      if (acquired && hasFilesystemEntry(partialPath)) {
        const partial = lstatSync(partialPath)
        if (partial.isFile() && partial.dev === acquired.dev && partial.ino === acquired.ino) {
          unlinkSync(partialPath)
          fsyncDirectorySync(sourcesDir)
        } else {
          cleanupErrors.push(`partial lock changed before cleanup: ${partialPath}`)
        }
      }
    } catch (cleanupError) {
      cleanupErrors.push(`cannot clean up partial lock: ${cleanupError}`)
    } finally {
      try {
        closeSync(descriptor)
      } catch (closeError) {
        cleanupErrors.push(`cannot close lock descriptor: ${closeError}`)
      }
    }
    const cleanupDetail = cleanupErrors.length > 0 ? `; ${cleanupErrors.join('; ')}` : ''
    if (conflict) {
      throw new Error(`Another source transaction is already active for '${slug}': ${lockPath}${cleanupDetail}`)
    }
    throw new Error(`Cannot initialize source transaction lock for '${slug}': ${error}${cleanupDetail}`)
  }

  let released = false
  return () => {
    if (released) return undefined
    released = true
    const cleanupErrors: string[] = []
    try {
      const current = lstatSync(lockPath)
      if (!current.isFile() || current.dev !== acquired.dev || current.ino !== acquired.ino) {
        cleanupErrors.push(`Source transaction lock changed while held; refusing cleanup: ${lockPath}`)
      } else {
        unlinkSync(lockPath)
        fsyncDirectorySync(sourcesDir)
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      cleanupErrors.push(
        code === 'ENOENT'
          ? `Source transaction lock disappeared while held: ${lockPath}`
          : `Cannot inspect or remove source transaction lock ${lockPath}: ${error}`,
      )
    } finally {
      try {
        closeSync(descriptor)
      } catch (error) {
        cleanupErrors.push(`Cannot close source transaction lock descriptor: ${error}`)
      }
    }
    return cleanupErrors.length > 0 ? cleanupErrors.join('; ') : undefined
  }
}

export async function withSourceTransactionLock<T>(
  sourcesDir: string,
  slug: string,
  operation: () => Promise<T>,
  onCleanupWarning?: (warning: string) => void,
): Promise<T> {
  if (slug !== PROTECTED_SOURCE_TRANSACTION_SLUG) return operation()
  const release = acquireSourceTransactionLock(sourcesDir, slug, 'resource-import')
  try {
    return await operation()
  } finally {
    const warning = release()
    if (warning) onCleanupWarning?.(warning)
  }
}
