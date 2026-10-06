import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, getSessionPath, sessionPersistenceQueue } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

const roots: string[] = []
const managers: SessionManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.cleanup()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createGatedSourceRuntime() {
  let releaseBuild!: () => void
  const buildGate = new Promise<void>(resolve => { releaseBuild = resolve })
  let notifyBuildStarted!: () => void
  const buildStarted = new Promise<void>(resolve => { notifyBuildStarted = resolve })
  const sourceRuntimeApplications: string[] = []

  const agent = {
    setAllSources: () => { sourceRuntimeApplications.push('all-sources') },
    applyBridgeUpdates: async () => { sourceRuntimeApplications.push('bridge') },
    setSourceServers: async () => { sourceRuntimeApplications.push('servers') },
    forceAbort: () => undefined,
    dispose: () => undefined,
    disposeForRestart: async () => undefined,
  }

  const buildSessionSourceServers = async () => {
    notifyBuildStarted()
    await buildGate
    return { mcpServers: {}, apiServers: {}, errors: [] }
  }

  return {
    agent,
    buildSessionSourceServers,
    buildStarted,
    releaseBuild,
    sourceRuntimeApplications,
  }
}

describe('session source deletion fence', () => {
  it('drains a source selection build and rejects it before applying runtime or renderer state after detach', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-source-selection-delete-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Source selection race' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-source-selection', name: 'Sources', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const gated = createGatedSourceRuntime()
    managed.agent = gated.agent as never

    const sourceEvents: unknown[] = []
    manager.setEventSink(((...args: unknown[]) => {
      const event = args[2] as { type?: string } | undefined
      if (event?.type === 'sources_changed') sourceEvents.push(event)
    }) as never)
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      buildSessionSourceServers: typeof gated.buildSessionSourceServers
    }
    runtime.sessions.set(managed.id, managed)
    runtime.buildSessionSourceServers = gated.buildSessionSourceServers

    const update = manager.setSessionSources(managed.id, ['source-requested-during-delete'])
    await gated.buildStarted

    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(deletionSettled).toBe(false)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)

    gated.releaseBuild()
    await expect(update).rejects.toThrow(`Session ${managed.id} is being deleted`)
    await deletion

    expect(gated.sourceRuntimeApplications).toEqual([])
    expect(sourceEvents).toEqual([])
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })

  it('keeps a partially mutated source selection retired after an unsafe delete and permits a repaired retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-source-selection-unsafe-delete-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Unsafe source selection race' })
    const liveSessionPath = getSessionPath(root, stored.id)
    const preservedSessionPath = join(root, 'preserved-source-selection-session')
    renameSync(liveSessionPath, preservedSessionPath)
    const preservedSessionBytes = readFileSync(join(preservedSessionPath, 'session.jsonl'))
    symlinkSync(preservedSessionPath, liveSessionPath, 'dir')

    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-source-selection-unsafe', name: 'Unsafe sources', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const gated = createGatedSourceRuntime()
    managed.agent = gated.agent as never

    const sourceEvents: unknown[] = []
    manager.setEventSink(((...args: unknown[]) => {
      const event = args[2] as { type?: string } | undefined
      if (event?.type === 'sources_changed') sourceEvents.push(event)
    }) as never)
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      retiringSessions: WeakSet<typeof managed>
      persistSession: (candidate: typeof managed) => boolean
      buildSessionSourceServers: typeof gated.buildSessionSourceServers
      deferredAutomaticSessions: Set<string>
      automaticAdmissionReservations: Set<string>
    }
    runtime.sessions.set(managed.id, managed)
    runtime.buildSessionSourceServers = gated.buildSessionSourceServers
    runtime.deferredAutomaticSessions.add(managed.id)
    runtime.automaticAdmissionReservations.add(managed.id)

    const requestedSources = ['source-mutated-before-delete-drain']
    const update = manager.setSessionSources(managed.id, requestedSources)
    await gated.buildStarted

    const deletion = manager.deleteSession(managed.id)
    const deletionResult = deletion.then(
      () => undefined,
      error => error,
    )
    expect(runtime.sessions.has(managed.id)).toBe(false)

    gated.releaseBuild()
    await expect(update).rejects.toThrow(`Session ${managed.id} is being deleted`)
    const deletionError = await deletionResult
    expect(deletionError).toBeInstanceOf(Error)
    expect((deletionError as Error).message)
      .toBe(`Could not atomically remove session files for ${managed.id}`)

    // The source method mutated memory before awaiting its build. The unsafe
    // filesystem failure must expose that object only as a stopped tombstone,
    // never persist it through the symlink, and never restore admissions.
    expect(managed.enabledSourceSlugs).toEqual(requestedSources)
    expect(runtime.sessions.get(managed.id)).toBe(managed)
    expect(runtime.retiringSessions.has(managed)).toBe(true)
    expect(managed.stopRequested).toBe(true)
    expect(sessionPersistenceQueue.isRetired(managed.id, root)).toBe(true)
    expect(runtime.persistSession(managed)).toBe(false)
    expect(runtime.deferredAutomaticSessions.has(managed.id)).toBe(false)
    expect(runtime.automaticAdmissionReservations.has(managed.id)).toBe(false)
    expect(gated.sourceRuntimeApplications).toEqual([])
    expect(sourceEvents).toEqual([])
    expect(readFileSync(join(preservedSessionPath, 'session.jsonl'))).toEqual(preservedSessionBytes)

    rmSync(liveSessionPath, { recursive: true, force: true })
    renameSync(preservedSessionPath, liveSessionPath)
    await manager.deleteSession(managed.id)
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(existsSync(liveSessionPath)).toBe(false)
  })

  it('uses one workspace-reload lease and cancels runtime application when deletion detaches the session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-source-reload-delete-'))
    roots.push(root)
    const stored = await createSession(root, { name: 'Source reload race' })
    const manager = new SessionManager()
    managers.push(manager)
    const managed = createManagedSession(
      stored,
      { id: 'workspace-source-reload', name: 'Reload', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    const gated = createGatedSourceRuntime()
    managed.agent = gated.agent as never

    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      buildSessionSourceServers: typeof gated.buildSessionSourceServers
      reloadSourcesForWorkspace: (workspaceRootPath: string) => Promise<void>
    }
    runtime.sessions.set(managed.id, managed)
    runtime.buildSessionSourceServers = gated.buildSessionSourceServers

    const reload = runtime.reloadSourcesForWorkspace(root)
    await gated.buildStarted

    let deletionSettled = false
    const deletion = manager.deleteSession(managed.id).finally(() => { deletionSettled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    expect(deletionSettled).toBe(false)

    gated.releaseBuild()
    await Promise.all([reload, deletion])

    expect(gated.sourceRuntimeApplications).toEqual([])
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
  })
})
