import type { RoutingMeta } from '@craft-agent/core/types'
import { classifyAgentFailure } from '@craft-agent/shared/agent'

export type RoutingFallbackReason = NonNullable<RoutingMeta['fallbackReason']>

export interface RoutingCircuitState {
  consecutiveFailures: number
  openUntil?: number
}

export interface RoutingCircuitOptions {
  failureThreshold: number
  cooldownMs: number
}

export const DEFAULT_ROUTING_CIRCUIT_OPTIONS: RoutingCircuitOptions = {
  failureThreshold: 2,
  cooldownMs: 60_000,
}

export function classifyRoutingFallbackReason(error: unknown): RoutingFallbackReason {
  const message = error instanceof Error ? error.message : String(error)
  const failure = classifyAgentFailure({ message })
  switch (failure.failureClass) {
    case 'interactive-auth-required':
    case 'credential-required':
    case 'permission-denied':
      return 'auth-failed'
    case 'model-unavailable':
      return 'model-unavailable'
    case 'network-unavailable':
    case 'service-unavailable':
    case 'timeout':
      return 'connection-unavailable'
    case 'backend-init-failed':
      return 'backend-create-failed'
    default:
      return 'provider-error'
  }
}

export function selectRoutingFallbackCandidate(
  primarySlug: string | undefined,
  candidates: string[] | undefined,
  exists: (slug: string) => boolean,
  isUnavailable: (slug: string) => boolean = () => false,
): string | undefined {
  if (!primarySlug) return undefined
  return (candidates ?? [])
    .filter(slug => slug && slug !== primarySlug)
    .find(slug => exists(slug) && !isUnavailable(slug))
}

export function recordRoutingCircuitFailure(
  previous: RoutingCircuitState | undefined,
  now = Date.now(),
  options: RoutingCircuitOptions = DEFAULT_ROUTING_CIRCUIT_OPTIONS,
): RoutingCircuitState {
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1
  return {
    consecutiveFailures,
    ...(consecutiveFailures >= options.failureThreshold
      ? { openUntil: now + options.cooldownMs }
      : {}),
  }
}

export function isRoutingCircuitOpen(
  state: RoutingCircuitState | undefined,
  now = Date.now(),
): boolean {
  return typeof state?.openUntil === 'number' && state.openUntil > now
}
