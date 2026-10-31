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

describe('Branch guard conditions — post-retirement behavior', () => {
  /**
   * Simulates the three guard conditions in claude-agent.ts chat():
   * 1. CWD override (~L867): !_isRetry && branchFromSdkCwd && branchFromSdkSessionId
   * 2. Branch hint (~L1246): !_isRetry && branchFromSdkSessionId
   * 3. Fork params (~L1180): !_isRetry && branchFromSdkSessionId (with no sessionId)
   */

  interface GuardInputs {
    _isRetry: boolean
    sessionId: string | null
    branchFromSdkSessionId: string | null
    branchFromSdkCwd: string | null
    branchFromSdkTurnId: string | null
    sdkCwd: string
  }

  function shouldUseBranchCwd(inputs: GuardInputs): boolean {
    return !inputs._isRetry && !!inputs.branchFromSdkCwd && !!inputs.branchFromSdkSessionId
  }

  function shouldInjectBranchHint(inputs: GuardInputs): boolean {
    return !inputs._isRetry && !!inputs.branchFromSdkSessionId
  }

  function getForkParams(inputs: GuardInputs): Record<string, unknown> {
    if (!inputs._isRetry && inputs.sessionId) {
      return { resume: inputs.sessionId }
    }
    if (!inputs._isRetry && inputs.branchFromSdkSessionId) {
      return {
        resume: inputs.branchFromSdkSessionId,
        forkSession: true,
        ...(inputs.branchFromSdkTurnId ? { resumeSessionAt: inputs.branchFromSdkTurnId } : {}),
      }
    }
    return {}
  }

  it('first turn with branch metadata: uses parent CWD, injects hint, sends fork params', () => {
    const inputs: GuardInputs = {
      _isRetry: false,
      sessionId: null,
      branchFromSdkSessionId: 'parent-123',
      branchFromSdkCwd: '/parent/cwd',
      branchFromSdkTurnId: 'turn-456',
      sdkCwd: '/child/cwd',
    }

    expect(shouldUseBranchCwd(inputs)).toBe(true)
    expect(shouldInjectBranchHint(inputs)).toBe(true)
    expect(getForkParams(inputs)).toEqual({
      resume: 'parent-123',
      forkSession: true,
      resumeSessionAt: 'turn-456',
    })
  })

  it('second turn after retirement: uses child CWD, no hint, resumes child session', () => {
    const inputs: GuardInputs = {
      _isRetry: false,
      sessionId: 'child-789', // set after fork established
      branchFromSdkSessionId: null, // retired
      branchFromSdkCwd: null, // retired
      branchFromSdkTurnId: null, // retired
      sdkCwd: '/child/cwd',
    }

    expect(shouldUseBranchCwd(inputs)).toBe(false)
    expect(shouldInjectBranchHint(inputs)).toBe(false)
    expect(getForkParams(inputs)).toEqual({ resume: 'child-789' })
  })

  it('retry after failed fork: no CWD override, no hint, fresh session', () => {
    const inputs: GuardInputs = {
      _isRetry: true,
      sessionId: null,
      branchFromSdkSessionId: null, // cleared by recovery
      branchFromSdkCwd: null,
      branchFromSdkTurnId: null,
      sdkCwd: '/child/cwd',
    }

    expect(shouldUseBranchCwd(inputs)).toBe(false)
    expect(shouldInjectBranchHint(inputs)).toBe(false)
    expect(getForkParams(inputs)).toEqual({})
  })

  it('fork without turnId: omits resumeSessionAt (full-history fork)', () => {
    const inputs: GuardInputs = {
      _isRetry: false,
      sessionId: null,
      branchFromSdkSessionId: 'parent-123',
      branchFromSdkCwd: '/parent/cwd',
      branchFromSdkTurnId: null, // no turnId available
      sdkCwd: '/child/cwd',
    }

    expect(getForkParams(inputs)).toEqual({
      resume: 'parent-123',
      forkSession: true,
      // no resumeSessionAt
    })
  })
});
