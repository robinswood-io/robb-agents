import { describe, expect, it, jest } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  PiAgent,
  PI_SUBPROCESS_FORCE_KILL_DELAY_MS,
  resolvePiSubprocessStartupTimeoutMs,
} from '../pi-agent.ts'
import { AbortReason, type BackendConfig } from '../backend/types.ts'

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/craft-agent-test',
    } as never,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  }
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  })
  return child
}

describe('PiAgent process recovery', () => {
  it('uses a bounded startup timeout and rejects invalid overrides', () => {
    expect(resolvePiSubprocessStartupTimeoutMs(undefined)).toBe(20_000)
    expect(resolvePiSubprocessStartupTimeoutMs('2500')).toBe(2_500)
    expect(resolvePiSubprocessStartupTimeoutMs('999999')).toBe(120_000)
    expect(resolvePiSubprocessStartupTimeoutMs('0')).toBe(20_000)
    expect(resolvePiSubprocessStartupTimeoutMs('invalid')).toBe(20_000)
  })

  it('emits a resumable interruption and rejects a pending ready handshake on crash', async () => {
    const agent = new PiAgent(createConfig())
    const child = fakeChild(101)
    const events: unknown[] = []
    let completed = false
    const readyFailure = new Promise<void>((_resolve, reject) => {
      const internals = agent as unknown as {
        subprocess: ChildProcess | null
        subprocessReady: Promise<void> | null
        subprocessReadyReject: ((error: Error) => void) | null
        _isProcessing: boolean
        eventQueue: { enqueue: (event: unknown) => void; complete: () => void }
      }
      internals.subprocess = child
      internals.subprocessReadyReject = reject
      internals._isProcessing = true
      internals.eventQueue.enqueue = event => events.push(event)
      internals.eventQueue.complete = () => { completed = true }
    })

    ;(agent as unknown as {
      handleSubprocessExit: (code: number | null, signal: string | null, child: ChildProcess) => void
    }).handleSubprocessExit(null, 'SIGSEGV', child)

    await expect(readyFailure).rejects.toThrow('Pi subprocess exited unexpectedly')
    expect(events).toEqual([{
      type: 'runtime_interrupted',
      message: 'Pi subprocess exited unexpectedly (signal SIGSEGV)',
      code: 'process_exit',
      exitCode: null,
      signal: 'SIGSEGV',
    }])
    expect(completed).toBe(true)
    expect((agent as unknown as { subprocess: ChildProcess | null }).subprocess).toBeNull()
    agent.destroy()
  })

  it('ignores a late exit from an older generation after replacement', () => {
    const agent = new PiAgent(createConfig())
    const staleChild = fakeChild(101)
    const currentChild = fakeChild(202)
    const events: unknown[] = []
    const internals = agent as unknown as {
      subprocess: ChildProcess | null
      _isProcessing: boolean
      eventQueue: { enqueue: (event: unknown) => void }
      handleSubprocessExit: (code: number | null, signal: string | null, child: ChildProcess) => void
    }
    internals.subprocess = currentChild
    internals._isProcessing = true
    internals.eventQueue.enqueue = event => events.push(event)

    internals.handleSubprocessExit(1, null, staleChild)

    expect(internals.subprocess).toBe(currentChild)
    expect(events).toEqual([])
    agent.destroy()
  })

  it('confirms teardown for the exiting runtime without touching its replacement', () => {
    const agent = new PiAgent(createConfig())
    const staleChild = fakeChild(111)
    const currentChild = fakeChild(222)
    const staleRuntime = { runtimeId: 'pi-runtime-stale', sessionId: 'session-test' }
    const currentRuntime = { runtimeId: 'pi-runtime-current', sessionId: 'session-test' }
    const confirmed: Array<{ runtimeId: string; sessionId: string }> = []
    const internals = agent as unknown as {
      subprocess: ChildProcess | null
      subprocessRuntimeContext: { runtimeId: string; sessionId: string } | null
      subprocessRuntimeContexts: WeakMap<ChildProcess, { runtimeId: string; sessionId: string }>
      confirmContextualGmailRuntimeTeardown: (runtime: { runtimeId: string; sessionId: string }) => boolean
      handleSubprocessExit: (
        code: number | null,
        signal: string | null,
        child: ChildProcess,
        processError?: Error,
        runtime?: { runtimeId: string; sessionId: string },
      ) => void
    }
    internals.subprocess = currentChild
    internals.subprocessRuntimeContext = currentRuntime
    internals.subprocessRuntimeContexts.set(staleChild, staleRuntime)
    internals.confirmContextualGmailRuntimeTeardown = runtime => {
      confirmed.push(runtime)
      return true
    }

    internals.handleSubprocessExit(0, null, staleChild, undefined, staleRuntime)

    expect(confirmed).toEqual([staleRuntime])
    expect(internals.subprocess).toBe(currentChild)
    expect(internals.subprocessRuntimeContext).toEqual(currentRuntime)
    agent.destroy()
  })

  it('retains the active child and Gmail runtime after process error without exit', async () => {
    const agent = new PiAgent(createConfig())
    const child = fakeChild(231)
    const runtime = { runtimeId: 'pi-runtime-error-pending', sessionId: 'session-test' }
    const confirmed: Array<{ runtimeId: string; sessionId: string }> = []
    let rejectReady!: (error: Error) => void
    const readyFailure = new Promise<void>((_resolve, reject) => { rejectReady = reject })
    const internals = agent as unknown as {
      subprocess: ChildProcess | null
      subprocessRuntimeContext: { runtimeId: string; sessionId: string } | null
      subprocessRuntimeContexts: WeakMap<ChildProcess, { runtimeId: string; sessionId: string }>
      subprocessReadyReject: ((error: Error) => void) | null
      confirmContextualGmailRuntimeTeardown: (runtime: { runtimeId: string; sessionId: string }) => boolean
      handleSubprocessError: (
        error: Error,
        child: ChildProcess,
        runtime?: { runtimeId: string; sessionId: string },
      ) => void
    }
    internals.subprocess = child
    internals.subprocessRuntimeContext = runtime
    internals.subprocessRuntimeContexts.set(child, runtime)
    internals.subprocessReadyReject = rejectReady
    internals.confirmContextualGmailRuntimeTeardown = context => {
      confirmed.push(context)
      return true
    }

    internals.handleSubprocessError(new Error('child process error'), child, runtime)

    await expect(readyFailure).rejects.toThrow('Pi subprocess error (child process error)')
    expect(internals.subprocess).toBe(child)
    expect(internals.subprocessRuntimeContext).toEqual(runtime)
    expect(confirmed).toEqual([])
    agent.destroy()
  })

  it('cleans up and confirms the exact Gmail runtime only after exit follows process error', () => {
    const agent = new PiAgent(createConfig())
    const child = fakeChild(232)
    const runtime = { runtimeId: 'pi-runtime-error-then-exit', sessionId: 'session-test' }
    const confirmed: Array<{ runtimeId: string; sessionId: string }> = []
    const internals = agent as unknown as {
      subprocess: ChildProcess | null
      subprocessRuntimeContext: { runtimeId: string; sessionId: string } | null
      subprocessRuntimeContexts: WeakMap<ChildProcess, { runtimeId: string; sessionId: string }>
      confirmContextualGmailRuntimeTeardown: (runtime: { runtimeId: string; sessionId: string }) => boolean
      handleSubprocessError: (
        error: Error,
        child: ChildProcess,
        runtime?: { runtimeId: string; sessionId: string },
      ) => void
      handleSubprocessExit: (
        code: number | null,
        signal: string | null,
        child: ChildProcess,
        processError?: Error,
        runtime?: { runtimeId: string; sessionId: string },
      ) => void
    }
    internals.subprocess = child
    internals.subprocessRuntimeContext = runtime
    internals.subprocessRuntimeContexts.set(child, runtime)
    internals.confirmContextualGmailRuntimeTeardown = context => {
      confirmed.push(context)
      return true
    }

    internals.handleSubprocessError(new Error('transport watcher failed'), child, runtime)
    expect(confirmed).toEqual([])

    internals.handleSubprocessExit(1, null, child, undefined, runtime)

    expect(internals.subprocess).toBeNull()
    expect(internals.subprocessRuntimeContext).toBeNull()
    expect(confirmed).toEqual([runtime])
    agent.destroy()
  })

  it('confirms an errored stale runtime on exit without touching its replacement', () => {
    const agent = new PiAgent(createConfig())
    const staleChild = fakeChild(233)
    const currentChild = fakeChild(234)
    const staleRuntime = { runtimeId: 'pi-runtime-error-stale', sessionId: 'session-test' }
    const currentRuntime = { runtimeId: 'pi-runtime-error-current', sessionId: 'session-test' }
    const confirmed: Array<{ runtimeId: string; sessionId: string }> = []
    const internals = agent as unknown as {
      subprocess: ChildProcess | null
      subprocessRuntimeContext: { runtimeId: string; sessionId: string } | null
      subprocessRuntimeContexts: WeakMap<ChildProcess, { runtimeId: string; sessionId: string }>
      confirmContextualGmailRuntimeTeardown: (runtime: { runtimeId: string; sessionId: string }) => boolean
      handleSubprocessError: (
        error: Error,
        child: ChildProcess,
        runtime?: { runtimeId: string; sessionId: string },
      ) => void
      handleSubprocessExit: (
        code: number | null,
        signal: string | null,
        child: ChildProcess,
        processError?: Error,
        runtime?: { runtimeId: string; sessionId: string },
      ) => void
    }
    internals.subprocess = staleChild
    internals.subprocessRuntimeContext = staleRuntime
    internals.subprocessRuntimeContexts.set(staleChild, staleRuntime)
    internals.handleSubprocessError(new Error('old runtime error'), staleChild, staleRuntime)

    internals.subprocess = currentChild
    internals.subprocessRuntimeContext = currentRuntime
    internals.subprocessRuntimeContexts.set(currentChild, currentRuntime)
    internals.confirmContextualGmailRuntimeTeardown = context => {
      confirmed.push(context)
      return true
    }

    internals.handleSubprocessExit(1, null, staleChild, undefined, staleRuntime)

    expect(confirmed).toEqual([staleRuntime])
    expect(internals.subprocess).toBe(currentChild)
    expect(internals.subprocessRuntimeContext).toEqual(currentRuntime)
    agent.destroy()
  })

  it('does not confirm Gmail teardown on SIGTERM request before child exit', () => {
    const agent = new PiAgent(createConfig())
    const child = fakeChild(333)
    const runtime = { runtimeId: 'pi-runtime-delayed-exit', sessionId: 'session-test' }
    const confirmed: Array<{ runtimeId: string; sessionId: string }> = []
    const internals = agent as unknown as {
      subprocess: ChildProcess | null
      subprocessRuntimeContext: { runtimeId: string; sessionId: string } | null
      subprocessRuntimeContexts: WeakMap<ChildProcess, { runtimeId: string; sessionId: string }>
      confirmContextualGmailRuntimeTeardown: (context: { runtimeId: string; sessionId: string }) => boolean
      killSubprocess: () => void
      handleSubprocessExit: (
        code: number | null,
        signal: string | null,
        child: ChildProcess,
        processError?: Error,
        runtime?: { runtimeId: string; sessionId: string },
      ) => void
    }
    internals.subprocess = child
    internals.subprocessRuntimeContext = runtime
    internals.subprocessRuntimeContexts.set(child, runtime)
    internals.confirmContextualGmailRuntimeTeardown = context => {
      confirmed.push(context)
      return true
    }

    internals.killSubprocess()
    expect(confirmed).toEqual([])

    internals.handleSubprocessExit(null, 'SIGTERM', child, undefined, runtime)
    expect(confirmed).toEqual([runtime])
    agent.destroy()
  })

  it('escalates an unconfirmed owner stop to SIGKILL without releasing Gmail state early', () => {
    jest.useFakeTimers()
    try {
      const agent = new PiAgent(createConfig())
      const child = fakeChild(334)
      const runtime = { runtimeId: 'pi-runtime-force-kill', sessionId: 'session-test' }
      const signals: string[] = []
      const confirmed: Array<{ runtimeId: string; sessionId: string }> = []
      child.kill = ((signal?: NodeJS.Signals | number) => {
        signals.push(String(signal))
        return true
      }) as ChildProcess['kill']
      const internals = agent as unknown as {
        subprocess: ChildProcess | null
        subprocessRuntimeContext: { runtimeId: string; sessionId: string } | null
        subprocessRuntimeContexts: WeakMap<ChildProcess, { runtimeId: string; sessionId: string }>
        hasContextualGmailInFlightForCurrentRuntime: () => boolean
        invalidateContextualGmailStateForCurrentSession: () => void
        confirmContextualGmailRuntimeTeardown: (context: { runtimeId: string; sessionId: string }) => boolean
        handleSubprocessExit: (
          code: number | null,
          signal: string | null,
          child: ChildProcess,
          processError?: Error,
          runtime?: { runtimeId: string; sessionId: string },
        ) => void
      }
      internals.subprocess = child
      internals.subprocessRuntimeContext = runtime
      internals.subprocessRuntimeContexts.set(child, runtime)
      internals.hasContextualGmailInFlightForCurrentRuntime = () => true
      internals.invalidateContextualGmailStateForCurrentSession = () => {}
      internals.confirmContextualGmailRuntimeTeardown = context => {
        confirmed.push(context)
        return true
      }

      agent.forceAbort(AbortReason.UserStop)
      expect(signals).toEqual(['SIGTERM'])
      expect(confirmed).toEqual([])

      jest.advanceTimersByTime(PI_SUBPROCESS_FORCE_KILL_DELAY_MS)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(confirmed).toEqual([])

      internals.handleSubprocessExit(null, 'SIGKILL', child, undefined, runtime)
      expect(confirmed).toEqual([runtime])
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('never sends a retired generation SIGKILL to its replacement subprocess', () => {
    jest.useFakeTimers()
    try {
      const agent = new PiAgent(createConfig())
      const staleChild = fakeChild(335)
      const currentChild = fakeChild(336)
      const staleRuntime = { runtimeId: 'pi-runtime-retiring', sessionId: 'session-test' }
      const currentRuntime = { runtimeId: 'pi-runtime-replacement', sessionId: 'session-test' }
      const staleSignals: string[] = []
      const currentSignals: string[] = []
      staleChild.kill = ((signal?: NodeJS.Signals | number) => {
        staleSignals.push(String(signal))
        return true
      }) as ChildProcess['kill']
      currentChild.kill = ((signal?: NodeJS.Signals | number) => {
        currentSignals.push(String(signal))
        return true
      }) as ChildProcess['kill']
      const internals = agent as unknown as {
        subprocess: ChildProcess | null
        subprocessRuntimeContext: { runtimeId: string; sessionId: string } | null
        subprocessRuntimeContexts: WeakMap<ChildProcess, { runtimeId: string; sessionId: string }>
        killSubprocess: () => void
      }
      internals.subprocess = staleChild
      internals.subprocessRuntimeContext = staleRuntime
      internals.subprocessRuntimeContexts.set(staleChild, staleRuntime)

      internals.killSubprocess()
      internals.subprocess = currentChild
      internals.subprocessRuntimeContext = currentRuntime
      internals.subprocessRuntimeContexts.set(currentChild, currentRuntime)

      jest.advanceTimersByTime(PI_SUBPROCESS_FORCE_KILL_DELAY_MS)
      expect(staleSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(currentSignals).toEqual([])

      internals.subprocess = null
      internals.subprocessRuntimeContext = null
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('settles pending permissions fail-closed when the active subprocess exits', () => {
    const agent = new PiAgent(createConfig())
    const child = fakeChild(303)
    const decisions: boolean[] = []
    const internals = agent as unknown as {
      subprocess: ChildProcess | null
      pendingPermissions: Map<string, { resolve: (allowed: boolean) => void; toolName: string }>
      handleSubprocessExit: (code: number | null, signal: string | null, child: ChildProcess) => void
    }
    internals.subprocess = child
    internals.pendingPermissions.set('permission-1', {
      resolve: allowed => decisions.push(allowed),
      toolName: 'Bash',
    })

    internals.handleSubprocessExit(0, null, child)

    expect(decisions).toEqual([false])
    expect(internals.pendingPermissions.size).toBe(0)
    agent.destroy()
    expect(decisions).toEqual([false])
  })

  it('settles pending permissions fail-closed when an idle runtime is destroyed', () => {
    const agent = new PiAgent(createConfig())
    const decisions: boolean[] = []
    const internals = agent as unknown as {
      pendingPermissions: Map<string, { resolve: (allowed: boolean) => void; toolName: string }>
    }
    internals.pendingPermissions.set('permission-1', {
      resolve: allowed => decisions.push(allowed),
      toolName: 'Bash',
    })

    agent.destroy()

    expect(decisions).toEqual([false])
    expect(internals.pendingPermissions.size).toBe(0)
  })

  it('tears down instead of issuing a soft abort when Gmail is admitted', async () => {
    const agent = new PiAgent(createConfig())
    let gracefulKills = 0
    const sent: Array<Record<string, unknown>> = []
    const internals = agent as unknown as {
      hasContextualGmailInFlightForCurrentRuntime: () => boolean
      invalidateContextualGmailStateForCurrentSession: () => void
      killSubprocessGracefully: () => Promise<void>
      send: (message: Record<string, unknown>) => void
    }
    internals.hasContextualGmailInFlightForCurrentRuntime = () => true
    internals.invalidateContextualGmailStateForCurrentSession = () => {}
    internals.killSubprocessGracefully = async () => { gracefulKills += 1 }
    internals.send = message => sent.push(message)

    await agent.abort('test')

    expect(gracefulKills).toBe(1)
    expect(sent.some(message => message.type === 'abort')).toBe(false)
    agent.destroy()
  })

  it('deduplicates concurrent cold starts into one spawn attempt', async () => {
    const agent = new PiAgent(createConfig())
    let spawnCalls = 0
    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>(resolve => { releaseSpawn = resolve })
    const internals = agent as unknown as {
      ensureSubprocess: () => Promise<void>
      spawnSubprocess: () => Promise<void>
    }
    internals.spawnSubprocess = async () => {
      spawnCalls += 1
      await spawnGate
    }

    const first = internals.ensureSubprocess()
    const second = internals.ensureSubprocess()
    expect(spawnCalls).toBe(1)

    releaseSpawn()
    await Promise.all([first, second])
    expect(spawnCalls).toBe(1)
    agent.destroy()
  })
})
