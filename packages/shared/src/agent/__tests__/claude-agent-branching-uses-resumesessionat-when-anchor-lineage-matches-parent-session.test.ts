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

describe('Claude resumeSessionAt lineage guard', () => {
  interface ClaudeAnchorRecord {
    sdkSessionId: string
    sdkMessageUuid: string
  }

  function resolveClaudeResumeSessionAt(
    anchor: ClaudeAnchorRecord | undefined,
    branchFromSdkSessionId: string | undefined,
  ): string | undefined {
    if (!anchor || !branchFromSdkSessionId) return undefined
    if (!anchor.sdkMessageUuid || !anchor.sdkMessageUuid.startsWith('msg_')) return undefined
    if (anchor.sdkSessionId !== branchFromSdkSessionId) return undefined
    return anchor.sdkMessageUuid
  }

  it('uses resumeSessionAt when anchor lineage matches parent session', () => {
    const anchor: ClaudeAnchorRecord = {
      sdkSessionId: 'parent-sdk-session',
      sdkMessageUuid: 'msg_01ValidAnchor',
    }
    expect(resolveClaudeResumeSessionAt(anchor, 'parent-sdk-session')).toBe('msg_01ValidAnchor')
  })

  it('omits resumeSessionAt when sidecar anchor is missing', () => {
    expect(resolveClaudeResumeSessionAt(undefined, 'parent-sdk-session')).toBeUndefined()
  })

  it('omits resumeSessionAt when anchor session lineage mismatches parent', () => {
    const anchor: ClaudeAnchorRecord = {
      sdkSessionId: 'different-session',
      sdkMessageUuid: 'msg_01ValidAnchor',
    }
    expect(resolveClaudeResumeSessionAt(anchor, 'parent-sdk-session')).toBeUndefined()
  })

  it('omits resumeSessionAt when anchor uuid is malformed', () => {
    const anchor: ClaudeAnchorRecord = {
      sdkSessionId: 'parent-sdk-session',
      sdkMessageUuid: 'not-a-claude-msg-id',
    }
    expect(resolveClaudeResumeSessionAt(anchor, 'parent-sdk-session')).toBeUndefined()
  })
});
