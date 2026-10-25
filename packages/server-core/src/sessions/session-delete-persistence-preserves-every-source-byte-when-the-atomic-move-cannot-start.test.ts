import { ConfigWatcher } from "@craft-agent/shared/config";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath, loadSession, sessionPersistenceQueue } from "@craft-agent/shared/sessions";
import { SessionManager, createManagedSession } from "./SessionManager";
import { archiveCompletedChatDirectory, CompletedChatArchiveError } from "./completed-chat-retention";
import { managers, roots } from "./testing/session-delete-persistence-fixture.ts";

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.cleanup()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('session deletion persistence retirement', () => {
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
    managed.name = 'Must never be written through the unsafe live symlink'

    await expect(manager.deleteSession(managed.id))
      .rejects.toThrow(`Could not atomically remove session files for ${managed.id}`)

    expect(sessionRuntimeStateForTest(manager).sessions.get(managed.id)).toBe(managed)
    expect(sessionRuntimeStateForTest(manager).retiringSessions.has(managed)).toBe(true)
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
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
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

    expect(sessionRuntimeStateForTest(manager).sessions.get(managed.id)).toBe(managed)
    expect(managed.isProcessing).toBe(false)
    expect(managed.stopRequested).toBe(true)
    expect(managed.wasInterrupted).toBe(true)
    expect(managed.agent).toBeNull()
    expect(processingTransitions).toEqual([false])
    expect(sessionRuntimeStateForTest(manager).retiringSessions.has(managed)).toBe(true)
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
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

    expect(sessionRuntimeStateForTest(manager).sessions.get(managed.id)).toBe(managed)
    expect(managed.isProcessing).toBe(false)
    expect(managed.stopRequested).toBe(true)
    expect(managed.wasInterrupted).toBe(true)
    expect(managed.agent).toBeNull()
    expect(sessionRuntimeStateForTest(manager).retiringSessions.has(managed)).toBe(true)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(sessionRuntimeStateForTest(manager).runtimeDisposalBarriers.get(managed.id)?.size).toBe(1)
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
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
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

    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
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
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
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

    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
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
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
    let callbackCount = 0

    await manager.deleteSession(managed.id, () => {
      callbackCount += 1
      expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
      expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
      expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
      return false
    })

    expect(callbackCount).toBe(1)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(sessionRuntimeStateForTest(manager).sessions.get(managed.id)).toBe(managed)
    expect(sessionRuntimeStateForTest(manager).retiringSessions.has(managed)).toBe(true)
    expect(managed.stopRequested).toBe(true)
    expect(runtime.persistSession(managed)).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)

    await manager.deleteSession(managed.id)
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
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
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
    managed.agent = {} as never
    let disposalCalls = 0
    runtime.disposeManagedAgentRuntime = async candidate => {
      disposalCalls += 1
      candidate.agent = null
    }
    let watcherStops = 0
    sessionRuntimeStateForTest(manager).configWatchers.set(root, Object.assign(new ConfigWatcher(root, {}), { stop: () => { watcherStops += 1 } }))

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
});
