import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS, type MissionProofPassportTrustAnchorDto } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types.ts'
import {
  HANDLED_CHANNELS,
  registerMissionProofPassportHandlers,
} from './missions.ts'

const context: RequestContext = {
  clientId: 'client-1',
  workspaceId: 'workspace-1',
  webContentsId: null,
  actorId: 'local-owner',
  roles: ['owner'],
  authorizationGeneration: 1,
  allowedWorkspaceIds: '*',
}

function captureServer(): { server: RpcServer; handlers: Map<string, HandlerFn> } {
  const handlers = new Map<string, HandlerFn>()
  return {
    handlers,
    server: {
      handle: (channel, handler) => { handlers.set(channel, handler) },
      push: () => {},
      invokeClient: async () => undefined,
      hasClientCapability: () => false,
      findClientsWithCapability: () => [],
    },
  }
}

describe('Mission Proof Passport RPC', () => {
  it('registers the public workspace trust anchor as a handled Mission channel', () => {
    expect(HANDLED_CHANNELS).toContain(RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR)
  })

  it('requires mission.read and returns only the public trust-anchor DTO', async () => {
    const { server, handlers } = captureServer()
    const anchor: MissionProofPassportTrustAnchorDto = {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      algorithm: 'Ed25519',
      publicKeySpki: 'MCowBQYDK2VwAyEA1234567890abcdef',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA1234567890abcdef\n-----END PUBLIC KEY-----\n',
      fingerprintSha256: 'a'.repeat(64),
    }
    const authorizationCalls: Array<{ workspaceId: string; action: string }> = []
    let serviceCalls = 0
    registerMissionProofPassportHandlers(server, {
      getProofPassport: async () => null,
      getProofPassportTrustAnchor: async () => { serviceCalls += 1; return anchor },
      verifyProofPassport: async () => ({ valid: false as const, reason: 'missing' }),
    }, (_ctx, workspaceId, action) => {
      authorizationCalls.push({ workspaceId, action })
    })

    const handler = handlers.get(RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR)
    expect(handler).toBeDefined()
    expect(await handler!(context, 'workspace-1')).toEqual(anchor)
    expect(authorizationCalls).toEqual([{ workspaceId: 'workspace-1', action: 'mission.read' }])
    expect(serviceCalls).toBe(1)
    expect(JSON.stringify(anchor)).not.toContain('PRIVATE KEY')
  })

  it('does not resolve the anchor when authorization fails', async () => {
    const { server, handlers } = captureServer()
    let serviceCalls = 0
    registerMissionProofPassportHandlers(server, {
      getProofPassport: async () => null,
      getProofPassportTrustAnchor: async () => {
        serviceCalls += 1
        throw new Error('must not run')
      },
      verifyProofPassport: async () => ({ valid: false as const, reason: 'missing' }),
    }, () => { throw new Error('mission.read denied') })

    const handler = handlers.get(RPC_CHANNELS.missions.GET_PASSPORT_TRUST_ANCHOR)!
    await expect(handler(context, 'workspace-1')).rejects.toThrow('mission.read denied')
    expect(serviceCalls).toBe(0)
  })
})
