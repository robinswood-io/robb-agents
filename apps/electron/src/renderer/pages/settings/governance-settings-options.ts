

import type { SpaceRole } from '@craft-agent/shared/governance';

import type { RemoteAction, RemoteSyncField } from '@craft-agent/shared/remote-supervision';

export const SPACE_ROLES = ['owner', 'admin', 'operator', 'validator', 'reader'] as const satisfies readonly SpaceRole[]

export const REMOTE_SYNC_FIELDS = [
  'task.status',
  'task.progress',
  'task.blockers',
  'task.approvals',
  'task.cost',
  'task.timestamps',
] as const satisfies readonly RemoteSyncField[]

export const REMOTE_ACTIONS = [
  'task.pause',
  'task.cancel',
  'approval.resolve',
] as const satisfies readonly RemoteAction[]

export const DEFAULT_REMOTE_FIELDS: RemoteSyncField[] = [
  'task.status',
  'task.progress',
  'task.blockers',
  'task.approvals',
]

export const DEFAULT_REMOTE_ACTIONS: RemoteAction[] = [
  'task.pause',
  'task.cancel',
  'approval.resolve',
]

export function optionalPositiveNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function isSpaceRole(value: string): value is SpaceRole {
  return SPACE_ROLES.some((candidate) => candidate === value)
}
