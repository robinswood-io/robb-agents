import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, getSessionFilePath, getSessionPath, loadSession } from '@craft-agent/shared/sessions'
import { SessionManager, createManagedSession } from './SessionManager'

const roots: string[] = []
const originalFetch = globalThis.fetch
const originalDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function managedSession(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'robb-session-shutdown-'))
  roots.push(root)
  const stored = await createSession(root, { name })
  const manager = new SessionManager()
  const managed = createManagedSession(
    stored,
    { id: `workspace-${stored.id}`, name: 'Shutdown', rootPath: root, createdAt: 1 } as never,
    { messagesLoaded: true },
  )
  ;(manager as unknown as { sessions: Map<string, typeof managed> }).sessions.set(managed.id, managed)
  return { root, manager, managed }
}

describe('session shutdown operation and runtime fences', () => {
  it('waits for an admitted share, rejects new leases, and leaves no late write or event', async () => {
    const { root, manager, managed } = await managedSession('Shutdown share')
    const events: Array<{ type: string }> = []
    const runtime = manager as unknown as {
      sendEvent: (event: { type: string }) => void
    }
    runtime.sendEvent = event => { events.push(event) }

    let releaseUpload!: () => void
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve })
    let notifyUploadStarted!: () => void
    const uploadStarted = new Promise<void>(resolve => { notifyUploadStarted = resolve })
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      notifyUploadStarted()
      await uploadGate
      return new Response(JSON.stringify({
        id: 'shutdown-share-id',
        url: 'https://viewer.invalid/shutdown-share-id',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const order: string[] = []
    const share = manager.shareToViewer(managed.id).then(result => {
      order.push('share')
      return result
    })
    await uploadStarted

    let cleanupSettled = false
    let eventsAtCleanup = -1
    const cleanup = manager.cleanup().then(() => {
      cleanupSettled = true
      eventsAtCleanup = events.length
      order.push('cleanup')
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(cleanupSettled).toBe(false)
    await expect(manager.shareToViewer(managed.id)).rejects.toThrow('session manager is shutting down')

    releaseUpload()
    expect(await share).toEqual({ success: true, url: 'https://viewer.invalid/shutdown-share-id' })
    await cleanup

    expect(order).toEqual(['share', 'cleanup'])
    expect(loadSession(root, managed.id)?.sharedId).toBe('shutdown-share-id')
    const persistedAtCleanup = readFileSync(getSessionFilePath(root, managed.id), 'utf8')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(events.length).toBe(eventsAtCleanup)
    expect(readFileSync(getSessionFilePath(root, managed.id), 'utf8')).toBe(persistedAtCleanup)
  })

  it('keeps terminal tool-result admission open through runtime destruction, then closes it', async () => {
    const { manager, managed } = await managedSession('Shutdown terminal result')
    const toolUseId = 'shutdown-tool-result'
    managed.messages.push({
      id: 'shutdown-tool-message',
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolName: 'Bash',
      toolUseId,
      toolStatus: 'executing',
    } as never)

    const events: Array<{ type: string; result?: string }> = []
    const runtime = manager as unknown as {
      processEvent: (session: typeof managed, event: unknown, generation?: number) => Promise<void>
      sendEvent: (event: { type: string; result?: string }) => void
    }
    runtime.sendEvent = event => { events.push(event) }
    managed.agent = {
      dispose: () => undefined,
      disposeForRestart: async () => runtime.processEvent(managed, {
        type: 'tool_result',
        toolUseId,
        toolName: 'Bash',
        result: 'finished before runtime destruction',
        isError: false,
      }, managed.processingGeneration),
    } as never

    await manager.cleanup()

    const toolMessage = managed.messages.find(message => message.toolUseId === toolUseId)
    expect(toolMessage?.toolResult).toBe('finished before runtime destruction')
    expect(events.some(event => event.type === 'tool_result'
      && event.result === 'finished before runtime destruction')).toBe(true)
    const eventCount = events.length
    await runtime.processEvent(managed, {
      type: 'tool_result',
      toolUseId,
      toolName: 'Bash',
      result: 'too late',
      isError: false,
    }, managed.processingGeneration)
    expect(toolMessage?.toolResult).toBe('finished before runtime destruction')
    expect(events).toHaveLength(eventCount)
  })

  it('destroys a blocking runtime before draining its admitted send lease', async () => {
    const { manager, managed } = await managedSession('Shutdown blocked send')
    let notifySendEntered!: () => void
    const sendEntered = new Promise<void>(resolve => { notifySendEntered = resolve })
    let releaseSend!: () => void
    const sendGate = new Promise<void>(resolve => { releaseSend = resolve })
    const order: string[] = []
    const runtime = manager as unknown as {
      performSendMessage: (...args: unknown[]) => Promise<void>
    }
    runtime.performSendMessage = async () => {
      notifySendEntered()
      await sendGate
      order.push('send')
    }
    managed.agent = {
      forceAbort: () => { order.push('abort') },
      dispose: () => undefined,
      disposeForRestart: async () => {
        order.push('dispose')
        releaseSend()
      },
    } as never

    const sending = manager.sendMessage(managed.id, 'Blocked provider turn')
    await sendEntered
    const cleanup = manager.cleanup().then(() => { order.push('cleanup') })

    await Promise.all([sending, cleanup])

    expect(order[0]).toBe('abort')
    expect(order.indexOf('dispose')).toBeGreaterThan(order.indexOf('abort'))
    expect(order.indexOf('send')).toBeGreaterThan(order.indexOf('dispose'))
    expect(order.at(-1)).toBe('cleanup')
  })

  it('stops watchers synchronously and rejects synchronous mutations after cleanup', async () => {
    const { root, manager, managed } = await managedSession('Shutdown sync mutation fence')
    managed.messages.push({
      id: 'shutdown-message',
      role: 'user',
      content: 'original',
      timestamp: Date.now(),
    })
    const runtime = manager as unknown as {
      configWatchers: Map<string, { stop: () => void }>
      persistSession: (session: typeof managed) => boolean
      sendEvent: (event: { type: string }) => void
    }
    const events: Array<{ type: string }> = []
    runtime.sendEvent = event => { events.push(event) }
    runtime.persistSession(managed)
    await manager.flushSession(managed.id)

    let watcherStopped = false
    runtime.configWatchers.set(root, { stop: () => { watcherStopped = true } })
    const cleanup = manager.cleanup()
    expect(watcherStopped).toBe(true)
    await cleanup

    const bytesAtCleanup = readFileSync(getSessionFilePath(root, managed.id), 'utf8')
    const eventsAtCleanup = events.length
    const originalWorkingDirectory = managed.workingDirectory
    const originalPermissionMode = managed.permissionMode
    const originalThinkingLevel = managed.thinkingLevel

    expect(() => manager.updateWorkingDirectory(managed.id, root)).toThrow('session manager is shutting down')
    expect(() => manager.setSessionPermissionMode(managed.id, 'safe')).toThrow('session manager is shutting down')
    expect(() => manager.setSessionThinkingLevel(managed.id, 'high')).toThrow('session manager is shutting down')
    expect(() => manager.updateMessageContent(managed.id, 'shutdown-message', 'late')).toThrow('session manager is shutting down')
    expect(() => manager.addMessageAnnotation(managed.id, 'shutdown-message', { id: 'late' } as never))
      .toThrow('session manager is shutting down')

    await new Promise<void>(resolve => setImmediate(resolve))
    expect(managed.workingDirectory).toBe(originalWorkingDirectory)
    expect(managed.permissionMode).toBe(originalPermissionMode)
    expect(managed.thinkingLevel).toBe(originalThinkingLevel)
    expect(managed.messages.find(message => message.id === 'shutdown-message')?.content).toBe('original')
    expect(events).toHaveLength(eventsAtCleanup)
    expect(readFileSync(getSessionFilePath(root, managed.id), 'utf8')).toBe(bytesAtCleanup)
  })

  it('drains a create admitted before shutdown and rejects a later create', async () => {
    const { manager } = await managedSession('Shutdown create fence')
    let notifyCreateEntered!: () => void
    const createEntered = new Promise<void>(resolve => { notifyCreateEntered = resolve })
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    const order: string[] = []
    const runtime = manager as unknown as {
      performCreateSession: (...args: unknown[]) => Promise<unknown>
    }
    runtime.performCreateSession = async () => {
      notifyCreateEntered()
      await createGate
      order.push('create')
      return {} as never
    }

    const creating = manager.createSession('fixture-workspace')
    await createEntered
    let cleanupSettled = false
    const cleanup = manager.cleanup().then(() => {
      cleanupSettled = true
      order.push('cleanup')
    })
    await Promise.resolve()
    expect(cleanupSettled).toBe(false)
    await expect(manager.createSession('fixture-workspace')).rejects.toThrow('manager is shutting down')

    releaseCreate()
    await Promise.all([creating, cleanup])
    expect(order).toEqual(['create', 'cleanup'])
  })

  it('drains a restart recovery before the final shutdown persistence barrier', async () => {
    const { root, manager, managed } = await managedSession('Shutdown restart recovery')
    const runtime = manager as unknown as {
      restartRecoveriesInFlight: Map<string, Promise<void>>
    }
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
      writeFileSync(join(metaPath, 'shutdown-recovery.json'), '{}')
    })().finally(() => {
      if (runtime.restartRecoveriesInFlight.get(managed.id) === recovery) {
        runtime.restartRecoveriesInFlight.delete(managed.id)
      }
    })
    runtime.restartRecoveriesInFlight.set(managed.id, recovery)
    await recoveryStarted

    let cleanupSettled = false
    const cleanup = manager.cleanup().finally(() => { cleanupSettled = true })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(cleanupSettled).toBe(false)
    } finally {
      releaseRecovery()
    }

    await Promise.all([recovery, cleanup])
    const recoveryPath = join(getSessionPath(root, managed.id), 'meta', 'shutdown-recovery.json')
    expect(existsSync(recoveryPath)).toBe(true)
    const bytesAtCleanup = readFileSync(recoveryPath, 'utf8')
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(readFileSync(recoveryPath, 'utf8')).toBe(bytesAtCleanup)
  })

  it('drains an admitted strong cancellation proof without nesting its silent stop lease', async () => {
    const { manager, managed } = await managedSession('Shutdown strong cancellation')
    const runtime = manager as unknown as {
      performCancelProcessingAndWait: (
        candidate: typeof managed,
        timeoutMs: number,
      ) => Promise<unknown>
    }
    let releaseCancellation!: () => void
    const cancellationGate = new Promise<void>(resolve => { releaseCancellation = resolve })
    let notifyCancellationStarted!: () => void
    const cancellationStarted = new Promise<void>(resolve => { notifyCancellationStarted = resolve })
    runtime.performCancelProcessingAndWait = async () => {
      notifyCancellationStarted()
      await cancellationGate
      return { sessionId: managed.id, workspaceId: managed.workspace.id, reason: 'interrupted' }
    }

    const cancellation = manager.cancelProcessingAndWait(managed.id, 5_000)
    await cancellationStarted
    let cleanupSettled = false
    const cleanup = manager.cleanup().finally(() => { cleanupSettled = true })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(cleanupSettled).toBe(false)
    } finally {
      releaseCancellation()
    }

    await Promise.all([cancellation, cleanup])
  })

  it('drains the retained silent stop after its strong-cancellation caller times out', async () => {
    const { manager, managed } = await managedSession('Shutdown timed-out strong cancellation')
    const runtime = manager as unknown as {
      cancelProcessing: (sessionId: string, silent?: boolean) => Promise<void>
    }
    let releaseStop!: () => void
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    let notifyStopStarted!: () => void
    const stopStarted = new Promise<void>(resolve => { notifyStopStarted = resolve })
    runtime.cancelProcessing = async () => {
      notifyStopStarted()
      await stopGate
    }

    const cancellation = manager.cancelProcessingAndWait(managed.id, 1)
    await stopStarted
    await expect(cancellation).rejects.toThrow('did not stop within 1 ms')

    let cleanupSettled = false
    const cleanup = manager.cleanup().finally(() => { cleanupSettled = true })
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(cleanupSettled).toBe(false)
    } finally {
      releaseStop()
    }
    await cleanup
  })

  it('retries a detached failed runtime destructor before reporting cleanup success', async () => {
    const { manager, managed } = await managedSession('Shutdown disposal retry')
    let disposalCalls = 0
    managed.agent = {
      dispose: () => undefined,
      disposeForRestart: async () => {
        disposalCalls += 1
        if (disposalCalls === 1) throw new Error('fixture first shutdown disposal failure')
      },
    } as never
    const runtime = manager as unknown as {
      runtimeDisposalBarriers: Map<string, Map<symbol, unknown>>
      runtimeDisposalsInFlight: Map<string, Set<Promise<void>>>
    }

    await manager.cleanup()

    expect(disposalCalls).toBe(2)
    expect(runtime.runtimeDisposalBarriers.has(managed.id)).toBe(false)
    expect(runtime.runtimeDisposalsInFlight.has(managed.id)).toBe(false)
  })

  it('fails cleanup explicitly when a detached runtime destructor remains unproven', async () => {
    const { manager, managed } = await managedSession('Shutdown disposal failure')
    let disposalCalls = 0
    managed.agent = {
      dispose: () => undefined,
      disposeForRestart: async () => {
        disposalCalls += 1
        throw new Error('fixture persistent shutdown disposal failure')
      },
    } as never

    await expect(manager.cleanup()).rejects.toThrow(
      'Shutdown could not prove destruction of every session runtime',
    )
    expect(disposalCalls).toBe(2)
  })

  it('remains fail-closed after the drain deadline until the admitted lease finishes', async () => {
    const { manager, managed } = await managedSession('Shutdown drain deadline')
    const runtime = manager as unknown as {
      trackSessionOperation: <T>(candidate: typeof managed, operation: () => Promise<T>) => Promise<T>
    }
    let releaseOperation!: () => void
    const operationGate = new Promise<void>(resolve => { releaseOperation = resolve })
    let notifyOperationStarted!: () => void
    const operationStarted = new Promise<void>(resolve => { notifyOperationStarted = resolve })
    let operationFinished = false
    const operation = runtime.trackSessionOperation(managed, async () => {
      notifyOperationStarted()
      await operationGate
      operationFinished = true
    })
    await operationStarted

    let clockTick = 0
    Date.now = () => originalDateNow() + clockTick++ * 10_000
    let cleanupSettled = false
    const cleanupResult = manager.cleanup().then(
      () => ({ error: undefined as unknown }),
      error => ({ error }),
    ).finally(() => { cleanupSettled = true })
    try {
      await new Promise<void>(resolve => setTimeout(resolve, 30))
      expect(cleanupSettled).toBe(false)
    } finally {
      Date.now = originalDateNow
      releaseOperation()
    }

    await operation
    const { error } = await cleanupResult
    expect(operationFinished).toBe(true)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain(
      'Shutdown session operation drain timed out before runtime destruction was proven',
    )
  })

  it('continues teardown when a watcher stop throws and keeps admission closed', async () => {
    const { root, manager, managed } = await managedSession('Shutdown watcher failure')
    const runtime = manager as unknown as {
      configWatchers: Map<string, { stop: () => void }>
    }
    let disposalCalls = 0
    managed.agent = {
      dispose: () => undefined,
      disposeForRestart: async () => { disposalCalls += 1 },
    } as never
    runtime.configWatchers.set(root, {
      stop: () => { throw new Error('fixture watcher stop failure') },
    })

    await expect(manager.cleanup()).rejects.toThrow('fixture watcher stop failure')

    expect(disposalCalls).toBeGreaterThanOrEqual(1)
    expect(runtime.configWatchers.size).toBe(0)
    await expect(manager.restartAgentRuntime(managed.id))
      .rejects.toThrow('session manager is shutting down')
  })

  it('rejects every covered public asynchronous admission after shutdown', async () => {
    const { manager, managed } = await managedSession('Shutdown public admissions')
    await manager.cleanup()

    const admissions = [
      () => manager.bindSpecializedMissionCapabilityLock(managed.id, {} as never),
      () => manager.claimAndResumePendingMissionTurn(managed.id, {} as never),
      () => manager.refreshConnectionRuntime('fixture-connection'),
      () => manager.refreshWorkspaceExternalActionPolicy(managed.workspace.id, {} as never),
      () => manager.restartAgentRuntime(managed.id),
      () => manager.cancelProcessingAndWait(managed.id, 10),
      () => manager.killShell(managed.id, 'fixture-shell'),
      () => manager.adoptGeneratedTaskOrchestrator(managed.id, 'fixture-task'),
      () => manager.bindExistingSessionToTask(managed.id, 'fixture-task'),
      () => manager.executePromptAutomation({} as never),
    ]
    for (const admit of admissions) {
      await expect(admit()).rejects.toThrow('session manager is shutting down')
    }
  })
})
