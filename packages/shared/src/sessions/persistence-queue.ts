import { open, rename, unlink } from 'fs/promises'
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync, type BigIntStats } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, getSessionPath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'
import { writeSessionJsonlTemp } from './session-jsonl-writer.js'
import { validateSessionId } from './validation.js'

interface PendingWrite {
  data: StoredSession
  /** Canonical destination captured at enqueue, immune to symlink retargeting. */
  workspaceRootPath: string
  /** Physical root proof checked again when the debounced write actually runs. */
  persistenceRootIdentity?: SessionPersistenceRootIdentity
  timer: ReturnType<typeof setTimeout>
  revision: number
  durable: boolean
}

interface SessionPersistenceIdentity {
  sessionId: string
  normalizedSessionId: string
  workspaceRootPath: string
  caseInsensitive: boolean
  sessionsDevice?: string
  sessionsInode?: string
  sessionDevice?: string
  sessionInode?: string
}

const canonicalWorkspaceRoots = new Map<string, string>()
const caseInsensitiveSessionsDirectories = new Map<string, boolean>()

export interface SessionPersistenceRootIdentity {
  workspaceRootPath: string
  device?: string
  inode?: string
  /** Physical `sessions/` object, bound as soon as it exists. */
  sessionsDevice?: string
  sessionsInode?: string
}

export class SessionPersistenceRootIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionPersistenceRootIdentityError'
  }
}

function physicalDirectoryStats(path: string, label: string): BigIntStats {
  let directory: BigIntStats
  try {
    directory = lstatSync(path, { bigint: true })
  } catch {
    throw new SessionPersistenceRootIdentityError(`${label} is unavailable: ${path}`)
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new SessionPersistenceRootIdentityError(`${label} is not a physical directory: ${path}`)
  }
  return directory
}

function optionalPhysicalDirectoryStats(path: string, label: string): BigIntStats | undefined {
  try {
    const directory = lstatSync(path, { bigint: true })
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new SessionPersistenceRootIdentityError(`${label} is not a physical directory: ${path}`)
    }
    return directory
  } catch (error) {
    if (error instanceof SessionPersistenceRootIdentityError) throw error
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined
    throw new SessionPersistenceRootIdentityError(`${label} could not be inspected: ${path}`)
  }
}

function assertDirectoryIdentityPair(
  path: string,
  label: string,
  directory: BigIntStats | undefined,
  device: string | undefined,
  inode: string | undefined,
): void {
  if ((device === undefined) !== (inode === undefined)) {
    throw new SessionPersistenceRootIdentityError(`${label} identity is incomplete: ${path}`)
  }
  if (device === undefined) return
  if (!directory
    || directory.dev.toString() !== device
    || directory.ino.toString() !== inode) {
    throw new SessionPersistenceRootIdentityError(`${label} was replaced: ${path}`)
  }
}

function bindSessionContainerIdentity(
  identity: SessionPersistenceRootIdentity,
  canonicalRoot: string,
): BigIntStats {
  const sessionsPath = join(canonicalRoot, 'sessions')
  const sessions = physicalDirectoryStats(sessionsPath, 'Session persistence directory')
  assertDirectoryIdentityPair(
    sessionsPath,
    'Session persistence directory',
    sessions,
    identity.sessionsDevice,
    identity.sessionsInode,
  )
  identity.sessionsDevice ??= sessions.dev.toString()
  identity.sessionsInode ??= sessions.ino.toString()
  return sessions
}

function canonicalWorkspaceRoot(workspaceRootPath: string): string {
  const absolute = resolve(workspaceRootPath)
  try {
    // Refresh live roots on every identity operation. A workspace symlink can
    // be retargeted during a long-running process; a lexical cache hit must not
    // keep sending its new target through the old persistence chain.
    const canonical = realpathSync.native(absolute)
    canonicalWorkspaceRoots.set(absolute, canonical)
    return canonical
  } catch {
    // Preserve the last proven target after deletion so late callbacks still
    // meet its tombstone. Never cache an unproven lexical fallback: once a new
    // root exists, the next operation must discover it.
    return canonicalWorkspaceRoots.get(absolute) ?? absolute
  }
}

/**
 * Resolve the deepest existing ancestor and append the still-missing suffix.
 * This preserves physical aliases such as macOS `/tmp` -> `/private/tmp`
 * even when the workspace directory itself has not been created yet.
 */
