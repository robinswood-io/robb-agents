import type { WorkspaceStatusConfig } from '@craft-agent/shared/statuses'

export type SessionLifecycleStopReason = 'complete' | 'interrupted' | 'error' | 'timeout'

export interface SessionLifecycleTurnOptions {
  hidden?: boolean
  automaticRecovery?: unknown
}

/** Hidden maintenance turns stay invisible, except recovery turns which own the user task lifecycle. */
export function shouldManageSessionStatusLifecycle(
  options?: SessionLifecycleTurnOptions,
): boolean {
  return options?.hidden !== true || options.automaticRecovery != null
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function findStatus(
  config: WorkspaceStatusConfig,
  aliases: string[],
): string | undefined {
  const wanted = new Set(aliases.map(normalized))
  return config.statuses.find(status =>
    wanted.has(normalized(status.id)) || wanted.has(normalized(status.label))
  )?.id
}

function isClosed(config: WorkspaceStatusConfig, statusId: string | undefined): boolean {
  return !!statusId && config.statuses.find(status => status.id === statusId)?.category === 'closed'
}

function canLifecycleManage(config: WorkspaceStatusConfig, currentStatus: string | undefined): boolean {
  if (isClosed(config, currentStatus)) return false
  if (!currentStatus) return true
  const status = config.statuses.find(candidate => candidate.id === currentStatus)
  if (!status) return true
  if (status.isDefault || status.id === config.defaultStatusId || status.id === 'todo') return true
  const lifecycleAliases = [
    'in-progress', 'in_progress', 'en-cours', 'doing',
    'needs-review', 'needs_review', 'a-valider',
    'blocked', 'bloque',
  ]
  return lifecycleAliases.some(alias => normalized(alias) === normalized(status.id)
    || normalized(alias) === normalized(status.label))
}

/** Status to apply when a new visible turn starts, if lifecycle owns the card. */
export function resolveLifecycleStartStatus(
  config: WorkspaceStatusConfig,
  currentStatus: string | undefined,
): string | undefined {
  if (!canLifecycleManage(config, currentStatus)) return undefined
  return findStatus(config, ['in-progress', 'in_progress', 'en cours', 'doing'])
    ?? currentStatus
    ?? config.defaultStatusId
    ?? 'todo'
}

/** Open handoff status to apply after the final outcome; humans retain closure. */
export function resolveLifecycleTerminalStatus(
  config: WorkspaceStatusConfig,
  reason: SessionLifecycleStopReason,
): string | undefined {
  if (reason === 'interrupted') return undefined
  if (reason === 'error' || reason === 'timeout') {
    return findStatus(config, ['blocked', 'bloque'])
      ?? findStatus(config, ['needs-review', 'needs_review', 'a valider'])
      ?? config.defaultStatusId
  }
  return findStatus(config, ['needs-review', 'needs_review', 'a valider'])
    ?? config.defaultStatusId
}
