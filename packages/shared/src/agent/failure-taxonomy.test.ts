import { describe, expect, it } from 'bun:test'
import { classifyAgentFailure } from './failure-taxonomy.ts'

describe('classifyAgentFailure', () => {
  it('prefers a structured status over ambiguous message text', () => {
    expect(classifyAgentFailure({
      message: 'upstream said something unexpected',
      httpStatus: 429,
      retryAfterMs: 2_000,
    })).toEqual({
      failureClass: 'rate-limited',
      retryability: 'safe',
      recovery: 'provider-fallback',
      confidence: 'structured',
      retryAfterMs: 2_000,
    })
  })

  it('distinguishes interactive authentication from missing credentials', () => {
    expect(classifyAgentFailure({ message: 'OAuth requires MFA' }).failureClass)
      .toBe('interactive-auth-required')
    expect(classifyAgentFailure({ message: 'Unauthorized: API key missing' }).failureClass)
      .toBe('credential-required')
    expect(classifyAgentFailure({ message: 'OAuth access token expired' }).failureClass)
      .toBe('credential-required')
  })

  it('classifies validation errors as non-retryable input failures', () => {
    expect(classifyAgentFailure({
      message: 'ignored',
      code: 'INVALID_ARGUMENT',
    })).toMatchObject({
      failureClass: 'invalid-input',
      retryability: 'never',
      recovery: 'fix-input',
      confidence: 'structured',
    })
  })

  it('keeps an explicit fallback class for legacy unstructured errors', () => {
    expect(classifyAgentFailure({ message: 'unexpected provider response' })).toEqual({
      failureClass: 'unknown',
      retryability: 'conditional',
      recovery: 'browser-fallback',
      confidence: 'fallback',
    })
  })
})
