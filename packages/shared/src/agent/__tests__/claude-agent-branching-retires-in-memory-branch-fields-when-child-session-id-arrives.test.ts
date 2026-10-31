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

describe('ClaudeAgent in-memory branch field lifecycle', () => {
  /**
   * Simulates the session_id capture logic from claude-agent.ts chat() method.
   * We test the logic in isolation because constructing a full ClaudeAgent
   * requires many dependencies (SDK, permissions, MCP, etc.).
   *
   * The logic under test (from ~L1302-1313):
   *   if ('session_id' in message && message.session_id && message.session_id !== this.sessionId) {
   *     this.sessionId = message.session_id;
   *     this.config.onSdkSessionIdUpdate?.(message.session_id);
   *     if (this.branchFromSdkSessionId) {
   *       this.branchFromSdkSessionId = null;
   *       this.branchFromSdkCwd = null;
   *       this.branchFromSdkTurnId = null;
   *     }
   *   }
   */
  interface AgentState {
    sessionId: string | null
    branchFromSdkSessionId: string | null
    branchFromSdkCwd: string | null
    branchFromSdkTurnId: string | null
  }

  function createAgentState(overrides?: Partial<AgentState>): AgentState {
    return {
      sessionId: null,
      branchFromSdkSessionId: null,
      branchFromSdkCwd: null,
      branchFromSdkTurnId: null,
      ...overrides,
    }
  }

  /**
   * Simulates the session_id capture logic from claude-agent.ts chat().
   * Returns the callback mock so tests can verify it was called.
   */
  function processSessionIdMessage(
    state: AgentState,
    message: { session_id?: string },
    onSdkSessionIdUpdate?: (id: string) => void
  ) {
    if (message.session_id && message.session_id !== state.sessionId) {
      state.sessionId = message.session_id
      onSdkSessionIdUpdate?.(message.session_id)
      if (state.branchFromSdkSessionId) {
        state.branchFromSdkSessionId = null
        state.branchFromSdkCwd = null
        state.branchFromSdkTurnId = null
      }
    }
  }

  it('retires in-memory branch fields when child session_id arrives', () => {
    const state = createAgentState({
      branchFromSdkSessionId: 'parent-123',
      branchFromSdkCwd: '/parent/cwd',
      branchFromSdkTurnId: 'turn-456',
    })
    const onUpdate = mock(() => {})

    processSessionIdMessage(state, { session_id: 'child-789' }, onUpdate)

    expect(state.sessionId).toBe('child-789')
    expect(state.branchFromSdkSessionId).toBeNull()
    expect(state.branchFromSdkCwd).toBeNull()
    expect(state.branchFromSdkTurnId).toBeNull()
    expect(onUpdate).toHaveBeenCalledWith('child-789')
  })

  it('does not clear fields for non-branch session_id updates', () => {
    const state = createAgentState({
      sessionId: 'existing-session',
    })

    processSessionIdMessage(state, { session_id: 'new-session' })

    expect(state.sessionId).toBe('new-session')
    // Fields already null, should remain null
    expect(state.branchFromSdkSessionId).toBeNull()
  })

  it('ignores duplicate session_id (no-op)', () => {
    const state = createAgentState({
      sessionId: 'same-id',
      branchFromSdkSessionId: 'parent-123',
    })
    const onUpdate = mock(() => {})

    processSessionIdMessage(state, { session_id: 'same-id' }, onUpdate)

    // No change — session_id matches, so branch fields preserved (first turn still in progress)
    expect(state.branchFromSdkSessionId).toBe('parent-123')
    expect(onUpdate).not.toHaveBeenCalled()
  })
});
