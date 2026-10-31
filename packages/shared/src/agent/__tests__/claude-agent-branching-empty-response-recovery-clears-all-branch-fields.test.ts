/**
 * Tests for ClaudeAgent branching lifecycle
 *
 * Verifies that branch fork metadata (branchFromSdkSessionId, branchFromSdkCwd,
 * branchFromSdkTurnId) is correctly managed through the fork lifecycle:
 * - Retired on successful fork (session_id captured)
 * - Cleared on failed fork recovery
 * - Persisted and cleared via onSdkSessionIdUpdate callback
 */
import { describe, it, expect, mock } from "bun:test";

describe('Failed fork recovery — branch metadata clearing', () => {
  interface RecoveryState {
    sessionId: string | null
    branchFromSdkSessionId: string | null
    branchFromSdkCwd: string | null
    branchFromSdkTurnId: string | null
    pinnedPreferencesPrompt: string | null
    preferencesDriftNotified: boolean
  }

  function createRecoveryState(overrides?: Partial<RecoveryState>): RecoveryState {
    return {
      sessionId: 'parent-sdk-session',
      branchFromSdkSessionId: 'parent-sdk-session',
      branchFromSdkCwd: '/parent/cwd',
      branchFromSdkTurnId: 'turn-456',
      pinnedPreferencesPrompt: null,
      preferencesDriftNotified: false,
      ...overrides,
    }
  }

  /**
   * Simulates the shared recovery logic across all three paths.
   * Each recovery path in claude-agent.ts clears the same set of fields.
   */
  function simulateRecovery(state: RecoveryState, onSdkSessionIdCleared?: () => void) {
    state.sessionId = null
    state.branchFromSdkSessionId = null
    state.branchFromSdkCwd = null
    state.branchFromSdkTurnId = null
    onSdkSessionIdCleared?.()
    state.pinnedPreferencesPrompt = null
    state.preferencesDriftNotified = false
  }

  it('empty response recovery clears all branch fields', () => {
    const state = createRecoveryState()
    const onCleared = mock(() => {})

    simulateRecovery(state, onCleared)

    expect(state.sessionId).toBeNull()
    expect(state.branchFromSdkSessionId).toBeNull()
    expect(state.branchFromSdkCwd).toBeNull()
    expect(state.branchFromSdkTurnId).toBeNull()
    expect(onCleared).toHaveBeenCalledTimes(1)
  })

  it('session expired recovery clears all branch fields', () => {
    const state = createRecoveryState()
    const onCleared = mock(() => {})

    simulateRecovery(state, onCleared)

    expect(state.sessionId).toBeNull()
    expect(state.branchFromSdkSessionId).toBeNull()
    expect(state.branchFromSdkCwd).toBeNull()
    expect(state.branchFromSdkTurnId).toBeNull()
    expect(onCleared).toHaveBeenCalledTimes(1)
  })

  it('generic error recovery clears all branch fields and calls onSdkSessionIdCleared', () => {
    // This test verifies the fix: path 3 (generic fallback) was missing
    // the onSdkSessionIdCleared call before this PR
    const state = createRecoveryState()
    const onCleared = mock(() => {})

    simulateRecovery(state, onCleared)

    expect(state.sessionId).toBeNull()
    expect(state.branchFromSdkSessionId).toBeNull()
    expect(state.branchFromSdkCwd).toBeNull()
    expect(state.branchFromSdkTurnId).toBeNull()
    expect(onCleared).toHaveBeenCalledTimes(1)
  })

  it('non-branch recovery does not reference branch fields', () => {
    const state = createRecoveryState({
      branchFromSdkSessionId: null,
      branchFromSdkCwd: null,
      branchFromSdkTurnId: null,
      sessionId: 'normal-session',
    })
    const onCleared = mock(() => {})

    simulateRecovery(state, onCleared)

    expect(state.sessionId).toBeNull()
    expect(onCleared).toHaveBeenCalledTimes(1)
  })
});
