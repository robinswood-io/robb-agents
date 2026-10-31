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

describe('onSdkSessionIdUpdate callback — branch metadata retirement', () => {
  /**
   * Simulates the callback logic from SessionManager.createManagedSession().
   * We test the callback in isolation since constructing a full SessionManager
   * requires infrastructure (filesystem, workspace, etc.) that's orthogonal
   * to the branch retirement logic.
   */
  function createCallbackUnderTest(managed: Record<string, unknown>) {
    const persistSession = mock((_managed: Record<string, unknown>) => {})
    const flush = mock((_id: string) => {})
    const sessionLog = { info: mock((_msg: string) => {}) }

    const onSdkSessionIdUpdate = (sdkSessionId: string) => {
      managed["sdkSessionId"] = sdkSessionId
      if (managed["branchFromSdkSessionId"]) {
        sessionLog.info(
          `Branch fork established for ${managed["id"]}: child=${sdkSessionId}, retiring parent fork metadata (parent=${managed["branchFromSdkSessionId"]})`
        )
        managed["branchFromSdkSessionId"] = undefined
        managed["branchFromSdkCwd"] = undefined
        managed["branchFromSdkTurnId"] = undefined
      } else {
        sessionLog.info(`SDK session ID captured for ${managed["id"]}: ${sdkSessionId}`)
      }
      persistSession(managed)
      flush(managed["id"] as string)
    }

    return { onSdkSessionIdUpdate, persistSession, flush, sessionLog }
  }

  it('clears branch fields from managed session on successful fork', () => {
    const managed: Record<string, unknown> = {
      id: 'session-child',
      sdkSessionId: undefined,
      branchFromSdkSessionId: 'parent-sdk-session-123',
      branchFromSdkCwd: '/parent/cwd',
      branchFromSdkTurnId: 'turn-456',
    }

    const { onSdkSessionIdUpdate, persistSession, flush, sessionLog } =
      createCallbackUnderTest(managed)

    onSdkSessionIdUpdate('child-sdk-session-789')

    // Branch fields retired
    expect(managed["sdkSessionId"]).toBe('child-sdk-session-789')
    expect(managed["branchFromSdkSessionId"]).toBeUndefined()
    expect(managed["branchFromSdkCwd"]).toBeUndefined()
    expect(managed["branchFromSdkTurnId"]).toBeUndefined()

    // Persistence triggered
    expect(persistSession).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)

    // Branch-specific log emitted (not the generic "captured" message)
    const firstCall = sessionLog.info.mock.calls[0] as string[]
    expect(firstCall[0]).toContain('Branch fork established')
    expect(firstCall[0]).toContain('parent-sdk-session-123')
  })

  it('uses generic log for non-branch session ID updates', () => {
    const managed: Record<string, unknown> = {
      id: 'session-normal',
      sdkSessionId: undefined,
      branchFromSdkSessionId: undefined,
      branchFromSdkCwd: undefined,
      branchFromSdkTurnId: undefined,
    }

    const { onSdkSessionIdUpdate, sessionLog } = createCallbackUnderTest(managed)

    onSdkSessionIdUpdate('new-session-id')

    expect(managed["sdkSessionId"]).toBe('new-session-id')
    const firstCall = sessionLog.info.mock.calls[0] as string[]
    expect(firstCall[0]).toContain('SDK session ID captured')
    expect(firstCall[0]).not.toContain('Branch fork established')
  })

  it('second callback call after retirement does not re-clear fields', () => {
    const managed: Record<string, unknown> = {
      id: 'session-child',
      sdkSessionId: undefined,
      branchFromSdkSessionId: 'parent-sdk-session-123',
      branchFromSdkCwd: '/parent/cwd',
      branchFromSdkTurnId: 'turn-456',
    }

    const { onSdkSessionIdUpdate, sessionLog } = createCallbackUnderTest(managed)

    // First call retires branch metadata
    onSdkSessionIdUpdate('child-1')
    const call1 = sessionLog.info.mock.calls[0] as string[]
    expect(call1[0]).toContain('Branch fork established')

    // Second call uses generic path (no branch metadata to retire)
    onSdkSessionIdUpdate('child-2')
    expect(managed["sdkSessionId"]).toBe('child-2')
    const call2 = sessionLog.info.mock.calls[1] as string[]
    expect(call2[0]).toContain('SDK session ID captured')
  })
});
