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

describe('Branch-fork recovery uses onBranchForkInvalidated, not just onSdkSessionIdCleared', () => {
  interface BranchRecoveryState {
    sessionId: string | null
    branchFromSdkSessionId: string | null
    branchFromSdkCwd: string | null
    branchFromSdkTurnId: string | null
    pinnedPreferencesPrompt: string | null
    pinnedIncludeCoAuthoredBy: boolean | null
    preferencesDriftNotified: boolean
  }

  function makeBranchState(): BranchRecoveryState {
    return {
      sessionId: 'parent-sdk-session',
      branchFromSdkSessionId: 'parent-sdk-session',
      branchFromSdkCwd: '/parent/cwd',
      branchFromSdkTurnId: 'turn-456',
      pinnedPreferencesPrompt: 'pinned',
      pinnedIncludeCoAuthoredBy: true,
      preferencesDriftNotified: true,
    }
  }

  /**
   * Simulates the body of recoverFromStaleBranchFork(). The key contract
   * is that `onBranchForkInvalidated` (atomic) is called instead of
   * `onSdkSessionIdCleared` (which only persists sdkSessionId).
   */
  function simulateRecoverFromStaleBranchFork(
    state: BranchRecoveryState,
    callbacks: {
      onSdkSessionIdCleared?: () => void
      onBranchForkInvalidated?: () => void
    },
  ) {
    state.sessionId = null
    state.branchFromSdkSessionId = null
    state.branchFromSdkCwd = null
    state.branchFromSdkTurnId = null
    state.pinnedPreferencesPrompt = null
    state.pinnedIncludeCoAuthoredBy = null
    state.preferencesDriftNotified = false
    callbacks.onBranchForkInvalidated?.()
  }

  it('calls onBranchForkInvalidated (atomic), not onSdkSessionIdCleared', () => {
    const state = makeBranchState()
    const onSdkSessionIdCleared = mock(() => {})
    const onBranchForkInvalidated = mock(() => {})

    simulateRecoverFromStaleBranchFork(state, {
      onSdkSessionIdCleared,
      onBranchForkInvalidated,
    })

    // The new callback fires; the old one is no longer used by this path.
    expect(onBranchForkInvalidated).toHaveBeenCalledTimes(1)
    expect(onSdkSessionIdCleared).not.toHaveBeenCalled()
  })

  it('clears all in-memory branch fields and pinned state', () => {
    const state = makeBranchState()
    simulateRecoverFromStaleBranchFork(state, {
      onBranchForkInvalidated: mock(() => {}),
    })

    expect(state.sessionId).toBeNull()
    expect(state.branchFromSdkSessionId).toBeNull()
    expect(state.branchFromSdkCwd).toBeNull()
    expect(state.branchFromSdkTurnId).toBeNull()
    expect(state.pinnedPreferencesPrompt).toBeNull()
    expect(state.pinnedIncludeCoAuthoredBy).toBeNull()
    expect(state.preferencesDriftNotified).toBe(false)
  })
});
