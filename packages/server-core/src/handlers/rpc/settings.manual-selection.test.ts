import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { THINKING_LEVEL_IDS, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSettingsHandlers } from './settings'

function createHarness(updateError?: Error) {
  const handlers = new Map<string, HandlerFn>()
  const modelUpdates: unknown[][] = []
  const reasoningUpdates: ThinkingLevel[] = []
  let thinkingLevel: ThinkingLevel = 'medium'

  const server: RpcServer = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const deps: HandlerDeps = {
    sessionManager: {
      updateSessionModel: async (...args: unknown[]) => {
        modelUpdates.push(args)
        if (updateError) throw updateError
      },
    } as unknown as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    defaultThinkingLevelStore: {
      get: () => thinkingLevel,
      set: (level) => {
        thinkingLevel = level
        reasoningUpdates.push(level)
        return true
      },
    },
  }
  registerSettingsHandlers(server, deps)
  const context: RequestContext = {
    clientId: 'manual-selection-client',
    workspaceId: 'workspace',
    webContentsId: 1,
    actorId: 'owner',
    roles: ['owner'],
    authorizationGeneration: 0,
    allowedWorkspaceIds: ['workspace'],
  }
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return handler(context, ...args)
  }
  return { invoke, handlers, modelUpdates, reasoningUpdates }
}

describe('settings RPC manual model selection', () => {
  it('does not expose automatic routing endpoints', () => {
    const { handlers } = createHarness()

    expect(handlers.has('workspaceSettings:simulateRouting')).toBe(false)
    expect(handlers.has('workspaceSettings:analyzeRoutingShadow')).toBe(false)
  })

  it('forwards the selected connection and model without substitution', async () => {
    const { invoke, modelUpdates } = createHarness()

    await invoke(RPC_CHANNELS.sessions.SET_MODEL, 'session', 'workspace', 'openai/gpt-5', 'my-openrouter')
    await invoke(RPC_CHANNELS.sessions.SET_MODEL, 'session', 'workspace', 'claude-opus-4-6', 'my-anthropic')

    expect(modelUpdates).toEqual([
      ['session', 'workspace', 'openai/gpt-5', 'my-openrouter'],
      ['session', 'workspace', 'claude-opus-4-6', 'my-anthropic'],
    ])
  })

  it('preserves an explicit reset to the configured model', async () => {
    const { invoke, modelUpdates } = createHarness()

    await invoke(RPC_CHANNELS.sessions.SET_MODEL, 'session', 'workspace', null)

    expect(modelUpdates).toEqual([['session', 'workspace', null, undefined]])
  })

  it('propagates a failed manual selection without attempting another connection', async () => {
    const failure = new Error('Selected connection is unavailable')
    const { invoke, modelUpdates } = createHarness(failure)

    await expect(invoke(RPC_CHANNELS.sessions.SET_MODEL, 'session', 'workspace', 'selected-model', 'selected-connection'))
      .rejects.toThrow(failure.message)

    expect(modelUpdates).toEqual([['session', 'workspace', 'selected-model', 'selected-connection']])
  })

  it('persists every explicit reasoning level unchanged', async () => {
    const { invoke, reasoningUpdates } = createHarness()

    for (const level of THINKING_LEVEL_IDS) {
      await invoke(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, level)
      expect(await invoke(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL)).toBe(level)
    }

    expect(reasoningUpdates).toEqual([...THINKING_LEVEL_IDS])
  })

  it('rejects an invalid reasoning choice without changing the stored preference', async () => {
    const { invoke, reasoningUpdates } = createHarness()

    await expect(invoke(RPC_CHANNELS.settings.SET_DEFAULT_THINKING_LEVEL, 'automatic')).rejects.toThrow('Invalid thinking level')

    expect(reasoningUpdates).toEqual([])
    expect(await invoke(RPC_CHANNELS.settings.GET_DEFAULT_THINKING_LEVEL)).toBe('medium')
  })
})
