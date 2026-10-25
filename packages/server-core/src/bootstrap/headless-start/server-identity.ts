import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { uptime as osUptime } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR } from "@craft-agent/shared/config/paths";
import type { PlatformServices } from "../../runtime/platform";

// ---------------------------------------------------------------------------
// Token entropy validation
// ---------------------------------------------------------------------------

const MIN_TOKEN_LENGTH = 16

/**
 * Reject tokens that are trivially weak. Runs at startup before the server
 * accepts connections so a bad token never reaches the wire.
 */
export function validateTokenEntropy(token: string): { ok: boolean; warning?: string; error?: string } {
  if (token.length < MIN_TOKEN_LENGTH) {
    return { ok: false, error: `Token too short (${token.length} chars, minimum ${MIN_TOKEN_LENGTH}). Use a cryptographically random value.` }
  }

  // Reject single-character repeats ("aaaaaaaaaaaaaaaa")
  if (new Set(token).size === 1) {
    return { ok: false, error: 'Token has zero entropy (single repeated character).' }
  }

  // Warn (but allow) low-uniqueness tokens — fewer than 8 unique characters
  // in a 16+ char token suggests a pattern like "abcabcabc..."
  const uniqueChars = new Set(token).size
  if (uniqueChars < 8) {
    return { ok: true, warning: `Token has low entropy (${uniqueChars} unique characters). Consider using a stronger token.` }
  }

  return { ok: true }
}

/**
 * Generate a cryptographically random token suitable for server auth.
 * Returns a 48-character hex string (192 bits of entropy).
 */
export function generateServerToken(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Startup lock file
// ---------------------------------------------------------------------------

/**
 * The application data root may be shared by compatible desktop distributions.
 * Keep the runtime server lock independently configurable so those apps can run
 * side-by-side without duplicating workspaces, sessions or credentials.
 */
function getLockFile(): string {
  return join(process.env.CRAFT_SERVER_LOCK_DIR || CONFIG_DIR, '.server.lock')
}

interface LockPayload {
  pid: number
  startedAt: number
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Parse the lock file content. Supports both the new JSON format
 * (`{pid, startedAt}`) and the legacy plain-PID format for backwards
 * compatibility during upgrades.
 */
function parseLockContent(raw: string): LockPayload | null {
  const trimmed = raw.trim()
  // Try JSON first (new format)
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN
      const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
      if (!isNaN(pid)) return { pid, startedAt }
    } catch { /* fall through to legacy parse */ }
  }
  // Legacy format: plain PID number
  const pid = parseInt(trimmed, 10)
  if (!isNaN(pid)) return { pid, startedAt: 0 }
  return null
}

/**
 * Returns true if the lock's `startedAt` timestamp predates the most recent
 * system boot. This means the lock was written in a previous boot cycle and
 * the PID has been reused by an unrelated process.
 */
function isLockFromPreviousBoot(startedAt: number): boolean {
  if (startedAt <= 0) return false // legacy lock without timestamp — can't tell
  const bootTime = Date.now() - osUptime() * 1000
  return startedAt < bootTime
}

export function acquireServerLock(logger: PlatformServices['logger']): void {
  const lockFile = getLockFile()
  if (existsSync(lockFile)) {
    try {
      const content = readFileSync(lockFile, 'utf-8')
      const lock = parseLockContent(content)

      if (lock) {
        // In Docker, PID 1 is reused across container restarts.
        // If the lock holds our own PID, it's stale from a previous run.
        if (lock.pid === process.pid) {
          logger.warn(`[bootstrap] Lock file holds current PID ${lock.pid} (stale from previous container lifecycle), overwriting`)
        } else if (isProcessAlive(lock.pid)) {
          // PID is alive — but is it actually from a previous boot?
          // If the lock was written before the current boot, the OS has
          // recycled the PID and the process is unrelated.
          if (isLockFromPreviousBoot(lock.startedAt)) {
            logger.warn(`[bootstrap] Lock PID ${lock.pid} is alive but lock predates current boot (stale due to PID reuse), overwriting`)
          } else {
            throw new Error(
              `Another server instance is already running (PID ${lock.pid}). ` +
              `If this is stale, delete ${lockFile} and retry. ` +
              `To run a parallel instance (e.g. for dev), set CRAFT_CONFIG_DIR to a different path.`
            )
          }
        } else {
          logger.warn(`[bootstrap] Stale lock file found (PID ${lock.pid}), overwriting`)
        }
      } else {
        logger.warn('[bootstrap] Could not parse lock file, overwriting')
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('Another server instance')) throw err
      logger.warn('[bootstrap] Could not read lock file, overwriting')
    }
  }

  const payload: LockPayload = { pid: process.pid, startedAt: Date.now() }
  writeFileSync(lockFile, JSON.stringify(payload), 'utf-8')

  // Safety net: release the lock on unexpected exits (SIGKILL, uncaught exceptions, etc.).
  // process.on('exit') only allows synchronous code — releaseServerLock is fully sync.
  process.on('exit', () => { releaseServerLock() })
}

/**
 * Remove the lock file if it belongs to the current process.
 * Exported so consumers (e.g. the Electron before-quit handler) can call it
 * directly without going through `instance.stop()`.
 */
export function releaseServerLock(): void {
  try {
    const lockFile = getLockFile()
    if (existsSync(lockFile)) {
      const lock = parseLockContent(readFileSync(lockFile, 'utf-8'))
      // Only delete if it's our lock
      if (lock && lock.pid === process.pid) {
        unlinkSync(lockFile)
      }
    }
  } catch {
    // Best-effort cleanup
  }
}
