import {
  RemoteSupervisionController,
  createDefaultRemoteSupervisionProfile,
  parseRemoteSupervisionProfile,
  type RemoteAction,
  type RemoteSupervisionProfile,
  type RemoteSupervisionState,
  type RemoteSupervisorIdentity,
  type RemoteSyncField,
  type RemoteTaskProjection,
} from '@craft-agent/shared/remote-supervision'

export interface RemoteSupervisionProfileStore {
  load(): unknown
  save(profile: RemoteSupervisionProfile): void
}

export interface GrantRemoteSupervisionInput {
  consentId: string
  fields: RemoteSyncField[]
  actions: RemoteAction[]
  purpose: string
  expiresAt: string
}

export class RemoteSupervisionService {
  constructor(private readonly store: RemoteSupervisionProfileStore) {}

  getProfile(): RemoteSupervisionProfile {
    const stored = this.store.load()
    return stored === undefined || stored === null
      ? createDefaultRemoteSupervisionProfile()
      : parseRemoteSupervisionProfile(stored)
  }

  getState(): RemoteSupervisionState {
    return new RemoteSupervisionController(this.getProfile()).getState()
  }

  grant(
    identity: RemoteSupervisorIdentity,
    input: GrantRemoteSupervisionInput,
    grantedAt = new Date().toISOString(),
  ): RemoteSupervisionProfile {
    const controller = new RemoteSupervisionController(this.getProfile())
    controller.grantConsent({
      identity,
      consentId: input.consentId,
      fields: input.fields,
      actions: input.actions,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
      grantedAt,
    })
    const profile = controller.exportProfile()
    this.store.save(profile)
    return profile
  }

  revoke(
    identity: RemoteSupervisorIdentity,
    reason: string,
    revokedAt = new Date().toISOString(),
  ): RemoteSupervisionProfile {
    const controller = new RemoteSupervisionController(this.getProfile())
    controller.revokeConsent(identity, reason, revokedAt)
    const profile = controller.exportProfile()
    this.store.save(profile)
    return profile
  }

  projectTask(
    snapshot: RemoteTaskProjection,
    now = new Date().toISOString(),
  ): RemoteTaskProjection | null {
    return new RemoteSupervisionController(this.getProfile()).projectTask(snapshot, now)
  }

  authorizeRemoteAction(
    identity: RemoteSupervisorIdentity,
    action: RemoteAction,
    now = new Date().toISOString(),
  ): void {
    const controller = new RemoteSupervisionController(this.getProfile())
    try {
      controller.authorizeRemoteAction(identity, action, now)
    } finally {
      this.store.save(controller.exportProfile())
    }
  }
}
