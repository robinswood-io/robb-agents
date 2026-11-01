import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { CallbackPayload, CallbackServer, CreateCallbackServerOptions } from '@craft-agent/shared/auth/callback-server'
import type { RpcClient } from '@craft-agent/server-core/transport'

// The official runner executes this file in its own Bun process so native
// Electron and callback-server replacements cannot affect other suites.
const openedUrls: string[] = []
const callbackServers: Array<{ closes: number; options?: CreateCallbackServerOptions | undefined }> = []
let callbackQuery: CallbackPayload['query'] = {}
let bindFailure: unknown
let pendingCallback = false

mock.module('electron', () => ({
  shell: {
    async openExternal(url: string): Promise<void> { openedUrls.push(url) },
  },
}))

const callbackModule = await import('@craft-agent/shared/auth/callback-server')
const callbackSpy = spyOn(callbackModule, 'createCallbackServer').mockImplementation(
  async (options?: CreateCallbackServerOptions | undefined): Promise<CallbackServer> => {
    if (bindFailure !== undefined) throw bindFailure
    const record = { closes: 0, options }
    callbackServers.push(record)
    return {
      url: 'http://127.0.0.1:1455',
      promise: pendingCallback
        ? new Promise<CallbackPayload>(() => {})
        : Promise.resolve({ query: { ...callbackQuery } }),
      close() { record.closes += 1 },
    }
  },
)
const { configureOAuthApi } = await import('./oauth-api.ts')
type OAuthApi = Parameters<typeof configureOAuthApi>[0]

beforeEach(() => {
  openedUrls.length = 0
  callbackServers.length = 0
  bindFailure = undefined
  pendingCallback = false
  callbackQuery = { code: 'provider-code', state: 'expected-state' }
})
afterAll(() => { callbackSpy.mockRestore() })

function fixture(authUrl = 'https://auth.example.test/authorize', replies: Record<string, unknown> = {}) {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const starts = new Set([
    'oauth:start', 'chatgpt:startOAuth', 'gemini:startOAuth',
    'onboarding:startClaudeOAuth', 'onboarding:startMistralVibeSetup',
  ])
  const completions = new Set([
    'oauth:complete', 'chatgpt:completeOAuth', 'gemini:completeOAuth',
    'onboarding:completeMistralVibeSetup',
  ])
  const cancellations = new Set([
    'oauth:cancel', 'chatgpt:cancelOAuth', 'gemini:cancelOAuth',
    'onboarding:cancelMistralVibeSetup',
  ])
  const client: RpcClient = {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      if (Object.hasOwn(replies, channel)) return replies[channel]
      if (starts.has(channel)) {
        return { success: true, flowId: 'flow-a', state: 'expected-state', authUrl }
      }
      if (completions.has(channel)) return { success: true, email: 'fixture@example.test' }
      if (cancellations.has(channel)) return { success: true }
      throw new Error(`Unexpected OAuth channel: ${channel}`)
    },
    on: () => () => {},
    handleCapability: () => {},
  }
  const api: OAuthApi = {
    performOAuth: async () => ({ success: false }),
    startClaudeOAuth: async () => ({ success: false }),
    startMistralVibeSetup: async () => ({ success: false }),
    startChatGptOAuth: async () => ({ success: false }),
    startGeminiOAuth: async () => ({ success: false }),
  }
  configureOAuthApi(api, client)
  return { api, calls }
}

