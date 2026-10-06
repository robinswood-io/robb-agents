import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RequestContext } from '../../transport/types'
import { WsRpcClient } from '../../transport/client'
import { WsRpcServer } from '../../transport/server'
import type { HandlerDeps } from '../../handlers/handler-deps'
import { registerSessionsHandlers } from '../../handlers/rpc/sessions'
import { RemoteDeviceRegistry } from '../remote-device-registry'
import { authorizeWebuiRpcRequest, createWebuiRpcAuthorizer } from '../remote-rpc-policy'

function context(role: 'owner' | 'remote-device'): RequestContext {
  return {
    clientId: 'client-1',
    workspaceId: 'workspace-1',
    webContentsId: null,
    actorId: role === 'owner' ? 'owner' : 'remote-device:device-1',
    roles: [role],
    authorizationGeneration: 1,
    allowedWorkspaceIds: role === 'owner' ? '*' : ['workspace-1'],
  }
}

describe('Remote RPC policy', () => {
  it('allows supervision operations but denies credential, shell, and governance mutations', () => {
    const remote = context('remote-device')
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.sessions.SEND_MESSAGE)).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.onboarding.GET_AUTH_STATE)).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.llmConnections.LIST_WITH_STATUS)).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.releaseNotes.GET_LATEST_VERSION)).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.drafts.GET_ALL)).toBe(true)
    expect(authorizeWebuiRpcRequest(
      remote,
      RPC_CHANNELS.tasks.RESOLVE_APPROVAL,
      ['workspace-1'],
    )).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.missions.GET, ['workspace-1'])).toBe(true)
    expect(authorizeWebuiRpcRequest(
      remote,
      RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR,
      ['workspace-1'],
    )).toBe(true)
    expect(authorizeWebuiRpcRequest(
      remote,
      RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR,
      ['workspace-2'],
    )).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.missions.PREFLIGHT, ['workspace-1'])).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.missions.PREVIEW_REPLAN, ['workspace-1'])).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.missions.REPLAN, ['workspace-1'])).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.missions.REPLAN, ['workspace-2'])).toBe(false)
    expect(authorizeWebuiRpcRequest(
      remote,
      RPC_CHANNELS.missions.RESOLVE_CONNECTOR_APPROVAL,
      ['workspace-1'],
    )).toBe(true)
    expect(authorizeWebuiRpcRequest(
      remote,
      RPC_CHANNELS.missions.RESOLVE_CONNECTOR_APPROVAL,
      ['workspace-2'],
    )).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.missions.CANCEL, ['workspace-1'])).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.missions.CREATE_AND_START, ['workspace-1'])).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.llmConnections.GET_API_KEY)).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.sessions.KILL_SHELL)).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.workspace.GOVERNANCE_UPDATE)).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.preferences.READ)).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.permissions.GET_DEFAULTS)).toBe(false)
  })

  it('rejects explicit workspace arguments outside the paired scope', () => {
    const remote = context('remote-device')
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.sources.GET, ['workspace-1'])).toBe(true)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.sources.GET, ['workspace-2'])).toBe(false)
    expect(authorizeWebuiRpcRequest(remote, RPC_CHANNELS.sources.GET)).toBe(false)
  })

  it('keeps the local owner unrestricted', () => {
    expect(authorizeWebuiRpcRequest(context('owner'), RPC_CHANNELS.settings.SET_SERVER_CONFIG)).toBe(true)
  })

  it('delivers a paired device answer through the real RPC policy and session workspace guard', async () => {
    const registry = new RemoteDeviceRegistry()
    registry.register({ id: 'device-1', name: 'Phone', allowedWorkspaceIds: ['workspace-1'], expiresAt: '2099-01-01T00:00:00.000Z', authorizationGeneration: 1 })
    const remote = context('remote-device')
    const delivered: unknown[][] = []
    const server = new WsRpcServer({
      host: '127.0.0.1', port: 0, requireAuth: true, requireAuthoritativePrincipal: true,
      validateToken: async token => token === 'paired-test-token' ? { ...remote, capabilities: [] } : false,
      authorizeRequest: createWebuiRpcAuthorizer(registry),
    })
    registerSessionsHandlers(server, {
      platform: { logger: {} },
      sessionManager: {
        getSessions: () => [
          { id: 'child-origin', workspaceId: 'workspace-1' },
          { id: 'foreign-origin', workspaceId: 'workspace-2' },
        ],
        getSession: () => { throw new Error('Authorization must happen before hydration') },
        // Only the final business dispatch is substituted; the websocket,
        // paired-device grant, channel policy and session guard are production code.
        respondToUserInput: async (...args: unknown[]) => {
          delivered.push(args)
          return { status: 'accepted', delivery: 'steered' }
        },
      },
    } as unknown as HandlerDeps)
    let client: WsRpcClient | undefined
    try {
      await server.listen()
      client = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { token: 'paired-test-token', workspaceId: 'workspace-1', autoReconnect: false, requestTimeout: 2_000 })
      const response = { requestId: 'input-origin', answers: [{ questionId: 'format', optionIds: ['summary'], text: 'Avec les montants.' }] }
      const result = await client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, 'child-origin', response)
      expect(result).toEqual({ status: 'accepted', delivery: 'steered' })
      expect(delivered).toHaveLength(1)
      expect(delivered[0]?.slice(0, 2)).toEqual(['child-origin', response])
      expect(delivered[0]?.[2]).toEqual({ callerClientId: expect.any(String) })

      // A client-supplied workspace field cannot authorize a different origin.
      await expect(client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, 'foreign-origin', { ...response, workspaceId: 'workspace-1' })).rejects.toThrow('Workspace access denied')
      await expect(client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, 'unknown-origin', response)).rejects.toThrow('Question session not found')
      await expect(client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, 'child-origin', {})).rejects.toThrow('RPC channel denied')
      expect(delivered).toHaveLength(1)

      registry.revoke('device-1')
      await expect(client.invoke(RPC_CHANNELS.sessions.RESPOND_TO_USER_INPUT, 'child-origin', response)).rejects.toThrow('RPC channel denied')
      expect(delivered).toHaveLength(1)
    } finally {
      client?.destroy()
      server.close()
    }
  })

  it('revalidates and revokes an already connected device on every request', () => {
    const registry = new RemoteDeviceRegistry()
    registry.register({
      id: 'device-1',
      name: 'Phone',
      allowedWorkspaceIds: ['workspace-1'],
      expiresAt: '2099-01-01T00:00:00.000Z',
      authorizationGeneration: 1,
    })
    const authorize = createWebuiRpcAuthorizer(registry)
    const remote = context('remote-device')

    expect(authorize(remote, RPC_CHANNELS.sessions.SEND_MESSAGE)).toBe(true)
    expect(registry.revoke('device-1')).toBe(true)
    expect(authorize(remote, RPC_CHANNELS.sessions.SEND_MESSAGE)).toBe(false)
  })
})
