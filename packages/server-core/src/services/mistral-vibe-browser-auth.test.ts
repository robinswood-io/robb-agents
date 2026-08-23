import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import {
  buildMistralVibeEnvironment,
  resolveMistralVibeAcpCommand,
  startMistralVibeBrowserAuth,
} from './mistral-vibe-browser-auth.ts'

interface FakeRpcRequest {
  id: string | number
  method?: string
  params?: {
    action?: string
    clientCapabilities?: { _meta?: Record<string, unknown> }
    [key: string]: unknown
  }
}

class FakeVibeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  killed = false
  received: FakeRpcRequest[] = []
  private buffer = ''

  constructor(private readonly delegatedAuth = true) {
    super()
    this.stdin.on('data', (chunk) => {
      this.buffer += chunk.toString()
      while (this.buffer.includes('\n')) {
        const newline = this.buffer.indexOf('\n')
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line) this.handle(JSON.parse(line) as FakeRpcRequest)
      }
    })
    queueMicrotask(() => this.emit('spawn'))
  }

  kill(): boolean {
    this.killed = true
    this.exitCode = 0
    this.emit('exit', 0)
    return true
  }

  private respond(id: string | number, result: Record<string, unknown>) {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  private handle(message: FakeRpcRequest) {
    this.received.push(message)
    if (message.method === 'initialize') {
      this.respond(message.id, {
        protocolVersion: 1,
        agentInfo: { name: '@mistralai/mistral-vibe', version: '2.24.3' },
        agentCapabilities: {},
        authMethods: this.delegatedAuth
          ? [{ id: 'browser-auth-delegated', name: 'Browser sign-in' }]
          : [{ id: 'browser-auth', name: 'Browser sign-in' }],
      })
      return
    }
    if (message.method === 'authenticate' && message.params?.action === 'start') {
      this.respond(message.id, {
        _meta: {
          'browser-auth-delegated': {
            attemptId: 'attempt-123',
            expiresAt: '2026-08-23T20:10:00.000Z',
            signInUrl: 'https://console.mistral.ai/vibe/sign-in/attempt-123',
          },
        },
      })
      return
    }
    if (message.method === 'authenticate' && message.params?.action === 'complete') {
      this.respond(message.id, {
        _meta: {
          'browser-auth-delegated': {
            attemptId: 'attempt-123',
            status: 'completed',
          },
        },
      })
    }
  }
}

describe('Mistral Vibe delegated browser authentication', () => {
  it('resolves the uv tool path and strips ambient provider secrets', () => {
    const environment = {
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      MISTRAL_API_KEY: 'must-not-be-forwarded',
      ROBB_VIBE_ACP_COMMAND: '',
      HTTPS_PROXY: 'https://proxy.example.test',
    }
    expect(resolveMistralVibeAcpCommand(environment, 'darwin', path => path.endsWith('vibe-acp')))
      .toBe('/Users/tester/.local/bin/vibe-acp')
    expect(buildMistralVibeEnvironment(environment, 'darwin')).toEqual({
      HOME: '/Users/tester',
      PATH: '/usr/bin:/bin',
      HTTPS_PROXY: 'https://proxy.example.test',
    })
  })

  it('starts and completes the official delegated browser flow', async () => {
    const child = new FakeVibeProcess()
    const flow = await startMistralVibeBrowserAuth({
      command: '/test/vibe-acp',
      spawnImpl: (() => child as unknown as ChildProcess),
      now: () => Date.parse('2026-08-23T20:00:00.000Z'),
    })

    expect(flow.authUrl).toBe('https://console.mistral.ai/vibe/sign-in/attempt-123')
    expect(child.received[0]?.params?.clientCapabilities?._meta?.['browser-auth-delegated']).toBe(true)
    expect(child.received[1]?.params).toEqual({
      methodId: 'browser-auth-delegated',
      action: 'start',
      signInTarget: 'mistral',
    })

    await flow.complete()
    expect(child.received[2]?.params).toEqual({
      methodId: 'browser-auth-delegated',
      action: 'complete',
      attemptId: 'attempt-123',
    })
    flow.close()
    expect(child.killed).toBe(true)
  })

  it('fails closed when an installed Vibe is too old for delegated auth', async () => {
    const child = new FakeVibeProcess(false)
    await expect(startMistralVibeBrowserAuth({
      command: '/test/vibe-acp',
      spawnImpl: (() => child as unknown as ChildProcess),
    })).rejects.toThrow('must be updated')
    expect(child.killed).toBe(true)
  })
})
