import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RequestContext } from '../../transport/types'
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
