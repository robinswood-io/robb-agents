import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Keep log directories and existing log files private to the current OS user.
 *
 * Creation modes do not repair long-lived files made under a permissive umask,
 * so upgrades explicitly converge both the directory and existing file.
 */
export function ensurePrivateLogFilePath(filePath: string): boolean {
  try {
    const directory = dirname(filePath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    if (existsSync(filePath)) chmodSync(filePath, 0o600)
    return true
  } catch {
    // Logging must remain fail-soft. Reporting from inside a transport setup
    // could recurse into the same failing transport.
    return false
  }
}

/** Harden every existing regular log file without following symlinks. */
export function ensurePrivateLogDirectory(directory: string): {
  success: boolean
  hardenedFileCount: number
} {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    let hardenedFileCount = 0
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      chmodSync(join(directory, entry.name), 0o600)
      hardenedFileCount += 1
    }
    return { success: true, hardenedFileCount }
  } catch {
    return { success: false, hardenedFileCount: 0 }
  }
}

/**
 * Redact a pre-existing text log before the logging transport opens it.
 *
 * The migration uses a same-directory atomic rename, refuses symlinks, and
 * preserves the original file when redaction fails.
 */
export function sanitizeExistingLogFile(
  filePath: string,
  sanitize: (content: string) => string,
): { success: boolean; changed: boolean } {
  let temporaryPath: string | undefined
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
      return { success: true, changed: false }
    }

    const original = readFileSync(filePath, 'utf8')
    const sanitized = sanitize(original)
    if (sanitized === original) {
      chmodSync(filePath, 0o600)
      return { success: true, changed: false }
    }

    temporaryPath = `${filePath}.sanitize-${process.pid}-${randomUUID()}`
    writeFileSync(temporaryPath, sanitized, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, filePath)
    temporaryPath = undefined
    chmodSync(filePath, 0o600)
    return { success: true, changed: true }
  } catch {
    if (temporaryPath) {
      try { rmSync(temporaryPath, { force: true }) } catch {}
    }
    return { success: false, changed: false }
  }
}
