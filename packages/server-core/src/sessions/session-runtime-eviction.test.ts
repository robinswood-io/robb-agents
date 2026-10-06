import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('session runtime eviction', () => {
  const previousTimeout = process.env.CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS

  beforeEach(() => {
    process.env.CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS = '60000'
  })

  afterEach(() => {
    if (previousTimeout === undefined) {
      delete process.env.CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS
    } else {
      process.env.CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS = previousTimeout
    }
  })

  function addRuntime(
    manager: SessionManager,
    id: string,
    options: {
      processing?: boolean
      runningTask?: boolean
      lastActiveAt?: number
      disposeForRestart?: () => Promise<void>
    } = {},
  ) {
    const workspace = {
      id: 'ws_runtime_eviction',
      name: 'Runtime eviction',
      rootPath: '/tmp/runtime-eviction',
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: id },
      workspace as never,
      { messagesLoaded: true },
    )
    const disposeForRestart = jest.fn(options.disposeForRestart ?? (async () => undefined))
    const stop = jest.fn(async () => undefined)
    const disconnectAll = jest.fn(async () => undefined)

    managed.agent = {
      disposeForRestart,
      dispose: () => undefined,
    } as never
    managed.poolServer = { stop } as never
    managed.mcpPool = { disconnectAll } as never
    managed.isProcessing = options.processing ?? false
    managed.runtimeLastActiveAt = options.lastActiveAt ?? 0
    if (options.runningTask) {
      managed.backgroundTaskRegistry.set('task-live', {
        taskId: 'task-live',
        startTime: Date.now(),
        status: 'running',
      })
    }

    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return { managed, disposeForRestart, stop, disconnectAll }
  }

  it('releases the agent, pool server and MCP clients for an idle session', async () => {
    const manager = new SessionManager()
    const runtime = addRuntime(manager, 'idle', { lastActiveAt: 1 })

    const evicted = await (manager as unknown as {
      evictIdleSessionRuntimes: (now: number) => Promise<number>
    }).evictIdleSessionRuntimes(60_002)

    expect(evicted).toBe(1)
    expect(runtime.disposeForRestart).toHaveBeenCalledTimes(1)
    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(runtime.disconnectAll).toHaveBeenCalledTimes(1)
    expect(runtime.managed.agent).toBeNull()
    expect(runtime.managed.poolServer).toBeUndefined()
    expect(runtime.managed.mcpPool).toBeUndefined()
  })

  it('releases default idle runtimes after five minutes while preserving conversation state', async () => {
    delete process.env.CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS
    const manager = new SessionManager()
    const runtime = addRuntime(manager, 'default-idle', { lastActiveAt: 1 })
    const messages = [{ id: 'message-1', role: 'user' as const, content: 'Keep this conversation', timestamp: 1 }]
    runtime.managed.messages = messages
    runtime.managed.sdkSessionId = 'persisted-provider-session'
    const sweep = (now: number) => (manager as unknown as {
      evictIdleSessionRuntimes: (now: number) => Promise<number>
    }).evictIdleSessionRuntimes(now)

    expect(await sweep(5 * 60_000)).toBe(0)
    expect(await sweep(5 * 60_000 + 1)).toBe(1)
    expect(runtime.managed.messages).toBe(messages)
    expect(runtime.managed.messagesLoaded).toBe(true)
    expect(runtime.managed.sdkSessionId).toBe('persisted-provider-session')
    expect(runtime.disconnectAll).toHaveBeenCalledTimes(1)
  })

  it('honors explicitly disabled runtime eviction', async () => {
    process.env.CRAFT_SESSION_RUNTIME_IDLE_TIMEOUT_MS = '0'
    const manager = new SessionManager()
    const runtime = addRuntime(manager, 'keep-runtime')
    expect(await (manager as unknown as {
      evictIdleSessionRuntimes: (now: number) => Promise<number>
    }).evictIdleSessionRuntimes(60 * 60_000)).toBe(0)
    expect(runtime.disposeForRestart).not.toHaveBeenCalled()
  })

  it('keeps runtimes with queued messages or an ongoing configuration refresh', async () => {
    const manager = new SessionManager()
    const queued = addRuntime(manager, 'queued')
    queued.managed.messageQueue.push({ message: 'next turn' } as never)
    const refreshing = addRuntime(manager, 'refreshing')
    ;(manager as unknown as { agentRefreshLocks: Map<string, Promise<void>> })
      .agentRefreshLocks.set('refreshing', Promise.resolve())

    expect(await (manager as unknown as {
      evictIdleSessionRuntimes: (now: number) => Promise<number>
    }).evictIdleSessionRuntimes(60_002)).toBe(0)
    expect(queued.disposeForRestart).not.toHaveBeenCalled()
    expect(refreshing.disposeForRestart).not.toHaveBeenCalled()
  })

  it('preserves runtimes that are processing or own a running background task', async () => {
    const manager = new SessionManager()
    const processing = addRuntime(manager, 'processing', { processing: true, lastActiveAt: 1 })
    const background = addRuntime(manager, 'background', { runningTask: true, lastActiveAt: 1 })

    const evicted = await (manager as unknown as {
      evictIdleSessionRuntimes: (now: number) => Promise<number>
    }).evictIdleSessionRuntimes(60_002)

    expect(evicted).toBe(0)
    expect(processing.disposeForRestart).not.toHaveBeenCalled()
    expect(background.disposeForRestart).not.toHaveBeenCalled()
  })

  it('detaches a stale runtime before awaiting its slow subprocess shutdown', async () => {
    const manager = new SessionManager()
    let releaseDisposal!: () => void
    const disposalGate = new Promise<void>(resolve => { releaseDisposal = resolve })
    const runtime = addRuntime(manager, 'replace-during-disposal', {
      disposeForRestart: () => disposalGate,
    })

    const disposal = (manager as unknown as {
      disposeManagedAgentRuntime: (managed: unknown, reason: string) => Promise<void>
    }).disposeManagedAgentRuntime(runtime.managed, 'test replacement race')

    await Promise.resolve()
    expect(runtime.managed.agent).toBeNull()
    expect(runtime.managed.poolServer).toBeUndefined()
    expect(runtime.managed.mcpPool).toBeUndefined()

    const replacementAgent = { dispose: jest.fn() }
    runtime.managed.agent = replacementAgent as never
    releaseDisposal()
    await disposal

    expect((runtime.managed as unknown as { agent: unknown }).agent).toBe(replacementAgent)
    expect(replacementAgent.dispose).not.toHaveBeenCalled()
  })

  it('rechecks later eviction batches when a session becomes active mid-sweep', async () => {
    const manager = new SessionManager()
    let releaseFirstBatch!: () => void
    const firstBatchGate = new Promise<void>(resolve => { releaseFirstBatch = resolve })
    const firstBatch = Array.from({ length: 4 }, (_unused, index) => addRuntime(
      manager,
      `slow-${index}`,
      { lastActiveAt: 1, disposeForRestart: () => firstBatchGate },
    ))
    const newlyActive = addRuntime(manager, 'newly-active', { lastActiveAt: 1 })

    const sweep = (manager as unknown as {
      evictIdleSessionRuntimes: (now: number) => Promise<number>
    }).evictIdleSessionRuntimes(60_002)

    await Promise.resolve()
    await Promise.resolve()
    expect(firstBatch.every(runtime => runtime.disposeForRestart.mock.calls.length === 1)).toBe(true)
    newlyActive.managed.isProcessing = true
    releaseFirstBatch()

    expect(await sweep).toBe(4)
    expect(newlyActive.disposeForRestart).not.toHaveBeenCalled()
    expect(newlyActive.managed.agent).not.toBeNull()
  })

  it('disposes every session runtime during shutdown', async () => {
    const manager = new SessionManager()
    const first = addRuntime(manager, 'first')
    const second = addRuntime(manager, 'second')

    await manager.cleanup()

    expect(first.disposeForRestart).toHaveBeenCalledTimes(1)
    expect(second.disposeForRestart).toHaveBeenCalledTimes(1)
    expect(first.disconnectAll).toHaveBeenCalledTimes(1)
    expect(second.disconnectAll).toHaveBeenCalledTimes(1)
  })
})