for (const provider of ['chatgpt', 'gemini'] as const) {
  const method = provider === 'chatgpt' ? 'startChatGptOAuth' : 'startGeminiOAuth'

  describe(`${provider} local OAuth lifecycle`, () => {
    it('completes the callback, exchange and cleanup through the configured API', async () => {
      const { api, calls } = fixture()
      expect((await api[method]('connection-a')).success).toBe(true)
      expect(openedUrls).toEqual(['https://auth.example.test/authorize'])
      expect(calls.find(call => call.channel === `${provider}:completeOAuth`)?.args).toEqual([
        { flowId: 'flow-a', code: 'provider-code', state: 'expected-state' },
      ])
      expect(calls.some(call => call.channel === `${provider}:cancelOAuth`)).toBe(false)
      expect(callbackServers.map(server => server.closes)).toEqual([1])
    })

    it('cancels a provider denial without exchanging credentials', async () => {
      callbackQuery = { error: 'access_denied', error_description: 'Consent refused', state: 'expected-state' }
      const { api, calls } = fixture()
      expect(await api[method]('connection-a')).toEqual({ success: false, error: 'Consent refused' })
      expect(calls.some(call => call.channel === `${provider}:completeOAuth`)).toBe(false)
      expect(calls.filter(call => call.channel === `${provider}:cancelOAuth`)).toHaveLength(1)
      expect(callbackServers.map(server => server.closes)).toEqual([1])
    })

    it('rejects a callback with no code and releases the callback server', async () => {
      callbackQuery = { state: 'expected-state' }
      const { api, calls } = fixture()
      expect(await api[method]('connection-a')).toEqual({ success: false, error: 'No authorization code received' })
      expect(calls.some(call => call.channel === `${provider}:completeOAuth`)).toBe(false)
      expect(calls.filter(call => call.channel === `${provider}:cancelOAuth`)).toHaveLength(1)
      expect(callbackServers.map(server => server.closes)).toEqual([1])
    })

    for (const kind of ['native-error', 'plain-error-record'] as const) {
      it(`contains an occupied-port ${kind} before opening the browser`, async () => {
        bindFailure = kind === 'native-error'
          ? Object.assign(new Error('Binding failed'), { code: 'EADDRINUSE' })
          : { code: 'EADDRINUSE' }
        const { api, calls } = fixture()
        const result = await api[method]('connection-a')
        expect(result.success).toBe(false)
        expect(result.error).toContain('in use')
        expect(openedUrls).toHaveLength(0)
        expect(calls).toHaveLength(0)
        expect(callbackServers).toHaveLength(0)
      })
    }

    it('accepts a new request after a failed attempt and closes both servers', async () => {
      const { api, calls } = fixture()
      callbackQuery = { error: 'access_denied', state: 'expected-state' }
      expect((await api[method]('connection-a')).success).toBe(false)
      callbackQuery = { code: 'retry-code', state: 'expected-state' }
      expect((await api[method]('connection-a')).success).toBe(true)
      expect(calls.filter(call => call.channel === `${provider}:startOAuth`)).toHaveLength(2)
      expect(calls.filter(call => call.channel === `${provider}:completeOAuth`)).toHaveLength(1)
      expect(callbackServers.map(server => server.closes)).toEqual([1, 1])
    })

    it('rejects malformed start data before opening the browser and permits a new request', async () => {
      const replies: Record<string, unknown> = { [`${provider}:startOAuth`]: { flowId: 'flow-a', authUrl: 'https://auth.example.test' } }
      const { api, calls } = fixture(undefined, replies)
      expect(await api[method]('connection-a')).toEqual({ success: false, error: 'Invalid OAuth start response' })
      expect(openedUrls).toHaveLength(0)
      expect(calls.some(call => call.channel === `${provider}:completeOAuth`)).toBe(false)
      delete replies[`${provider}:startOAuth`]
      expect((await api[method]('connection-a')).success).toBe(true)
      expect(callbackServers.map(server => server.closes)).toEqual([1, 1])
    })

    it('rejects a malformed exchange result and cancels the pending flow', async () => {
      const { api, calls } = fixture(undefined, { [`${provider}:completeOAuth`]: { success: 'true' } })
      expect(await api[method]('connection-a')).toEqual({ success: false, error: 'Invalid OAuth result' })
      expect(calls.filter(call => call.channel === `${provider}:cancelOAuth`)).toHaveLength(1)
      expect(callbackServers.map(server => server.closes)).toEqual([1])
    })

    it('releases a timed-out callback and permits the next request', async () => {
      const nativeTimeout = globalThis.setTimeout
      const acceleratedTimeout = new Proxy(nativeTimeout, {
        apply(target, receiver: unknown, args: unknown[]): unknown {
          const accelerated = [...args]
          if (accelerated[1] === 300_000) accelerated[1] = 1
          return Reflect.apply(target, receiver, accelerated)
        },
      })
      const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(acceleratedTimeout)
      try {
        pendingCallback = true
        const { api, calls } = fixture()
        const result = await api[method]('connection-a')
        expect(result.success).toBe(false)
        expect(result.error).toContain('timed out')
        expect(calls.filter(call => call.channel === `${provider}:cancelOAuth`)).toHaveLength(1)
        pendingCallback = false
        expect((await api[method]('connection-a')).success).toBe(true)
        expect(calls.filter(call => call.channel === `${provider}:completeOAuth`)).toHaveLength(1)
        expect(callbackServers.map(server => server.closes)).toEqual([1, 1])
      } finally {
        timeoutSpy.mockRestore()
      }
    })
  })
}

