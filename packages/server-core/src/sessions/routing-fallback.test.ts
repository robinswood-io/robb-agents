import { describe, expect, it } from 'bun:test'
import {
  classifyRoutingFallbackReason,
  isRoutingCircuitOpen,
  recordRoutingCircuitFailure,
  resolveRoutingFallbackCandidates,
  selectRoutingFallbackCandidate,
  shouldAttemptProviderFallback,
} from './routing-fallback'

describe('classifyRoutingFallbackReason', () => {
  it('classifies auth failures', () => {
    expect(classifyRoutingFallbackReason(new Error('401 Unauthorized: token expired'))).toBe('auth-failed')
  })

  it('classifies model failures', () => {
    expect(classifyRoutingFallbackReason(new Error('model gemini-x not found'))).toBe('model-unavailable')
  })

  it('classifies connection failures', () => {
    expect(classifyRoutingFallbackReason(new Error('fetch failed: ECONNREFUSED'))).toBe('connection-unavailable')
  })

  it('classifies backend creation failures', () => {
    expect(classifyRoutingFallbackReason(new Error('backend init failed'))).toBe('backend-create-failed')
  })

  it('falls back to provider-error for unknown failures', () => {
    expect(classifyRoutingFallbackReason(new Error('rate limited by upstream'))).toBe('provider-error')
  })

  it('uses the shared taxonomy for upstream service failures', () => {
    expect(classifyRoutingFallbackReason(new Error('503 service unavailable'))).toBe('connection-unavailable')
  })
})

describe('selectRoutingFallbackCandidate', () => {
  it('selects the first existing candidate that is not the primary', () => {
    const existing = new Set(['local-rapide', 'premium'])
    expect(selectRoutingFallbackCandidate('souverain-standard', ['souverain-standard', 'missing', 'local-rapide', 'premium'], slug => existing.has(slug))).toBe('local-rapide')
  })

  it('fails closed when no candidate exists', () => {
    expect(selectRoutingFallbackCandidate('souverain-standard', ['google-gemini'], () => false)).toBeUndefined()
  })

  it('does not select the primary as its own fallback', () => {
    expect(selectRoutingFallbackCandidate('local-rapide', ['local-rapide'], () => true)).toBeUndefined()
  })

  it('skips candidates with an open circuit', () => {
    expect(selectRoutingFallbackCandidate(
      'primary',
      ['open-circuit', 'healthy'],
      () => true,
      slug => slug === 'open-circuit',
    )).toBe('healthy')
  })
})

describe('resolveRoutingFallbackCandidates', () => {
  it('uses explicit policy order when configured', () => {
    expect(resolveRoutingFallbackCandidates('primary', ['policy-b', 'policy-c'], ['global-a']))
      .toEqual(['policy-b', 'policy-c'])
  })

  it('falls back across configured connections when no policy exists', () => {
    expect(resolveRoutingFallbackCandidates('primary', undefined, ['primary', 'api', 'google', 'api']))
      .toEqual(['api', 'google'])
  })
})

describe('shouldAttemptProviderFallback', () => {
  it('allows quota, rate-limit and provider availability handoffs', () => {
    expect(shouldAttemptProviderFallback(new Error('Codex error: The usage limit has been reached'))).toBe(true)
    expect(shouldAttemptProviderFallback(new Error('429 too many requests'))).toBe(true)
    expect(shouldAttemptProviderFallback(new Error('503 provider unavailable'))).toBe(true)
  })

  it('does not hand authentication or invalid input to another account', () => {
    expect(shouldAttemptProviderFallback(new Error('401 Unauthorized: token expired'))).toBe(false)
    expect(shouldAttemptProviderFallback(new Error('validation failed: missing required field'))).toBe(false)
  })
})

describe('routing circuit breaker', () => {
  it('opens after the configured number of consecutive failures', () => {
    const first = recordRoutingCircuitFailure(undefined, 1_000, {
      failureThreshold: 2,
      cooldownMs: 500,
    })
    const second = recordRoutingCircuitFailure(first, 1_100, {
      failureThreshold: 2,
      cooldownMs: 500,
    })

    expect(isRoutingCircuitOpen(first, 1_100)).toBe(false)
    expect(second).toEqual({ consecutiveFailures: 2, openUntil: 1_600 })
    expect(isRoutingCircuitOpen(second, 1_599)).toBe(true)
    expect(isRoutingCircuitOpen(second, 1_600)).toBe(false)
  })
})