function canonicalMissingWorkspaceRoot(workspaceRootPath: string): string {
  let cursor = resolve(workspaceRootPath)
  const suffix: string[] = []
  while (true) {
    try {
      return join(realpathSync.native(cursor), ...suffix)
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) return resolve(workspaceRootPath)
      suffix.unshift(basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Capture the physical workspace root that owns a managed session.
 *
 * The returned path is intentionally stable: callers keep it for the lifetime
 * of the ManagedSession so a later retarget of a lexical workspace symlink
 * cannot redirect that session's writes, retirement fence, or deletion to a
 * different workspace.
 */
export function captureSessionPersistenceRootPath(workspaceRootPath: string): string {
  return canonicalWorkspaceRoot(workspaceRootPath)
}

/** Capture the directory object, not only its pathname. */
export function captureSessionPersistenceRootIdentity(
  workspaceRootPath: string,
): SessionPersistenceRootIdentity {
  const canonicalRoot = canonicalWorkspaceRoot(workspaceRootPath)
  try {
    const root = lstatSync(canonicalRoot, { bigint: true })
    if (!root.isDirectory() || root.isSymbolicLink()) {
      throw new SessionPersistenceRootIdentityError(
        `Session persistence root is not a physical directory: ${canonicalRoot}`,
      )
    }
    const sessionsPath = join(canonicalRoot, 'sessions')
    const sessions = optionalPhysicalDirectoryStats(
      sessionsPath,
      'Session persistence directory',
    )
    return {
      workspaceRootPath: canonicalRoot,
      device: root.dev.toString(),
      inode: root.ino.toString(),
      sessionsDevice: sessions?.dev.toString(),
      sessionsInode: sessions?.ino.toString(),
    }
  } catch (error) {
    if (error instanceof SessionPersistenceRootIdentityError) throw error
    if (!isErrnoException(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      throw new SessionPersistenceRootIdentityError(
        `Session persistence root identity could not be captured: ${canonicalRoot}`,
      )
    }
    // Some unit/in-memory session fixtures are created before their workspace
    // directory. They retain stable pathname semantics but cannot claim an
    // inode proof that did not exist at capture time.
    return { workspaceRootPath: canonicalMissingWorkspaceRoot(canonicalRoot) }
  }
}

/** Fail closed if the captured physical workspace directory was replaced. */
export function assertSessionPersistenceRootIdentity(
  identity: SessionPersistenceRootIdentity,
): string {
  const hasPhysicalProof = identity.device !== undefined || identity.inode !== undefined
  if ((identity.device === undefined) !== (identity.inode === undefined)) {
    throw new SessionPersistenceRootIdentityError(
      `Session persistence root identity is incomplete: ${identity.workspaceRootPath}`,
    )
  }
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync.native(resolve(identity.workspaceRootPath))
  } catch {
    // A few construction/test paths intentionally create the workspace on the
    // first persistence operation. They cannot be protected by an inode until
    // that directory exists, but they must retain the canonical parent path
    // captured above and may not follow a later symlink target.
    if (!hasPhysicalProof) return identity.workspaceRootPath
    throw new SessionPersistenceRootIdentityError(
      `Session persistence root is unavailable: ${identity.workspaceRootPath}`,
    )
  }
  if (canonicalRoot !== identity.workspaceRootPath) {
    throw new SessionPersistenceRootIdentityError(
      `Session persistence root target changed: ${identity.workspaceRootPath}`,
    )
  }
  let root: BigIntStats
  try {
    root = lstatSync(canonicalRoot, { bigint: true })
  } catch {
    throw new SessionPersistenceRootIdentityError(
      `Session persistence root is unavailable: ${identity.workspaceRootPath}`,
    )
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new SessionPersistenceRootIdentityError(
      `Session persistence root is no longer a physical directory: ${identity.workspaceRootPath}`,
    )
  }
  if ((identity.device !== undefined && root.dev.toString() !== identity.device)
    || (identity.inode !== undefined && root.ino.toString() !== identity.inode)) {
    throw new SessionPersistenceRootIdentityError(
      `Session persistence root was replaced: ${identity.workspaceRootPath}`,
    )
  }
  const sessionsPath = join(canonicalRoot, 'sessions')
  const sessions = optionalPhysicalDirectoryStats(
    sessionsPath,
    'Session persistence directory',
  )
  assertDirectoryIdentityPair(
    sessionsPath,
    'Session persistence directory',
    sessions,
    identity.sessionsDevice,
    identity.sessionsInode,
  )
  return canonicalRoot
}

function workspaceRootIsCaseInsensitive(workspaceRootPath: string): boolean {
  const canonical = canonicalWorkspaceRoot(workspaceRootPath)
  let sessionsDir: string
  try {
    const candidate = join(canonical, 'sessions')
    if (!optionalPhysicalDirectoryStats(candidate, 'Session persistence directory')) return false
    sessionsDir = realpathSync.native(candidate)
  } catch (error) {
    if (error instanceof SessionPersistenceRootIdentityError) throw error
    // Identity registration prepares the sessions directory first. Read-only
    // lookups may reach this path after a workspace was removed; without an
    // existing directory there is no filesystem behavior to infer safely.
    return false
  }

  const cached = caseInsensitiveSessionsDirectories.get(sessionsDir)
  if (cached !== undefined) return cached

  // Probe the exact directory in which session IDs are resolved. Looking at a
  // parent path is insufficient on filesystems that support per-directory case
  // sensitivity, and can be spoofed by an alternate-case symlink. A random,
  // exclusive, owner-only file makes the probe collision-safe and is removed
  // synchronously before registration returns.
  const probeName = `.persistence-case-${randomUUID()}-a`
  const probePath = join(sessionsDir, probeName)
  const alternatePath = join(sessionsDir, `${probeName.slice(0, -1)}A`)
  let descriptor: number | undefined
  let caseInsensitive = false
  let determined = false
  try {
    descriptor = openSync(probePath, 'wx', 0o600)
    const probeStat = fstatSync(descriptor)
    try {
      const alternateStat = lstatSync(alternatePath)
      caseInsensitive = probeStat.dev === alternateStat.dev && probeStat.ino === alternateStat.ino
      determined = true
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        // The alternate spelling not resolving proves this directory uses
        // case-sensitive lookup for session names.
        determined = true
      }
    }
  } catch {
    // If the probe cannot be created, preserve distinct IDs instead of
    // collapsing them without evidence. A later registration can retry.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* best-effort close */ }
      try { unlinkSync(probePath) } catch { /* best-effort probe cleanup */ }
    }
  }
  if (determined) caseInsensitiveSessionsDirectories.set(sessionsDir, caseInsensitive)
  return determined ? caseInsensitive : false
}

function rawIdentityAlias(workspaceRootPath: string, sessionId: string): string {
  return JSON.stringify([resolve(workspaceRootPath), sessionId])
}

function canonicalCaseFoldedIdentityAlias(canonicalRoot: string, sessionId: string): string {
  // The session directory may fold names, but the workspace's canonical path
  // remains part of the identity. Lower-casing it would merge distinct roots
  // such as /work/Foo and /work/foo on a case-sensitive parent filesystem.
  return JSON.stringify([canonicalRoot, sessionId.toLowerCase()])
}

function lexicalCaseFoldedIdentityAlias(workspaceRootPath: string, sessionId: string): string {
  // This is only a fallback for a root which no longer exists. Values are sets,
  // so two real roots whose spellings differ only by case can never overwrite
  // or silently alias one another.
  return JSON.stringify([resolve(workspaceRootPath).toLowerCase(), sessionId.toLowerCase()])
}

function existingCanonicalWorkspaceRoot(workspaceRootPath: string): string | undefined {
  try {
    return realpathSync.native(resolve(workspaceRootPath))
  } catch {
    return undefined
  }
}

interface SessionPersistenceQueueTestHooks {
  beforeWrite?: (sessionId: string) => Promise<void> | void
  afterTempWrite?: (sessionId: string) => Promise<void> | void
  beforeFileSync?: (sessionId: string) => Promise<void> | void
  afterFileSync?: (sessionId: string) => Promise<void> | void
  afterFinalFileSync?: (sessionId: string) => Promise<void> | void
  afterDirectorySync?: (sessionId: string) => Promise<void> | void
  /** Lets cross-platform tests model a case-folded sessions directory. */
  caseInsensitiveWorkspaceRoot?: (workspaceRootPath: string) => boolean
}

const activeSessionWritePaths = new Map<string, number>()

function canonicalSessionPersistenceWritePath(filePath: string): string {
  const absolute = resolve(filePath)
  try {
    // The final JSONL file may not exist on its first write, but its session
    // directory does. Canonicalizing that parent collapses lexical and symlink
    // workspace aliases without depending on the destination file itself.
    return join(realpathSync.native(dirname(absolute)), basename(absolute))
  } catch {
    // Preserve the old lexical behavior when a caller probes a path whose
    // parent no longer exists. Active writers record the canonical key once
    // and pass that same key to endSessionPersistenceWrite().
    return absolute
  }
}

function beginSessionPersistenceWrite(filePath: string): string {
  const key = canonicalSessionPersistenceWritePath(filePath)
  activeSessionWritePaths.set(key, (activeSessionWritePaths.get(key) ?? 0) + 1)
  return key
}

function endSessionPersistenceWrite(key: string): void {
  const remaining = (activeSessionWritePaths.get(key) ?? 1) - 1
  if (remaining > 0) activeSessionWritePaths.set(key, remaining)
  else activeSessionWritePaths.delete(key)
}

export function isSessionPersistenceWriteInProgress(filePath: string): boolean {
  return activeSessionWritePaths.has(canonicalSessionPersistenceWritePath(filePath))
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

async function syncPath(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Commit one already-written temp snapshot to stable storage. This helper must
 * run inside the per-session persistence chain: syncing a pathname after that
 * chain is released can fsync an inode replaced by a concurrent enqueue.
 */
async function commitDurableSessionFile(
  sessionId: string,
  tmpFile: string,
  finalFile: string,
  testHooks?: SessionPersistenceQueueTestHooks,
  assertDestination?: () => void,
): Promise<void> {
  await testHooks?.beforeFileSync?.(sessionId)
  assertDestination?.()
  await syncPath(tmpFile)
  await testHooks?.afterFileSync?.(sessionId)
  assertDestination?.()
  await replaceFileAtomically(tmpFile, finalFile)
  assertDestination?.()
  await syncPath(finalFile)
  await testHooks?.afterFinalFileSync?.(sessionId)
  assertDestination?.()
  // Windows does not expose a portable directory handle through Node. The
  // file FlushFileBuffers above remains mandatory there; POSIX additionally
  // persists the rename itself by syncing the parent directory.
  if (process.platform !== 'win32') {
    await syncPath(dirname(finalFile))
    await testHooks?.afterDirectorySync?.(sessionId)
    assertDestination?.()
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
  private identities = new Map<string, SessionPersistenceIdentity>()
  /** Exact lexical paths keep their identity even after the workspace is gone. */
  private identityAliases = new Map<string, string>()
  /** Session-name folding is scoped to one exact canonical workspace root. */
  private caseInsensitiveCanonicalAliases = new Map<string, string>()
  /**
   * A removed case-insensitive root can only be found by lexical spelling.
   * Keep every candidate instead of allowing a lower-cased path to overwrite a
   * distinct root; ambiguous missing-root lookups fail closed.
   */
  private caseInsensitiveFallbackAliases = new Map<string, Set<string>>()
  /**
   * A deleted session must never be recreated by a late debounced write or by
   * an asynchronous callback that still holds its old snapshot. Retirement is
   * therefore a tombstone, not just a one-shot cancellation. It is kept for
   * the lifetime of this queue; a failed deletion may explicitly reactivate
   * the session after every in-flight writer has drained.
   */
  private retired = new Set<string>()
  private activeWrites = 0
  private waitingWriters: Array<() => void> = []
  private lastWrittenHeaderSignature = new Map<string, string>()
  private nextRevision = 0
  private lastDurableRevision = new Map<string, number>()
  private debounceMs: number
  private testHooks?: SessionPersistenceQueueTestHooks

  constructor(debounceMs = 500, testHooks?: SessionPersistenceQueueTestHooks) {
    this.debounceMs = debounceMs
    this.testHooks = testHooks
  }

  private lookupIdentityAlias(workspaceRootPath: string, sessionId: string): string | undefined {
    const exact = this.identityAliases.get(rawIdentityAlias(workspaceRootPath, sessionId))
    const existingCanonicalRoot = existingCanonicalWorkspaceRoot(workspaceRootPath)
    if (exact) {
      const exactIdentity = this.identities.get(exact)
      // Missing roots use their last proven lexical alias. Live roots must
      // still resolve to the same target; otherwise this alias was retargeted.
      if (!existingCanonicalRoot || exactIdentity?.workspaceRootPath === existingCanonicalRoot) {
        return exact
      }
    }

    const canonicalRoot = existingCanonicalRoot ?? canonicalWorkspaceRoot(workspaceRootPath)
    const canonicalAlias = this.caseInsensitiveCanonicalAliases.get(
      canonicalCaseFoldedIdentityAlias(canonicalRoot, sessionId),
    )
    if (canonicalAlias) return canonicalAlias

    // A live root with a different canonical path is a different workspace,
    // even if its lexical spelling differs only by case from a known root.
    if (existingCanonicalRoot) return undefined

    const candidates = this.caseInsensitiveFallbackAliases.get(
      lexicalCaseFoldedIdentityAlias(workspaceRootPath, sessionId),
    )
    if (!candidates || candidates.size === 0) return undefined
    if (candidates.size === 1) return candidates.values().next().value

    const canonicalMatches = [...candidates].filter(key => (
      this.identities.get(key)?.workspaceRootPath === canonicalRoot
    ))
    if (canonicalMatches.length === 1) return canonicalMatches[0]
    throw new Error(`Ambiguous case-insensitive workspace persistence identity: ${sessionId}`)
  }

  private recordIdentityAliases(
    workspaceRootPath: string,
    canonicalRoot: string,
    sessionId: string,
    key: string,
    caseInsensitive: boolean,
  ): void {
    this.identityAliases.set(rawIdentityAlias(workspaceRootPath, sessionId), key)
    this.identityAliases.set(rawIdentityAlias(canonicalRoot, sessionId), key)
    if (caseInsensitive) {
      this.caseInsensitiveCanonicalAliases.set(
        canonicalCaseFoldedIdentityAlias(canonicalRoot, sessionId),
        key,
      )
      for (const aliasRoot of new Set([workspaceRootPath, canonicalRoot])) {
        const alias = lexicalCaseFoldedIdentityAlias(aliasRoot, sessionId)
        const candidates = this.caseInsensitiveFallbackAliases.get(alias) ?? new Set<string>()
        candidates.add(key)
        this.caseInsensitiveFallbackAliases.set(alias, candidates)
      }
    }
  }

  private workspaceRootIsCaseInsensitive(workspaceRootPath: string): boolean {
    return this.testHooks?.caseInsensitiveWorkspaceRoot?.(workspaceRootPath)
      ?? workspaceRootIsCaseInsensitive(workspaceRootPath)
  }

  private assertOrBindPersistenceHierarchy(
    key: string,
    workspaceRootPath: string,
    sessionId: string,
    persistenceRootIdentity: SessionPersistenceRootIdentity | undefined,
    options: { bind: boolean; requireSession: boolean },
  ): void {
    const registered = this.identities.get(key)
    if (!registered || registered.workspaceRootPath !== workspaceRootPath) {
      throw new SessionPersistenceRootIdentityError(
        `Session persistence identity is unavailable: ${sessionId}`,
      )
    }

    const sessionsPath = join(workspaceRootPath, 'sessions')
    const sessions = physicalDirectoryStats(sessionsPath, 'Session persistence directory')
    assertDirectoryIdentityPair(
      sessionsPath,
      'Session persistence directory',
      sessions,
      registered.sessionsDevice,
      registered.sessionsInode,
    )
    if (options.bind) {
      registered.sessionsDevice ??= sessions.dev.toString()
      registered.sessionsInode ??= sessions.ino.toString()
      if (persistenceRootIdentity) {
        bindSessionContainerIdentity(persistenceRootIdentity, workspaceRootPath)
      }
    }

    const sessionPath = getSessionPath(workspaceRootPath, sessionId)
    const session = optionalPhysicalDirectoryStats(sessionPath, `Session directory for ${sessionId}`)
    assertDirectoryIdentityPair(
      sessionPath,
      `Session directory for ${sessionId}`,
      session,
      registered.sessionDevice,
      registered.sessionInode,
    )
    if (!session) {
      if (options.requireSession) {
        throw new SessionPersistenceRootIdentityError(
          `Session directory is unavailable: ${sessionPath}`,
        )
      }
      return
    }
    if (options.bind) {
      registered.sessionDevice ??= session.dev.toString()
      registered.sessionInode ??= session.ino.toString()
    }
  }

  private registerIdentity(workspaceRootPath: string, sessionId: string): string {
    validateSessionId(sessionId)
    const registeredAlias = this.lookupIdentityAlias(workspaceRootPath, sessionId)
    if (registeredAlias) return registeredAlias

    const canonicalRoot = canonicalWorkspaceRoot(workspaceRootPath)
    const caseInsensitive = this.workspaceRootIsCaseInsensitive(canonicalRoot)
    const normalizedSessionId = caseInsensitive ? sessionId.toLowerCase() : sessionId
    const key = JSON.stringify([canonicalRoot, normalizedSessionId])
    this.identities.set(key, {
      workspaceRootPath: canonicalRoot,
      sessionId,
      normalizedSessionId,
      caseInsensitive,
    })
    this.recordIdentityAliases(workspaceRootPath, canonicalRoot, sessionId, key, caseInsensitive)
    return key
  }

  private resolveIdentityKey(sessionId: string, workspaceRootPath?: string): string | undefined {
    if (workspaceRootPath !== undefined) {
      const registeredAlias = this.lookupIdentityAlias(workspaceRootPath, sessionId)
      if (registeredAlias) return registeredAlias
      const canonicalRoot = canonicalWorkspaceRoot(workspaceRootPath)
      const caseInsensitive = this.workspaceRootIsCaseInsensitive(canonicalRoot)
      return JSON.stringify([
        canonicalRoot,
        caseInsensitive ? sessionId.toLowerCase() : sessionId,
      ])
    }
    const matches = [...this.identities.entries()]
      .filter(([, identity]) => identity.normalizedSessionId
        === (identity.caseInsensitive ? sessionId.toLowerCase() : sessionId))
      .map(([key]) => key)
    if (matches.length > 1) {
      throw new Error(`Ambiguous session persistence identity; workspace root is required: ${sessionId}`)
    }
    return matches[0]
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(
    session: StoredSession,
    persistenceRootPath: string = session.workspaceRootPath,
    persistenceRootIdentity?: SessionPersistenceRootIdentity,
  ): number {
    if (persistenceRootIdentity) {
      persistenceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity)
    }
    // Check registered aliases before touching disk. Once deletion tombstones a
    // session, a late callback using the old root must not recreate even the
    // workspace/sessions directory after it has been removed.
    const registeredAlias = this.lookupIdentityAlias(persistenceRootPath, session.id)
    if (registeredAlias && this.retired.has(registeredAlias)) {
      throw new Error(`Session persistence is retired: ${session.id}`)
    }

    // Establish the real lookup directory before deriving identity. Otherwise
    // a root first seen while absent can be keyed case-sensitively, then retire
    // under a different key once its first writer creates the directory.
    ensureSessionsDir(persistenceRootPath)
    if (persistenceRootIdentity) {
      // Bind path-only identities as soon as their workspace is created. The
      // ManagedSession and queued write share this object, so every later
      // operation gains the same device/inode replacement fence.
      const verifiedRoot = assertSessionPersistenceRootIdentity(persistenceRootIdentity)
      const root = lstatSync(verifiedRoot, { bigint: true })
      persistenceRootIdentity.device ??= root.dev.toString()
      persistenceRootIdentity.inode ??= root.ino.toString()
    }
    const key = this.registerIdentity(persistenceRootPath, session.id)
    if (this.retired.has(key)) {
      throw new Error(`Session persistence is retired: ${session.id}`)
    }
    const canonicalPersistenceRootPath = this.identities.get(key)?.workspaceRootPath
      ?? canonicalWorkspaceRoot(persistenceRootPath)
    this.assertOrBindPersistenceHierarchy(
      key,
      canonicalPersistenceRootPath,
      session.id,
      persistenceRootIdentity,
      { bind: true, requireSession: false },
    )
    const existing = this.pending.get(key)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const revision = ++this.nextRevision

    const timer = setTimeout(() => {
      // Debounced background writes have no caller to receive a rejection;
      // `write` already logs the failure. Explicit flush callers still await
      // and receive the same rejection from their own queueWrite promise.
      void this.queueWrite(key).catch(() => {})
    }, this.debounceMs)

    this.pending.set(key, {
      data: session,
      workspaceRootPath: canonicalPersistenceRootPath,
      persistenceRootIdentity: persistenceRootIdentity ?? existing?.persistenceRootIdentity,
      timer,
      revision,
      // Once a caller has requested a durable barrier, coalescing may advance
      // the snapshot but may not silently weaken that barrier.
      durable: existing?.durable ?? false,
    })
    return revision
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(key: string): Promise<void> {
    const entry = this.pending.get(key)
    if (!entry) return

    this.pending.delete(key)
    let filePath: string | undefined
    let activeWriteKey: string | undefined
    const previousHeaderSignature = this.lastWrittenHeaderSignature.get(key)
    const hadPreviousHeaderSignature = this.lastWrittenHeaderSignature.has(key)
    let headerSignatureUpdated = false

    try {
      const { data, workspaceRootPath, persistenceRootIdentity } = entry
      let requireSessionDirectory = false
      const assertDestination = () => {
        if (persistenceRootIdentity) {
          const verifiedRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity)
          if (verifiedRootPath !== workspaceRootPath) {
            throw new SessionPersistenceRootIdentityError(
              `Session persistence destination changed before write: ${data.id}`,
            )
          }
        }
        this.assertOrBindPersistenceHierarchy(
          key,
          workspaceRootPath,
          data.id,
          persistenceRootIdentity,
          { bind: false, requireSession: requireSessionDirectory },
        )
      }
      await this.testHooks?.beforeWrite?.(data.id)
      assertDestination()
      ensureSessionsDir(workspaceRootPath)
      ensureSessionDir(workspaceRootPath, data.id)
      this.assertOrBindPersistenceHierarchy(
        key,
        workspaceRootPath,
        data.id,
        persistenceRootIdentity,
        { bind: true, requireSession: true },
      )
      requireSessionDirectory = true
      assertDestination()

      filePath = getSessionFilePath(workspaceRootPath, data.id)
      activeWriteKey = beginSessionPersistenceWrite(filePath)

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
      const previousSig = this.lastWrittenHeaderSignature.get(key)
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
        debug(`[PersistenceQueue] Session ${data.id} metadata mismatch detected (${mode}${baseline})`)
      }

      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(key, finalSignature)
      headerSignatureUpdated = true

      const tmpFile = filePath + '.tmp'
      assertDestination()
      await writeSessionJsonlTemp(tmpFile, header, storageSession.messages, sessionDir)
      await this.testHooks?.afterTempWrite?.(data.id)
      assertDestination()
      if (entry.durable) {
        await commitDurableSessionFile(
          data.id,
          tmpFile,
          filePath,
          this.testHooks,
          assertDestination,
        )
        this.lastDurableRevision.set(key, entry.revision)
      } else {
        assertDestination()
        await replaceFileAtomically(tmpFile, filePath)
        assertDestination()
      }
      debug(`[PersistenceQueue] Wrote session ${data.id}`)
    } catch (error) {
      if (headerSignatureUpdated) {
        if (hadPreviousHeaderSignature) this.lastWrittenHeaderSignature.set(key, previousHeaderSignature!)
        else this.lastWrittenHeaderSignature.delete(key)
      }
      const identity = this.identities.get(key)
      console.error(`[PersistenceQueue] Failed to write session ${identity?.sessionId ?? '<unknown>'}:`, error)
      throw error
    } finally {
      if (activeWriteKey) endSessionPersistenceWrite(activeWriteKey)
    }
  }

  /** Bound allocations across sessions, including flushAll during restart/quit. */
  private async writeWithGlobalLimit(key: string): Promise<void> {
    if (this.activeWrites < 2) {
      this.activeWrites++
    } else {
      await new Promise<void>(resolve => { this.waitingWriters.push(resolve) })
    }
    try {
      // Read pending only after admission so newer snapshots can coalesce and
      // cancellation can still remove work while both slots are occupied.
      await this.write(key)
    } finally {
      const next = this.waitingWriters.shift()
      if (next) next() // Transfer this slot without admitting a third writer.
      else this.activeWrites--
    }
  }

  /**
   * Append a write to the per-session promise chain. Debounce timers and
   * explicit flushes must both enter through this method; otherwise a timer
   * write can race a flush and both processes can rename the same .tmp file.
   */
  private queueWrite(key: string): Promise<void> {
    const previous = this.writeInProgress.get(key) ?? Promise.resolve()
    const writePromise = previous
      .catch(() => { /* keep the queue usable after an unexpected rejection */ })
      .then(() => this.writeWithGlobalLimit(key))

    this.writeInProgress.set(key, writePromise)
    const clearCompletedWrite = () => {
      if (this.writeInProgress.get(key) === writePromise) {
        this.writeInProgress.delete(key)
      }
    }
    void writePromise.then(clearCompletedWrite, clearCompletedWrite)
    return writePromise
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string, workspaceRootPath?: string): Promise<void> {
    const key = this.resolveIdentityKey(sessionId, workspaceRootPath)
    if (!key) return
    await this.flushKey(key)
  }

  private async flushKey(key: string): Promise<void> {
    const entry = this.pending.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      await this.queueWrite(key)
      return
    }

    const inProgress = this.writeInProgress.get(key)
    if (inProgress) {
      await inProgress
      // An enqueue may have arrived while the preceding write was running.
      if (this.pending.has(key)) await this.flushKey(key)
    }
  }

  /**
   * Flush the currently queued snapshot with a power-loss durability barrier.
   * The exact pending revision (or a newer coalesced revision) is fsynced before
   * this resolves. Calling without a pending snapshot is an error: an earlier
   * ordinary flush cannot be retroactively claimed as durable.
   */
  async flushDurable(sessionId: string, workspaceRootPath?: string): Promise<void> {
    const key = this.resolveIdentityKey(sessionId, workspaceRootPath)
    const initial = key ? this.pending.get(key) : undefined
    if (!initial) {
      throw new Error(`No pending session snapshot is available for durable flush: ${sessionId}`)
    }
    let requiredRevision = initial.revision
    initial.durable = true
    clearTimeout(initial.timer)
    while (true) {
      await this.queueWrite(key!)
      // An enqueue that raced after write() claimed the preceding snapshot must
      // also cross the barrier before the provider-visible operation can start.
      const pending = this.pending.get(key!)
      if (!pending) break
      requiredRevision = pending.revision
      pending.durable = true
      clearTimeout(pending.timer)
    }
    if ((this.lastDurableRevision.get(key!) ?? 0) < requiredRevision) {
      throw new Error(`Session durability revision ${requiredRevision} was not committed: ${sessionId}`)
    }
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string, workspaceRootPath?: string): void {
    const key = this.resolveIdentityKey(sessionId, workspaceRootPath)
    if (!key) return
    this.cancelKey(key)
  }

  private cancelKey(key: string): void {
    const entry = this.pending.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(key)
      debug(`[PersistenceQueue] Cancelled pending write for session ${entry.data.id}`)
    }
    this.lastWrittenHeaderSignature.delete(key)
    this.lastDurableRevision.delete(key)
  }

  /**
   * Permanently fence a session from new writes and wait for every write that
   * was already admitted to the serialized queue. Callers may safely remove
   * the session directory only after this resolves.
   *
   * Write failures are deliberately absorbed here: `write()` already reports
   * them, and deletion needs the writer to be quiescent rather than successful.
   */
  async retire(sessionId: string, workspaceRootPath?: string): Promise<void> {
    const key = workspaceRootPath !== undefined
      ? this.registerIdentity(workspaceRootPath, sessionId)
      : this.resolveIdentityKey(sessionId)
    if (!key) throw new Error(`Cannot retire unknown session persistence identity: ${sessionId}`)
    this.retired.add(key)

    while (true) {
      this.cancelKey(key)
      const inProgress = this.writeInProgress.get(key)
      if (!inProgress) {
        // A debounce callback that was already queued can enter queueWrite in
        // the same microtask turn. Yield once, then prove the maps are still
        // empty while enqueue remains fenced by the tombstone above.
        await Promise.resolve()
        if (!this.writeInProgress.has(key) && !this.pending.has(key)) {
          this.cancelKey(key)
          return
        }
        continue
      }
      await inProgress.catch(() => undefined)
    }
  }

  /** Restore persistence only when a deletion failed before it committed. */
  reactivate(sessionId: string, workspaceRootPath?: string): void {
    const key = this.resolveIdentityKey(sessionId, workspaceRootPath)
    if (!key) return
    if (this.writeInProgress.has(key) || this.pending.has(key)) {
      throw new Error(`Cannot reactivate session persistence while writes are active: ${sessionId}`)
    }
    const identity = this.identities.get(key)
    if (!identity) {
      throw new Error(`Cannot reactivate unknown session persistence identity: ${sessionId}`)
    }
    this.assertOrBindPersistenceHierarchy(
      key,
      identity.workspaceRootPath,
      identity.sessionId,
      undefined,
      { bind: true, requireSession: identity.sessionDevice !== undefined },
    )
    this.retired.delete(key)
  }

  isRetired(sessionId: string, workspaceRootPath?: string): boolean {
    const key = this.resolveIdentityKey(sessionId, workspaceRootPath)
    return key ? this.retired.has(key) : false
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const failures: unknown[] = []
    while (true) {
      const keys = [...new Set([
        ...this.pending.keys(),
        ...this.writeInProgress.keys(),
      ])]
      if (keys.length === 0) {
        // Let already-queued debounce callbacks enter queueWrite before declaring
        // the barrier stable. New work admitted during an earlier pass is then
        // included in the next pass rather than being left for process exit.
        await Promise.resolve()
        if (this.pending.size === 0 && this.writeInProgress.size === 0) break
        continue
      }

      const results = await Promise.allSettled(keys.map(key => this.flushKey(key)))
      for (const result of results) {
        if (result.status === 'rejected') failures.push(result.reason)
      }
    }

    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Multiple session persistence writes failed while flushing')
    }
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string, workspaceRootPath?: string): boolean {
    const key = this.resolveIdentityKey(sessionId, workspaceRootPath)
    return key ? this.pending.has(key) : false
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string, workspaceRootPath?: string): string | undefined {
    const key = this.resolveIdentityKey(sessionId, workspaceRootPath)
    return key ? this.lastWrittenHeaderSignature.get(key) : undefined
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
