import type { RoutingMeta } from '@craft-agent/core/types'

export type RoutingFallbackReason = NonNullable<RoutingMeta['fallbackReason']>

export function classifyRoutingFallbackReason(error: unknown): RoutingFallbackReason {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (lower.includes('unauthorized') || lower.includes('authentication') || lower.includes('auth') || lower.includes('401') || lower.includes('credential') || lower.includes('token')) {
    return 'auth-failed'
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('404') || lower.includes('unavailable') || lower.includes('unsupported'))) {
    return 'model-unavailable'
  }
  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('timeout') || lower.includes('network') || lower.includes('fetch failed') || lower.includes('connection')) {
    return 'connection-unavailable'
  }
  if (lower.includes('create') || lower.includes('init') || lower.includes('spawn') || lower.includes('backend')) {
    return 'backend-create-failed'
  }

  return 'provider-error'
}

export function selectRoutingFallbackCandidate(
  primarySlug: string | undefined,
  candidates: string[] | undefined,
  exists: (slug: string) => boolean,
): string | undefined {
  if (!primarySlug) return undefined
  return (candidates ?? [])
    .filter(slug => slug && slug !== primarySlug)
    .find(exists)
}
