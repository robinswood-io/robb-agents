import { describe, expect, test } from 'bun:test'
import type {
  RemoteSupervisionProfile,
  RemoteSupervisorIdentity,
} from '@craft-agent/shared/remote-supervision'
import {
  RemoteSupervisionService,
  type RemoteSupervisionProfileStore,
} from './remote-supervision-service'

class MemoryRemoteProfileStore implements RemoteSupervisionProfileStore {
  profile: RemoteSupervisionProfile | undefined

  load(): unknown {
    return this.profile
  }

  save(profile: RemoteSupervisionProfile): void {
    this.profile = profile
  }
}

const owner: RemoteSupervisorIdentity = {
  subjectId: 'local-owner',
  role: 'owner',
  allowedActions: ['task.pause', 'task.cancel', 'approval.resolve'],
}

describe('RemoteSupervisionService', () => {
  test('persists explicit consent and restores it in a new service instance', () => {
    const store = new MemoryRemoteProfileStore()
    const service = new RemoteSupervisionService(store)
    expect(service.getState().mode).toBe('local-only')

    service.grant(owner, {
      consentId: 'consent-1',
      fields: ['task.status', 'task.progress'],
      actions: ['task.pause'],
      purpose: 'Team supervision',
      expiresAt: '2026-07-24T12:00:00.000Z',
    }, '2026-07-23T12:00:00.000Z')

    const restored = new RemoteSupervisionService(store)
    expect(restored.getState()).toMatchObject({
      mode: 'remote-metadata',
      consent: {
        consentId: 'consent-1',
        fields: ['task.status', 'task.progress'],
        actions: ['task.pause'],
      },
    })
    expect(store.profile?.audit).toHaveLength(1)
  })

  test('revokes remote access durably and retains the local audit chain', () => {
    const store = new MemoryRemoteProfileStore()
    const service = new RemoteSupervisionService(store)
    service.grant(owner, {
      consentId: 'consent-2',
      fields: ['task.status'],
      actions: ['task.cancel'],
      purpose: 'Incident support',
      expiresAt: '2026-07-24T12:00:00.000Z',
    }, '2026-07-23T12:00:00.000Z')
    service.revoke(owner, 'Incident closed', '2026-07-23T12:30:00.000Z')

    expect(new RemoteSupervisionService(store).getState()).toEqual({
      mode: 'local-only',
      consent: null,
      revokedAt: '2026-07-23T12:30:00.000Z',
      revocationReason: 'Incident closed',
    })
    expect(store.profile?.audit).toHaveLength(2)
  })
})
