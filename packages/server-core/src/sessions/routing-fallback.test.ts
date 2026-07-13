import { describe, expect, it } from 'bun:test'
import { classifyRoutingFallbackReason, selectRoutingFallbackCandidate } from './routing-fallback'

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
})
