import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

function createHarness(sessionWorkspaceId: string | null = 'workspace') {
  const handlers = new Map<string, HandlerFn>()
  let transcriptHydrations = 0
  let permissionStateReads = 0

  const server: RpcServer = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    push: () => {},
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const deps = {
    sessionManager: {
      getSessionWorkspaceId: () => sessionWorkspaceId,
      getSession: async () => {
        transcriptHydrations++
        throw new Error('metadata-only handler crossed the transcript hydration boundary')
      },
      getSessionPermissionModeState: () => {
        permissionStateReads++
        return {
          permissionMode: 'ask',
          modeVersion: 1,
          changedAt: '2026-09-18T00:00:00.000Z',
          changedBy: 'restore',
        }
      },
    },
    oauthFlowStore: {},
    platform: {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    },
  } as unknown as HandlerDeps

  registerSessionsHandlers(server, deps)

  const context: RequestContext = {
    clientId: 'metadata-client',
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

  return {
    context,
    invoke,
    counts: () => ({ transcriptHydrations, permissionStateReads }),
  }
}

describe('session RPC metadata authorization', () => {
  it('reads permission diagnostics without hydrating a cold transcript', async () => {
    const harness = createHarness()

    await expect(harness.invoke(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, 'session-1'))
      .resolves.toMatchObject({ permissionMode: 'ask' })
    expect(harness.counts()).toEqual({ transcriptHydrations: 0, permissionStateReads: 1 })
  })

  it('rejects a cross-workspace request before reading state or transcript content', async () => {
    const harness = createHarness('other-workspace')

    await expect(harness.invoke(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, 'session-1'))
      .rejects.toThrow()
    expect(harness.counts()).toEqual({ transcriptHydrations: 0, permissionStateReads: 0 })
  })
})
