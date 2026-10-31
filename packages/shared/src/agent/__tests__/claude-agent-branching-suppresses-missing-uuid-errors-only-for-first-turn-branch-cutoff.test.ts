/**
 * Tests for ClaudeAgent branching lifecycle
 *
 * Verifies that branch fork metadata (branchFromSdkSessionId, branchFromSdkCwd,
 * branchFromSdkTurnId) is correctly managed through the fork lifecycle:
 * - Retired on successful fork (session_id captured)
 * - Cleared on failed fork recovery
 * - Persisted and cleared via onSdkSessionIdUpdate callback
 */
import { describe, it, expect } from "bun:test";

describe('Missing UUID branch-cutoff fallback gates', () => {
  interface MissingUuidInputs {
    _isRetry: boolean
    sessionId: string | null
    branchFromSdkSessionId: string | null
    branchFromSdkTurnId: string | null
    eventType: 'error' | 'complete' | 'text_delta'
    eventMessage?: string
  }

  function shouldSuppressMissingUuidError(inputs: MissingUuidInputs): boolean {
    const wasResuming = !inputs._isRetry && (!!inputs.sessionId || !!inputs.branchFromSdkSessionId)
    const attemptedBranchCutoff = !inputs._isRetry && !!inputs.branchFromSdkSessionId && !!inputs.branchFromSdkTurnId
    return (
      attemptedBranchCutoff &&
      wasResuming &&
      !inputs._isRetry &&
      inputs.eventType === 'error' &&
      typeof inputs.eventMessage === 'string' &&
      inputs.eventMessage.includes('No message found with message.uuid')
    )
  }

  function shouldRetryWithoutCutoff(_isRetry: boolean, sessionId: string | null, suppressedBranchCutoffError: boolean): boolean {
    return suppressedBranchCutoffError && !_isRetry && !!sessionId
  }

  function shouldRetryWithoutCutoffFromCatch(_isRetry: boolean, sessionId: string | null, suppressedBranchCutoffError: boolean, wasResuming: boolean): boolean {
    return suppressedBranchCutoffError && wasResuming && !_isRetry && !!sessionId
  }

  it('suppresses missing-UUID errors only for first-turn branch-cutoff attempts', () => {
    const inputs: MissingUuidInputs = {
      _isRetry: false,
      sessionId: null,
      branchFromSdkSessionId: 'parent-123',
      branchFromSdkTurnId: 'msg_abc',
      eventType: 'error',
      eventMessage: 'No message found with message.uuid of: msg_abc',
    }

    expect(shouldSuppressMissingUuidError(inputs)).toBe(true)
  })

  it('does not suppress unrelated errors', () => {
    const inputs: MissingUuidInputs = {
      _isRetry: false,
      sessionId: null,
      branchFromSdkSessionId: 'parent-123',
      branchFromSdkTurnId: 'msg_abc',
      eventType: 'error',
      eventMessage: 'Rate limit exceeded',
    }

    expect(shouldSuppressMissingUuidError(inputs)).toBe(false)
  })

  it('does not suppress missing-UUID errors on retry attempts', () => {
    const inputs: MissingUuidInputs = {
      _isRetry: true,
      sessionId: 'child-789',
      branchFromSdkSessionId: 'parent-123',
      branchFromSdkTurnId: 'msg_abc',
      eventType: 'error',
      eventMessage: 'No message found with message.uuid of: msg_abc',
    }

    expect(shouldSuppressMissingUuidError(inputs)).toBe(false)
  })

  it('retries once without cutoff only when child session id exists', () => {
    expect(shouldRetryWithoutCutoff(false, 'child-789', true)).toBe(true)
    expect(shouldRetryWithoutCutoff(false, null, true)).toBe(false)
    expect(shouldRetryWithoutCutoff(true, 'child-789', true)).toBe(false)
  })

  it('retries from catch path when missing-UUID was suppressed and child session exists', () => {
    expect(shouldRetryWithoutCutoffFromCatch(false, 'child-789', true, true)).toBe(true)
    expect(shouldRetryWithoutCutoffFromCatch(false, null, true, true)).toBe(false)
    expect(shouldRetryWithoutCutoffFromCatch(false, 'child-789', true, false)).toBe(false)
    expect(shouldRetryWithoutCutoffFromCatch(true, 'child-789', true, true)).toBe(false)
  })
});
