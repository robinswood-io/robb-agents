import { type ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { type SendMessageOptions } from "@craft-agent/shared/protocol";

export async function commitRevocableSourceActivationRuntime(input: {
  isCurrent: () => boolean
  applyServers: () => Promise<void>
  restorePrevious: (stage: 'servers-error' | 'servers-superseded') => Promise<void>
  quarantine: () => Promise<void>
}): Promise<'committed' | 'superseded' | 'failed' | 'quarantined'> {
  const restore = async (stage: 'servers-error' | 'servers-superseded',
    fallback: 'superseded' | 'failed',
  ): Promise<'superseded' | 'failed' | 'quarantined'> => {
    try {
      await input.restorePrevious(stage)
      return fallback
    } catch {
      await input.quarantine()
      return 'quarantined'
    }
  }
  if (!input.isCurrent()) return 'superseded'
  try {
    await input.applyServers()
  } catch {
    return restore('servers-error', 'failed')
  }
  if (!input.isCurrent()) return restore('servers-superseded', 'superseded')
  return 'committed'
}

export const PI_SDK_MESSAGE_ID_CACHE_LIMIT = 256

export const SOURCE_ACTIVATION_DEDUP_WINDOW_MS = 2_000

export const SOURCE_ACTIVATION_TOMBSTONE_TTL_MS = 30_000

export const SOURCE_ACTIVATION_TOMBSTONE_LIMIT = 8

export const SOURCE_ACTIVATION_MAX_DISPATCH_ATTEMPTS = 2

export const SOURCE_ACTIVATION_PROTOCOL_SUFFIX = /\n\n\[[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])? activated\]$/

export interface AutoRetryPendingHost {
  autoRetryPending?: {
    content: string
    rawMessage: string
    deadlineMs: number
    tombstoneExpiresAt: number
    objectiveId: string
    objectiveRevision: string
    sourceSlug: string
    sourceActivationId: string
    generation: number
    cancellationEpoch: number
    messageCountAtSchedule: number
    dispatchToken: symbol
    dispatchInFlight: boolean
    dispatchAttempts: number
    messageId?: string
    providerStarted?: boolean
    committed: boolean
    cancelled: boolean
  }
  autoRetryTombstones?: Array<{ content: string; expiresAt: number }>
}

export function pruneAutoRetryTombstones(host: AutoRetryPendingHost, nowMs: number): void {
  if (host.autoRetryTombstones?.length) {
    host.autoRetryTombstones = host.autoRetryTombstones
      .filter(tombstone => tombstone.expiresAt > nowMs)
      .slice(-SOURCE_ACTIVATION_TOMBSTONE_LIMIT)
  }
  const pending = host.autoRetryPending
  if (pending && pending.tombstoneExpiresAt <= nowMs) host.autoRetryPending = undefined
}

export function rememberAutoRetryTombstone(
  host: AutoRetryPendingHost,
  content: string,
  nowMs = Date.now(),
  expiresAt = nowMs + SOURCE_ACTIVATION_TOMBSTONE_TTL_MS,
): void {
  pruneAutoRetryTombstones(host, nowMs)
  const retained = (host.autoRetryTombstones ?? []).filter(item => item.content !== content)
  retained.push({ content, expiresAt: Math.max(expiresAt, nowMs + 1) })
  host.autoRetryTombstones = retained.slice(-SOURCE_ACTIVATION_TOMBSTONE_LIMIT)
}

export function claimAutoRetryPending(
  host: AutoRetryPendingHost,
  message: string,
  nowMs = Date.now(),
  dispatchToken?: symbol,
): 'send' | 'authenticated' | 'drop' | 'reserved' {
  pruneAutoRetryTombstones(host, nowMs)
  const pending = host.autoRetryPending
  if (pending && message === pending.content) {
    // A mixed-version renderer can replay the exact suffix, and a human can
    // type identical text. Only the one-shot server capability may turn that
    // text into a hidden continuation of the existing objective. Authenticate
    // it even if the event loop delayed the nominal 100 ms timer past the
    // duplicate-suppression deadline.
    if (dispatchToken === pending.dispatchToken) {
      if (pending.committed || pending.cancelled || pending.dispatchInFlight) return 'drop'
      pending.dispatchInFlight = true
      return 'authenticated'
    }
    // Keep the exact-text tombstone after the latency window. A delayed legacy
    // renderer must never turn this host-authored marker into a visible user
    // turn (and therefore a new objective root) merely because 2s elapsed.
    return 'drop'
  }
  if (host.autoRetryTombstones?.some(tombstone => tombstone.content === message)) return 'drop'
  // This exact terminal suffix is host protocol, never direct-user authority.
  // Quoted/non-terminal mentions remain ordinary human text.
  if (SOURCE_ACTIVATION_PROTOCOL_SUFFIX.test(message)) return 'reserved'
  return 'send'
}

export type SourceActivationOrigin = NonNullable<SendMessageOptions['internalOrigin']> & {
  kind: 'source-activation'
  objectiveId: string
  objectiveRevision: string
  sourceSlug: string
  sourceActivationId: string
}

export function sourceActivationObjectiveBinding(
  objective: ActiveSessionObjective | undefined,
): Pick<SourceActivationOrigin, 'objectiveId' | 'objectiveRevision'> | undefined {
  if (!objective || objective.terminalState !== 'active') return undefined
  const objectiveId = objective.objectiveId ?? objective.userMessageId
  const objectiveRevision = objective.lastUserMessageId ?? objective.userMessageId
  return objectiveId && objectiveRevision ? { objectiveId, objectiveRevision } : undefined
}

export function isSourceActivationOriginCurrent(
  objective: ActiveSessionObjective | undefined,
  origin: NonNullable<SendMessageOptions['internalOrigin']> | undefined,
): origin is SourceActivationOrigin {
  if (origin?.kind !== 'source-activation'
    || !origin.objectiveId || !origin.objectiveRevision
    || !origin.sourceSlug || !origin.sourceActivationId) return false
  const current = sourceActivationObjectiveBinding(objective)
  return !!current && current.objectiveId === origin.objectiveId
    && current.objectiveRevision === origin.objectiveRevision
}

export interface SourceActivationRestartHost {
  sourceActivationRestartGeneration?: number
}
