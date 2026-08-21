import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  PiAgent,
  resolvePiSubprocessStartupTimeoutMs,
} from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

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