describe('other configured OAuth entry points', () => {
  it('keeps source and authentication-request correlation through completion', async () => {
    const { api, calls } = fixture()
    const result = await api.performOAuth({ sourceSlug: 'source-a', sessionId: 'session-a', authRequestId: 'request-a' })
    expect<unknown>(result).toEqual({error: undefined,  success: true, email: 'fixture@example.test' })
    expect(calls.find(call => call.channel === 'oauth:start')?.args).toEqual([{
      sourceSlug: 'source-a', sessionId: 'session-a', authRequestId: 'request-a',
      callbackUrl: 'http://127.0.0.1:1455/callback',
    }])
    expect(calls.find(call => call.channel === 'oauth:complete')?.args).toEqual([
      { flowId: 'flow-a', code: 'provider-code', state: 'expected-state' },
    ])
    expect(callbackServers.map(server => server.closes)).toEqual([1])
  })

  it('opens the Claude authorization URL with its unchanged result', async () => {
    const { api, calls } = fixture()
    expect((await api.startClaudeOAuth()).success).toBe(true)
    expect(openedUrls).toEqual(['https://auth.example.test/authorize'])
    expect(calls.map(call => call.channel)).toEqual(['onboarding:startClaudeOAuth'])
    expect(callbackServers).toHaveLength(0)
  })

  it('finishes the Mistral subscription handshake after opening the URL', async () => {
    const { api, calls } = fixture()
    expect((await api.startMistralVibeSetup()).success).toBe(true)
    expect(openedUrls).toEqual(['https://auth.example.test/authorize'])
    expect(calls.map(call => call.channel)).toEqual([
      'onboarding:startMistralVibeSetup', 'onboarding:completeMistralVibeSetup',
    ])
  })

  it('rejects an unsafe Mistral URL and cancels the pending flow', async () => {
    const { api, calls } = fixture('javascript:alert(1)')
    expect((await api.startMistralVibeSetup()).success).toBe(false)
    expect(openedUrls).toHaveLength(0)
    expect(calls.some(call => call.channel === 'onboarding:completeMistralVibeSetup')).toBe(false)
    expect(calls.some(call => call.channel === 'onboarding:cancelMistralVibeSetup')).toBe(true)
  })

  it('rejects an invalid Claude URL field without opening a browser', async () => {
    const { api } = fixture(undefined, { 'onboarding:startClaudeOAuth': { success: true, authUrl: 42 } })
    expect(await api.startClaudeOAuth()).toEqual({ success: false, error: 'Invalid OAuth result field: authUrl' })
    expect(openedUrls).toHaveLength(0)
  })

  it('rejects an invalid Mistral completion and cancels the flow', async () => {
    const { api, calls } = fixture(undefined, { 'onboarding:completeMistralVibeSetup': null })
    expect(await api.startMistralVibeSetup()).toEqual({ success: false, error: 'Invalid OAuth result' })
    expect(calls.some(call => call.channel === 'onboarding:cancelMistralVibeSetup')).toBe(true)
  })
})
