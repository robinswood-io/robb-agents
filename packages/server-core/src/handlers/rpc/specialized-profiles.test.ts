import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS, type PushTarget } from '@craft-agent/shared/protocol'
import type {
  SpecializedProfileRegistryDocument,
  SpecializedProfileRegistryMutationResult,
} from '@craft-agent/shared/specialized-profiles'
import { detectSpecializationOpportunities } from '@craft-agent/shared/specialized-profiles'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types.ts'
import { registerSpecializedProfileHandlers } from './specialized-profiles.ts'

const context: RequestContext = {
  clientId: 'client-1',
  workspaceId: 'workspace-1',
  webContentsId: null,
  actorId: 'local-owner',
  roles: ['owner'],
  authorizationGeneration: 1,
  allowedWorkspaceIds: '*',
}

function registry(revision = 0): SpecializedProfileRegistryDocument {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    revision,
    updatedAt: '2026-09-17T08:00:00.000Z',
    updatedBy: 'local-owner',
    profiles: [],
  }
}

function harness(reconcileOnRead = false) {
  const handlers = new Map<string, HandlerFn>()
  const pushes: Array<{ channel: string; target: PushTarget; args: unknown[] }> = []
  const server: RpcServer = {
    handle: (channel, handler) => { handlers.set(channel, handler) },
    push: (channel, target, ...args) => { pushes.push({ channel, target, args }) },
    invokeClient: async () => undefined,
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const calls: string[] = []
  const mutation: SpecializedProfileRegistryMutationResult = {
    registry: registry(2),
    profileId: 'specialist-accounting-123456789abc',
  }
  const service = {
    analyze: async () => {
      calls.push('analyze')
      return {
        report: detectSpecializationOpportunities([]),
        analyzedMissionIds: [],
        excludedMissionCount: 0,
        generatedAt: '2026-09-17T08:00:00.000Z',
      }
    },
    getRegistry: async (
      _workspaceId: string,
      _actorId: string,
      onReconciled?: (value: SpecializedProfileRegistryDocument) => void,
    ) => {
      calls.push('getRegistry')
      const value = registry(reconcileOnRead ? 3 : 0)
      if (reconcileOnRead) onReconciled?.(value)
      return value
    },
    createDraft: async () => { calls.push('createDraft'); return mutation },
    transition: async () => { calls.push('transition'); return mutation },
    recordEvaluation: async () => { calls.push('recordEvaluation'); return mutation },
    rollback: async () => { calls.push('rollback'); return mutation },
  }
  const authorizations: string[] = []
  registerSpecializedProfileHandlers(
    server,
    service as Parameters<typeof registerSpecializedProfileHandlers>[1],
    (_ctx, workspaceId, action) => {
      expect(workspaceId).toBe('workspace-1')
      authorizations.push(action)
    },
  )
  return { handlers, pushes, calls, authorizations }
}

describe('specialized profile RPC', () => {
  it('authorizes analysis as a Mission read', async () => {
    const { handlers, calls, authorizations } = harness()
    const result = await handlers.get(RPC_CHANNELS.specializedProfiles.ANALYZE)!(
      context,
      'workspace-1',
    )
    expect(result.analyzedMissionIds).toEqual([])
    expect(authorizations).toEqual(['mission.read'])
    expect(calls).toEqual(['analyze'])
  })

  it('validates a draft request, mutates only after playbook.update, and pushes an invalidation', async () => {
    const { handlers, pushes, calls, authorizations } = harness()
    const result = await handlers.get(RPC_CHANNELS.specializedProfiles.CREATE_DRAFT)!(
      context,
      'workspace-1',
      { proposalId: 'profile:bounded-accounting', expectedRegistryRevision: 0 },
    )
    expect(result.profileId).toBe('specialist-accounting-123456789abc')
    expect(authorizations).toEqual(['playbook.update'])
    expect(calls).toEqual(['createDraft'])
    expect(pushes).toEqual([{
      channel: RPC_CHANNELS.specializedProfiles.CHANGED,
      target: { to: 'workspace', workspaceId: 'workspace-1' },
      args: ['workspace-1', 2],
    }])
  })

  it('pushes a minimal invalidation when a read reconciles expired qualification', async () => {
    const { handlers, pushes, calls, authorizations } = harness(true)
    const result = await handlers.get(RPC_CHANNELS.specializedProfiles.GET_REGISTRY)!(
      context,
      'workspace-1',
    )
    expect(result.revision).toBe(3)
    expect(authorizations).toEqual(['playbook.read'])
    expect(calls).toEqual(['getRegistry'])
    expect(pushes).toEqual([{
      channel: RPC_CHANNELS.specializedProfiles.CHANGED,
      target: { to: 'workspace', workspaceId: 'workspace-1' },
      args: ['workspace-1', 3],
    }])
  })

  it('rejects promotion until a distinct host-attested approval flow exists', async () => {
    const { handlers, calls, authorizations } = harness()
    await expect(handlers.get(RPC_CHANNELS.specializedProfiles.TRANSITION)!(
      context,
      'workspace-1',
      {
        profileId: 'specialist-accounting-123456789abc',
        expectedRegistryRevision: 2,
        expectedCurrentVersion: 1,
        to: 'opt-in',
        reason: 'Qualified shadow evaluation reviewed by a human.',
        evaluationIds: ['shadow-eval-1'],
      },
    )).rejects.toThrow('distinct host-attested human approval flow')
    expect(authorizations).toEqual(['playbook.update'])
    expect(calls).toEqual([])
  })

  it('rejects unexpected request fields before calling the service', async () => {
    const { handlers, calls } = harness()
    await expect(handlers.get(RPC_CHANNELS.specializedProfiles.CREATE_DRAFT)!(
      context,
      'workspace-1',
      { proposalId: 'proposal-1', expectedRegistryRevision: 0, activate: true },
    )).rejects.toThrow('Unexpected profile draft request fields')
    expect(calls).toEqual([])
  })
})
