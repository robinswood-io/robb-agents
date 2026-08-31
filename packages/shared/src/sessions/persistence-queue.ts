import { writeFile, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout>
}

interface SessionPersistenceQueueTestHooks {
  beforeWrite?: (sessionId: string) => Promise<void> | void
  afterTempWrite?: (sessionId: string) => Promise<void> | void
}

const activeSessionWritePaths = new Map<string, number>()

function beginSessionPersistenceWrite(filePath: string): void {
  activeSessionWritePaths.set(filePath, (activeSessionWritePaths.get(filePath) ?? 0) + 1)
}

function endSessionPersistenceWrite(filePath: string): void {
  const remaining = (activeSessionWritePaths.get(filePath) ?? 1) - 1
  if (remaining > 0) activeSessionWritePaths.set(filePath, remaining)
  else activeSessionWritePaths.delete(filePath)
}

export function isSessionPersistenceWriteInProgress(filePath: string): boolean {
  return activeSessionWritePaths.has(filePath)
}

interface HeaderMetadataSignature {
  name?: string
  labels?: string[]
  isFlagged?: boolean
  sessionStatus?: string
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    labels: header.labels,
    isFlagged: header.isFlagged,
    sessionStatus: header.sessionStatus,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    labels: diskHeader.labels,
    isFlagged: diskHeader.isFlagged,
    sessionStatus: diskHeader.sessionStatus,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

async function replaceFileAtomically(tmpFile: string, finalFile: string): Promise<void> {
  try {
    await rename(tmpFile, finalFile)
    return
  } catch (error) {
    // POSIX rename replaces the destination atomically. Some Windows handles can
    // reject replacement while the destination exists; keep a recoverable backup
    // instead of deleting the primary before the tmp has been promoted.
    if (!isErrnoException(error) || (error.code !== 'EEXIST' && error.code !== 'EPERM')) {
      throw error
    }
  }

  const backupFile = `${finalFile}.bak`
  try { await unlink(backupFile) } catch { /* ignore stale backup */ }

  let backupCreated = false
  try {
    await rename(finalFile, backupFile)
    backupCreated = true
  } catch {
    // Destination may not exist; continue with tmp promotion.
  }

  try {
    await rename(tmpFile, finalFile)
  } catch (error) {
    if (backupCreated) {
      try { await rename(backupFile, finalFile) } catch { /* leave backup for startup recovery */ }
    }
    throw error
  }

  if (backupCreated) {
    try { await unlink(backupFile) } catch { /* ignore stale backup cleanup */ }
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  private writeInProgress = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number
  private testHooks?: SessionPersistenceQueueTestHooks

  constructor(debounceMs = 500, testHooks?: SessionPersistenceQueueTestHooks) {
    this.debounceMs = debounceMs
    this.testHooks = testHooks
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      void this.queueWrite(session.id)
    }, this.debounceMs)

    this.pending.set(session.id, { data: session, timer })
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    this.pending.delete(sessionId)
    let filePath: string | undefined

    try {
      const { data } = entry
      await this.testHooks?.beforeWrite?.(sessionId)
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      filePath = getSessionFilePath(data.workspaceRootPath, sessionId)
      beginSessionPersistenceWrite(filePath)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
        lastUsedAt: Date.now(),
      }

      // Create JSONL content: header + messages (one per line)
      // Filter out intermediate messages - they're transient streaming status updates
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      const tmpFile = filePath + '.tmp'
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      await this.testHooks?.afterTempWrite?.(sessionId)
      await replaceFileAtomically(tmpFile, filePath)
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
    } finally {
      if (filePath) endSessionPersistenceWrite(filePath)
    }
  }

  /**
   * Append a write to the per-session promise chain. Debounce timers and
   * explicit flushes must both enter through this method; otherwise a timer
   * write can race a flush and both processes can rename the same .tmp file.
   */
  private queueWrite(sessionId: string): Promise<void> {
    const previous = this.writeInProgress.get(sessionId) ?? Promise.resolve()
    const writePromise = previous
      .catch(() => { /* keep the queue usable after an unexpected rejection */ })
      .then(() => this.write(sessionId))

    this.writeInProgress.set(sessionId, writePromise)
    void writePromise.finally(() => {
      if (this.writeInProgress.get(sessionId) === writePromise) {
        this.writeInProgress.delete(sessionId)
      }
    })
    return writePromise
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      await this.queueWrite(sessionId)
      return
    }

    const inProgress = this.writeInProgress.get(sessionId)
    if (inProgress) {
      await inProgress
      // An enqueue may have arrived while the preceding write was running.
      if (this.pending.has(sessionId)) await this.flush(sessionId)
    }
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = [...new Set([
      ...this.pending.keys(),
      ...this.writeInProgress.keys(),
    ])]
    await Promise.all(sessionIds.map(id => this.flush(id)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
