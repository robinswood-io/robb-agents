import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSession,
  ensureSessionDir,
  getOrCreateSessionById,
  getSessionFilePath,
  getSessionPath,
  loadSession,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'
import { archiveCompletedChatDirectory, CompletedChatArchiveError } from './completed-chat-retention'

const roots: string[] = []
const managers: SessionManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.cleanup()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('session deletion persistence retirement', () => {
  it('proves runtime disposal before commit, rejects late persistence, and makes cleanup await deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Delete race' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-delete', name: 'Delete', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      persistSession: (candidate: typeof managed) => boolean
    }
    runtime.sessions.set(managed.id, managed)

    let releaseDisposal!: () => void
    const disposalGate = new Promise<void>(resolve => { releaseDisposal = resolve })
    let notifyDisposalStarted!: () => void
    const disposalStarted = new Promise<void>(resolve => { notifyDisposalStarted = resolve })
    managed.agent = {
      forceAbort: () => undefined,
      dispose: () => undefined,
      disposeForRestart: async () => {
        notifyDisposalStarted()
        await disposalGate
      },
    } as never

    const deletion = manager.deleteSession(managed.id)
    let cleanupSettled = false
    let cleanup: Promise<void> | undefined
    try {
      await disposalStarted
      expect(runtime.sessions.has(managed.id)).toBe(false)
      expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
      expect(runtime.persistSession(managed)).toBe(false)
      expect(() => sessionPersistenceQueue.enqueue({
        ...stored,
        messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      }))
        .toThrow(`Session persistence is retired: ${managed.id}`)
      expect(existsSync(getSessionPath(root, managed.id))).toBe(true)

      cleanup = manager.cleanup().then(() => { cleanupSettled = true })
      await Promise.resolve()
      await Promise.resolve()
      expect(cleanupSettled).toBe(false)
    } finally {
      releaseDisposal()
    }

    await Promise.all([deletion, cleanup])
    expect(cleanupSettled).toBe(true)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
    expect(runtime.sessions.has(managed.id)).toBe(false)
    await expect(getOrCreateSessionById(root, managed.id))
      .rejects.toThrow(`Session ID was deleted during this app run and cannot be reused: ${managed.id}`)
  })

  it('waits for an admitted direct file callback before committing the directory move', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-direct-write-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Direct write drain' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-direct-write', name: 'Direct write', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      trackSessionOperation: <T>(candidate: typeof managed, operation: () => Promise<T>) => Promise<T>
    }
    runtime.sessions.set(managed.id, managed)

    let releaseWrite!: () => void
    const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
    let notifyWriteStarted!: () => void
    const writeStarted = new Promise<void>(resolve => { notifyWriteStarted = resolve })
    const directWrite = runtime.trackSessionOperation(managed, async () => {
      notifyWriteStarted()
      await writeGate
      const meta = join(getSessionPath(root, managed.id), 'meta')
      mkdirSync(meta, { recursive: true })
      writeFileSync(join(meta, 'late-anchor.json'), '{}')
    })
    await writeStarted

    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(deletionSettled).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)

    releaseWrite()
    await Promise.all([directWrite, deletion])
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('drains restart recovery before committing deletion so it cannot resurrect files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-restart-recovery-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Restart recovery drain' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-restart-recovery', name: 'Restart recovery', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      restartRecoveriesInFlight: Map<string, Promise<void>>
    }
    runtime.sessions.set(managed.id, managed)

    let releaseRecovery!: () => void
    const recoveryGate = new Promise<void>(resolve => { releaseRecovery = resolve })
    let notifyRecoveryStarted!: () => void
    const recoveryStarted = new Promise<void>(resolve => { notifyRecoveryStarted = resolve })
    let recovery!: Promise<void>
    recovery = (async () => {
      notifyRecoveryStarted()
      await recoveryGate
      const metaPath = join(getSessionPath(root, managed.id), 'meta')
      mkdirSync(metaPath, { recursive: true })
      writeFileSync(join(metaPath, 'late-restart-recovery.json'), '{}')
    })().finally(() => {
      if (runtime.restartRecoveriesInFlight.get(managed.id) === recovery) {
        runtime.restartRecoveriesInFlight.delete(managed.id)
      }
    })
    runtime.restartRecoveriesInFlight.set(managed.id, recovery)
    await recoveryStarted

    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(deletionSettled).toBe(false)
      expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
    } finally {
      releaseRecovery()
    }

    await Promise.all([recovery, deletion])
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('keeps the session visible but retired when synchronous force-abort fails after quiescence starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-abort-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Abort rollback' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-abort', name: 'Abort', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      retiringSessions: WeakSet<typeof managed>
      persistSession: (candidate: typeof managed) => boolean
    }
    runtime.sessions.set(managed.id, managed)
    managed.isProcessing = true
    managed.agent = {
      forceAbort: () => { throw new Error('fixture force-abort failure') },
      dispose: () => undefined,
      disposeForRestart: async () => undefined,
    } as never

    const originalRetire = sessionPersistenceQueue.retire
    let releaseRetirement!: () => void
    const retirementGate = new Promise<void>(resolve => { releaseRetirement = resolve })
    let notifyRetirementStarted!: () => void
    const retirementStarted = new Promise<void>(resolve => { notifyRetirementStarted = resolve })
    sessionPersistenceQueue.retire = async (id: string, workspaceRootPath?: string) => {
      const retirement = originalRetire.call(sessionPersistenceQueue, id, workspaceRootPath)
      notifyRetirementStarted()
      await retirementGate
      await retirement
    }

    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    try {
      await retirementStarted
      await Promise.resolve()
      expect(runtime.sessions.has(managed.id)).toBe(false)
      expect(deletionSettled).toBe(false)
    } finally {
      releaseRetirement()
    }
    try {
      await expect(deletion).rejects.toThrow('fixture force-abort failure')
    } finally {
      sessionPersistenceQueue.retire = originalRetire
    }

    expect(runtime.sessions.get(managed.id)).toBe(managed)
    expect(runtime.retiringSessions.has(managed)).toBe(true)
    expect(managed.stopRequested).toBe(true)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(runtime.persistSession(managed)).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
    expect(loadSession(root, managed.id)?.name).toBe('Abort rollback')
  })

  it('deletes a cold on-disk session whose persistence identity was never enqueued', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-cold-'))
    roots.push(root)
    const id = `cold-session-${Date.now()}`
    const stored: StoredSession = {
      id,
      workspaceRootPath: root,
      name: 'Cold delete',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    ensureSessionDir(root, id)
    writeSessionJsonl(getSessionFilePath(root, id), stored)
    const manager = new SessionManager()
    managers.push(manager)
    const { messages: _storedMessages, ...storedMetadata } = stored
    const managed = createManagedSession(
      storedMetadata,
      { id: 'workspace-cold', name: 'Cold', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      retiringSessions: WeakSet<typeof managed>
      persistSession: (candidate: typeof managed) => boolean
    }
    runtime.sessions.set(id, managed)

    await manager.deleteSession(id)

    expect(runtime.sessions.has(id)).toBe(false)
    expect(sessionPersistenceQueue.isRetired(id, root)).toBe(true)
    expect(existsSync(getSessionPath(root, id))).toBe(false)
  })

  it('deletes the captured workspace target after its logical symlink is retargeted', async () => {
    if (process.platform === 'win32') return

    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-retarget-'))
    roots.push(root)
    const rootA = join(root, 'workspace-a')
    const rootB = join(root, 'workspace-b')
    const alias = join(root, 'workspace-alias')
    const id = 'retargeted-session'
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    symlinkSync(rootA, alias, 'dir')

    const tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    }
    const storedA: StoredSession = {
      id,
      workspaceRootPath: alias,
      name: 'Target A',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage,
    }
    const storedB: StoredSession = {
      ...storedA,
      workspaceRootPath: rootB,
      name: 'Target B must survive',
    }
    ensureSessionDir(rootA, id)
    ensureSessionDir(rootB, id)
    writeSessionJsonl(getSessionFilePath(rootA, id), storedA)
    writeSessionJsonl(getSessionFilePath(rootB, id), storedB)

    const manager = new SessionManager()
    managers.push(manager)
    const { messages: _messages, ...storedMetadataA } = storedA
    const managed = createManagedSession(
      storedMetadataA,
      { id: 'workspace-retarget', name: 'Retarget', rootPath: alias, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      persistSession: (candidate: typeof managed) => boolean
    }
    runtime.sessions.set(id, managed)
    managed.name = 'Pending write for target A'
    expect(runtime.persistSession(managed)).toBe(true)
    expect(sessionPersistenceQueue.hasPending(id, rootA)).toBe(true)

    unlinkSync(alias)
    symlinkSync(rootB, alias, 'dir')
    await manager.deleteSession(id)

    expect(existsSync(getSessionPath(rootA, id))).toBe(false)
    expect(loadSession(rootB, id)?.name).toBe('Target B must survive')
    expect(sessionPersistenceQueue.hasPending(id, rootA)).toBe(false)
    expect(sessionPersistenceQueue.isRetired(id, rootA)).toBe(true)
    expect(sessionPersistenceQueue.isRetired(id, rootB)).toBe(false)
  })

  it('fails closed when the captured workspace directory is replaced during deletion', async () => {
    if (process.platform === 'win32') return

    const container = mkdtempSync(join(tmpdir(), 'robb-session-delete-root-replaced-'))
    roots.push(container)
    const workspaceRoot = join(container, 'workspace-live')
    const movedWorkspaceRoot = join(container, 'workspace-original')
    const id = 'root-replacement-session'
    mkdirSync(workspaceRoot, { recursive: true })
    const stored: StoredSession = {
      id,
      workspaceRootPath: workspaceRoot,
      name: 'Original physical session',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    ensureSessionDir(workspaceRoot, id)
    writeSessionJsonl(getSessionFilePath(workspaceRoot, id), stored)

    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      { ...stored, messages: undefined } as never,
      { id: 'workspace-root-replaced', name: 'Root replacement', rootPath: workspaceRoot, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as { sessions: Map<string, typeof managed> }
    runtime.sessions.set(id, managed)

    let releaseDisposal!: () => void
    const disposalGate = new Promise<void>(resolve => { releaseDisposal = resolve })
    let notifyDisposalStarted!: () => void
    const disposalStarted = new Promise<void>(resolve => { notifyDisposalStarted = resolve })
    managed.agent = {
      forceAbort: () => undefined,
      dispose: () => undefined,
      disposeForRestart: async () => {
        notifyDisposalStarted()
        await disposalGate
      },
    } as never

    const deletion = manager.deleteSession(id)
    await disposalStarted
    renameSync(workspaceRoot, movedWorkspaceRoot)
    const replacement: StoredSession = {
      ...stored,
      name: 'Replacement must survive',
      workspaceRootPath: workspaceRoot,
    }
    ensureSessionDir(workspaceRoot, id)
    const replacementFile = getSessionFilePath(workspaceRoot, id)
    writeSessionJsonl(replacementFile, replacement)
    const replacementBytes = readFileSync(replacementFile, 'utf8')
    releaseDisposal()

    await expect(deletion).rejects.toThrow('Session persistence root was replaced')
    expect(runtime.sessions.get(id)).toBe(managed)
    expect(sessionPersistenceQueue.isRetired(id, managed.persistenceRootPath)).toBe(true)
    await expect(manager.markSessionUnread(id)).rejects.toThrow(`Session ${id} is being deleted`)
    await expect(manager.setPendingPlanExecution(id, '/tmp/replacement-plan.md')).rejects
      .toThrow(`Session ${id} is being deleted`)
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)
    expect(loadSession(workspaceRoot, id)?.name).toBe('Replacement must survive')
    expect(loadSession(movedWorkspaceRoot, id)?.name).toBe('Original physical session')
  })

  it('preserves every source byte when the atomic move cannot start', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-rollback-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Atomic rollback' })
    const attachment = join(getSessionPath(root, stored.id), 'attachments', 'proof.txt')
    mkdirSync(join(getSessionPath(root, stored.id), 'attachments'), { recursive: true })
    writeFileSync(attachment, 'preserve-me')
    const liveSessionPath = getSessionPath(root, stored.id)
    const preservedSessionPath = join(root, 'preserved-session-source')
    renameSync(liveSessionPath, preservedSessionPath)
    const preservedSessionBytes = readFileSync(join(preservedSessionPath, 'session.jsonl'))
    symlinkSync(preservedSessionPath, liveSessionPath, 'dir')
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-rollback', name: 'Rollback', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      retiringSessions: WeakSet<typeof managed>
      persistSession: (candidate: typeof managed) => boolean
    }
    runtime.sessions.set(managed.id, managed)
    managed.name = 'Must never be written through the unsafe live symlink'

    await expect(manager.deleteSession(managed.id))
      .rejects.toThrow(`Could not atomically remove session files for ${managed.id}`)

    expect(runtime.sessions.get(managed.id)).toBe(managed)
    expect(runtime.retiringSessions.has(managed)).toBe(true)
    expect(managed.stopRequested).toBe(true)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(runtime.persistSession(managed)).toBe(false)
    expect(readFileSync(join(preservedSessionPath, 'attachments', 'proof.txt'), 'utf8')).toBe('preserve-me')
    // A failed unsafe-path deletion must not persist the changed in-memory name
    // through the live symlink; arbitrary link targets would turn that into an
    // external write.
    expect(readFileSync(join(preservedSessionPath, 'session.jsonl'))).toEqual(preservedSessionBytes)
    // Reads share the same fail-closed component policy as writes/deletion:
    // preserving the bytes behind an untrusted session symlink does not make
    // that symlink an admissible live session path.
    expect(loadSession(root, managed.id)).toBeNull()

    // A later UI mutation may still see the tombstone object, but admission
    // and persistence both remain fenced and cannot follow the untrusted link.
    await expect(manager.renameSession(managed.id, 'Still must not cross the unsafe symlink'))
      .rejects.toThrow(`Session ${managed.id} is being deleted`)
    expect(runtime.persistSession(managed)).toBe(false)
    expect(readFileSync(join(preservedSessionPath, 'session.jsonl'))).toEqual(preservedSessionBytes)

    // Repairing the path must leave the visible fail-closed object available
    // for a later explicit deletion retry.
    rmSync(liveSessionPath, { recursive: true, force: true })
    renameSync(preservedSessionPath, liveSessionPath)
    expect(loadSession(root, managed.id)?.name).toBe('Atomic rollback')
    await manager.deleteSession(managed.id)
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(existsSync(liveSessionPath)).toBe(false)
  })

  it('keeps a quiesced active session interrupted, idle, and retired after an atomic pre-commit failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-active-rollback-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Active atomic rollback' })
    const liveSessionPath = getSessionPath(root, stored.id)
    const preservedSessionPath = join(root, 'preserved-active-session-source')
    renameSync(liveSessionPath, preservedSessionPath)
    symlinkSync(preservedSessionPath, liveSessionPath, 'dir')
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-active-rollback', name: 'Active rollback', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const processingTransitions: boolean[] = []
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      retiringSessions: WeakSet<typeof managed>
      setProcessing: (candidate: typeof managed, processing: boolean) => void
    }
    const originalSetProcessing = runtime.setProcessing.bind(manager)
    runtime.setProcessing = (candidate, processing) => {
      processingTransitions.push(processing)
      originalSetProcessing(candidate, processing)
    }
    runtime.sessions.set(managed.id, managed)
    managed.isProcessing = true
    // This is the state observed while a user Stop is still draining. A
    // deletion rollback after proven teardown must not restore that stale
    // runtime-only fence.
    managed.stopRequested = true
    managed.wasInterrupted = false
    managed.agent = {
      forceAbort: () => undefined,
      dispose: () => undefined,
      disposeForRestart: async () => undefined,
    } as never

    await expect(manager.deleteSession(managed.id))
      .rejects.toThrow(`Could not atomically remove session files for ${managed.id}`)

    expect(runtime.sessions.get(managed.id)).toBe(managed)
    expect(managed.isProcessing).toBe(false)
    expect(managed.stopRequested).toBe(true)
    expect(managed.wasInterrupted).toBe(true)
    expect(managed.agent).toBeNull()
    expect(processingTransitions).toEqual([false])
    expect(runtime.retiringSessions.has(managed)).toBe(true)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(existsSync(preservedSessionPath)).toBe(true)
  })

  it('keeps a failed runtime teardown retired until a later deletion retry proves destruction', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-runtime-fence-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Runtime teardown fence' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-runtime-fence', name: 'Runtime fence', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      retiringSessions: WeakSet<typeof managed>
      persistSession: (candidate: typeof managed) => boolean
      processEvent: (candidate: typeof managed, event: unknown) => Promise<void>
      getOrCreateAgent: (candidate: typeof managed) => Promise<unknown>
      runtimeDisposalBarriers: Map<string, Map<symbol, unknown>>
    }
    runtime.sessions.set(managed.id, managed)
    managed.isProcessing = true
    managed.stopRequested = false
    managed.wasInterrupted = false
    let allowDisposal = false
    let disposalCalls = 0
    managed.agent = {
      forceAbort: () => undefined,
      dispose: () => undefined,
      disposeForRestart: async () => {
        disposalCalls += 1
        if (!allowDisposal) throw new Error('fixture persistent disposal failure')
      },
    } as never

    await expect(manager.deleteSession(managed.id))
      .rejects.toThrow(`Runtime destruction for session ${managed.id} is not yet proven`)

    expect(runtime.sessions.get(managed.id)).toBe(managed)
    expect(managed.isProcessing).toBe(false)
    expect(managed.stopRequested).toBe(true)
    expect(managed.wasInterrupted).toBe(true)
    expect(managed.agent).toBeNull()
    expect(runtime.retiringSessions.has(managed)).toBe(true)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(runtime.runtimeDisposalBarriers.get(managed.id)?.size).toBe(1)
    expect(runtime.persistSession(managed)).toBe(false)
    const streamingBeforeLateEvent = managed.streamingText
    await runtime.processEvent(managed, {
      type: 'text_delta',
      text: 'must not be accepted',
      turnId: 'late-retired-event',
    })
    expect(managed.streamingText).toBe(streamingBeforeLateEvent)
    await expect(runtime.getOrCreateAgent(managed))
      .rejects.toThrow(`Session ${managed.id} runtime is still being retired`)
    await expect(manager.sendMessage(managed.id, 'must remain fenced'))
      .rejects.toThrow(`Session ${managed.id} is being deleted`)

    // The source directory and in-memory object remain available for the exact
    // deletion to be retried. Once the same destructor proves success, the
    // retry may cross the filesystem commit point.
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
    allowDisposal = true
    await manager.deleteSession(managed.id)
    expect(disposalCalls).toBe(3)
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('never resurrects a committed retention archive when post-commit teardown throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-retention-commit-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Committed archive' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-retention-commit', name: 'Retention commit', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as { sessions: Map<string, typeof managed> }
    runtime.sessions.set(managed.id, managed)
    let browserTeardownCalls = 0
    manager.getBrowserPaneManagerForSession = () => ({
      destroyForSession: () => {
        browserTeardownCalls += 1
        throw new Error('fixture browser teardown failure')
      },
    } as never)
    let archivePath: string | undefined

    await manager.deleteSession(managed.id, () => {
      archivePath = archiveCompletedChatDirectory(root, getSessionPath(root, managed.id), managed.id)
      return true
    })

    expect(archivePath).toBeDefined()
    expect(existsSync(archivePath!)).toBe(true)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(browserTeardownCalls).toBe(1)
  })

  it('does not restore a source when retention reports a committed move with failed rollback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-retention-rollback-failed-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Committed failed rollback' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-retention-rollback', name: 'Retention rollback', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as { sessions: Map<string, typeof managed> }
    runtime.sessions.set(managed.id, managed)
    const archivePath = join(root, 'committed-retention-archive')

    await expect(manager.deleteSession(managed.id, () => {
      renameSync(getSessionPath(root, managed.id), archivePath)
      throw new CompletedChatArchiveError(
        'fixture rollback failed after commit',
        true,
        archivePath,
      )
    })).resolves.toBeUndefined()

    expect(existsSync(archivePath)).toBe(true)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
  })

  it('runs retention archival after the write fence and keeps a cancelled retirement fail-closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-retention-cancel-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Retention cancellation' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-retention', name: 'Retention', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      retiringSessions: WeakSet<typeof managed>
      persistSession: (candidate: typeof managed) => boolean
    }
    runtime.sessions.set(managed.id, managed)
    let callbackCount = 0

    await manager.deleteSession(managed.id, () => {
      callbackCount += 1
      expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
      expect(runtime.sessions.has(managed.id)).toBe(false)
      expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
      return false
    })

    expect(callbackCount).toBe(1)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(runtime.sessions.get(managed.id)).toBe(managed)
    expect(runtime.retiringSessions.has(managed)).toBe(true)
    expect(managed.stopRequested).toBe(true)
    expect(runtime.persistSession(managed)).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)

    await manager.deleteSession(managed.id)
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('finishes runtime and watcher cleanup before aggregating persistence flush failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-cleanup-flush-'))
    roots.push(root)
    const manager = new SessionManager()
    const managed = createManagedSession(
      { id: 'cleanup-flush-failure', createdAt: 1 },
      { id: 'workspace-cleanup-flush', name: 'Cleanup flush', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      configWatchers: Map<string, { stop: () => void }>
      disposeManagedAgentRuntime: (candidate: typeof managed, reason: string) => Promise<void>
    }
    runtime.sessions.set(managed.id, managed)
    managed.agent = {} as never
    let disposalCalls = 0
    runtime.disposeManagedAgentRuntime = async candidate => {
      disposalCalls += 1
      candidate.agent = null
    }
    let watcherStops = 0
    runtime.configWatchers.set(root, { stop: () => { watcherStops += 1 } })

    const originalFlushAll = sessionPersistenceQueue.flushAll
    let flushCalls = 0
    sessionPersistenceQueue.flushAll = async () => {
      flushCalls += 1
      throw new Error(`fixture cleanup flush ${flushCalls}`)
    }
    let cleanupError: unknown
    try {
      await manager.cleanup()
    } catch (error) {
      cleanupError = error
    } finally {
      sessionPersistenceQueue.flushAll = originalFlushAll
    }

    // Cleanup intentionally performs a stable second disposal pass after
    // draining admitted operations, so a runtime attached late cannot escape.
    expect(disposalCalls).toBe(2)
    expect(watcherStops).toBe(1)
    expect(flushCalls).toBe(2)
    expect(cleanupError).toBeInstanceOf(AggregateError)
    expect((cleanupError as AggregateError).errors.map(error => (error as Error).message))
      .toEqual(['fixture cleanup flush 1', 'fixture cleanup flush 2'])
  })

  it('consumes background flush rejection while preserving the workspace identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-background-flush-'))
    roots.push(root)
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      { id: 'background-flush-failure', createdAt: 1 },
      { id: 'workspace-background-flush', name: 'Background flush', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const runtime = manager as unknown as {
      flushSessionPersistenceInBackground: (candidate: typeof managed, reason: string) => void
    }
    const originalFlush = sessionPersistenceQueue.flush
    let observed: [string, string | undefined] | undefined
    sessionPersistenceQueue.flush = async (sessionId, workspaceRootPath) => {
      observed = [sessionId, workspaceRootPath]
      throw new Error('fixture background flush failure')
    }
    try {
      expect(runtime.flushSessionPersistenceInBackground(managed, 'fixture callback')).toBeUndefined()
      await Bun.sleep(0)
    } finally {
      sessionPersistenceQueue.flush = originalFlush
    }
    expect(observed).toEqual([managed.id, managed.persistenceRootPath])
  })
})
