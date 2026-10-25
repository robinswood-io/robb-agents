import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, ensureSessionDir, getOrCreateSessionById, getSessionFilePath, getSessionPath, loadSession, sessionPersistenceQueue, writeSessionJsonl, type StoredSession } from "@craft-agent/shared/sessions";
import { SessionManager, createManagedSession } from "./SessionManager";
import { managers, roots } from "./testing/session-delete-persistence-fixture.ts";

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.cleanup()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('session deletion persistence retirement', () => {
  it('proves runtime disposal before commit, rejects late persistence, and makes cleanup await deletion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Delete race' })
    const manager = withSessionOperationsForTest(new SessionManager())
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)

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
      expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
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
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
    await expect(getOrCreateSessionById(root, managed.id))
      .rejects.toThrow(`Session ID was deleted during this app run and cannot be reused: ${managed.id}`)
  })

  it('waits for an admitted direct file callback before committing the directory move', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-session-delete-direct-write-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Direct write drain' })
    const manager = withSessionOperationsForTest(new SessionManager())
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)

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
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
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
    const manager = withSessionOperationsForTest(new SessionManager())
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-restart-recovery', name: 'Restart recovery', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )

    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)

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
      if (sessionRuntimeStateForTest(manager).restartRecoveriesInFlight.get(managed.id) === recovery) {
        sessionRuntimeStateForTest(manager).restartRecoveriesInFlight.delete(managed.id)
      }
    })
    sessionRuntimeStateForTest(manager).restartRecoveriesInFlight.set(managed.id, recovery)
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
    const manager = withSessionOperationsForTest(new SessionManager())
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
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
      expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
      expect(deletionSettled).toBe(false)
    } finally {
      releaseRetirement()
    }
    try {
      await expect(deletion).rejects.toThrow('fixture force-abort failure')
    } finally {
      sessionPersistenceQueue.retire = originalRetire
    }

    expect(sessionRuntimeStateForTest(manager).sessions.get(managed.id)).toBe(managed)
    expect(sessionRuntimeStateForTest(manager).retiringSessions.has(managed)).toBe(true)
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
    const manager = withSessionOperationsForTest(new SessionManager())
    managers.push(manager)
    const { messages: _storedMessages, ...storedMetadata } = stored
    const managed = createManagedSession(
      storedMetadata,
      { id: 'workspace-cold', name: 'Cold', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )

    sessionRuntimeStateForTest(manager).sessions.set(id, managed)

    await manager.deleteSession(id)

    expect(sessionRuntimeStateForTest(manager).sessions.has(id)).toBe(false)
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

    const manager = withSessionOperationsForTest(new SessionManager())
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
    sessionRuntimeStateForTest(manager).sessions.set(id, managed)
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

    const manager = withSessionOperationsForTest(new SessionManager())
    managers.push(manager)
    const managed = createManagedSession(
      { ...stored, messages: undefined } as never,
      { id: 'workspace-root-replaced', name: 'Root replacement', rootPath: workspaceRoot, createdAt: 1 } as never,
      { messagesLoaded: true },
    )

    sessionRuntimeStateForTest(manager).sessions.set(id, managed)

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
    expect(sessionRuntimeStateForTest(manager).sessions.get(id)).toBe(managed)
    expect(sessionPersistenceQueue.isRetired(id, managed.persistenceRootPath)).toBe(true)
    await expect(manager.markSessionUnread(id)).rejects.toThrow(`Session ${id} is being deleted`)
    await expect(manager.setPendingPlanExecution(id, '/tmp/replacement-plan.md')).rejects
      .toThrow(`Session ${id} is being deleted`)
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)
    expect(loadSession(workspaceRoot, id)?.name).toBe('Replacement must survive')
    expect(loadSession(movedWorkspaceRoot, id)?.name).toBe('Original physical session')
  })
});
