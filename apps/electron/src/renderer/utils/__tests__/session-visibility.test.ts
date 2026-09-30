import { describe, expect, it } from 'bun:test'
import { findPendingRequestForConversation, getActiveSessionDescendantIds, getInternalRequestNavigationTarget, getUserFacingSessionId, isUserFacingSession, type SessionVisibilityInput } from '../session-visibility'

describe('isUserFacingSession', () => {
  it('keeps ordinary user conversations and manually created branches', () => {
    const manualBranch = {
      id: 'manual-branch',
      branchFromSessionId: 'user-conversation',
      branchFromMessageId: 'message-1',
    }
    expect(isUserFacingSession({ id: 'user-conversation' })).toBe(true)
    expect(isUserFacingSession(manualBranch)).toBe(true)
  })

  it('hides delegated sessions regardless of parent availability or state', () => {
    for (const parentSessionId of ['visible-parent', 'archived-parent', 'filtered-parent', 'missing-parent']) {
      expect(isUserFacingSession({ id: 'child', parentSessionId })).toBe(false)
    }
  })

  it('hides internal sessions and malformed self-parent relationships', () => {
    expect(isUserFacingSession({ id: 'mini-agent', hidden: true })).toBe(false)
    expect(isUserFacingSession({ id: 'self', parentSessionId: 'self' })).toBe(false)
    expect(isUserFacingSession({ id: 'delegated', delegation: { rootSessionId: 'root' } })).toBe(false)
    expect(isUserFacingSession({ id: 'task-child', taskNodeId: 'audit' })).toBe(false)
    expect(isUserFacingSession({ id: 'mission-worker', missionWorkItemId: 'work-1', missionRole: 'worker' })).toBe(false)
  })

  it('filters UI lists without altering the full session map used for coordination', () => {
    const sessions = new Map([
      ['user', { id: 'user', isFlagged: false, hasUnread: false }],
      ['child', { id: 'child', parentSessionId: 'user', isFlagged: true, hasUnread: true }],
      ['orphan', { id: 'orphan', parentSessionId: 'missing', isFlagged: true, hasUnread: true }],
    ])
    const visible = [...sessions.values()].filter(isUserFacingSession)
    expect(visible.map(session => session.id)).toEqual(['user'])
    expect(visible.some(session => session.hasUnread)).toBe(false)
    expect(visible.filter(session => session.isFlagged)).toHaveLength(0)
    expect(sessions.size).toBe(3)
    expect(sessions.get('child')?.parentSessionId).toBe('user')
  })
})

describe('delegated session attention', () => {
  const sessions = new Map<string, SessionVisibilityInput & { isProcessing?: boolean }>([
    ['parent', { id: 'parent', isProcessing: false }],
    ['child', { id: 'child', parentSessionId: 'parent', isProcessing: true }],
    ['grandchild', { id: 'grandchild', parentSessionId: 'child', isProcessing: true }],
    ['settled', { id: 'settled', parentSessionId: 'parent', isProcessing: false }],
    ['branch', { id: 'branch', isProcessing: true }],
    ['other', { id: 'other' }],
    ['other-child', { id: 'other-child', parentSessionId: 'other', isProcessing: true }],
    ['orphan', { id: 'orphan', parentSessionId: 'missing', isProcessing: true }],
    ['cycle-a', { id: 'cycle-a', parentSessionId: 'cycle-b', isProcessing: true }],
    ['cycle-b', { id: 'cycle-b', parentSessionId: 'cycle-a', isProcessing: true }],
  ])

  it('relays descendant approval to an idle parent without changing its response target', () => {
    const request = { sessionId: 'grandchild', requestId: 'approval-1', command: 'protected action' }
    const pending = new Map([['grandchild', [request]]])
    expect(findPendingRequestForConversation('parent', pending, sessions)).toBe(request)
    expect(findPendingRequestForConversation('parent', pending, sessions)?.sessionId).toBe('grandchild')
    expect(findPendingRequestForConversation('other', pending, sessions)).toBeUndefined()
    expect(pending.get('grandchild')).toEqual([request])
  })

  it('prioritizes the parent queue and then advances to the next descendant request', () => {
    const ownRequest = { sessionId: 'parent', requestId: 'parent-request' }
    const childRequest = { sessionId: 'child', requestId: 'child-request' }
    const pending = new Map([['child', [childRequest]], ['parent', [ownRequest]]])
    expect(findPendingRequestForConversation('parent', pending, sessions)).toBe(ownRequest)
    pending.delete('parent')
    expect(findPendingRequestForConversation('parent', pending, sessions)).toBe(childRequest)
    pending.delete('child')
    expect(findPendingRequestForConversation('parent', pending, sessions)).toBeUndefined()
  })

  it('keeps an orphan approval in its original queue without attributing it to another parent', () => {
    const request = { sessionId: 'orphan', requestId: 'orphan-request' }
    const pending = new Map([['orphan', [request]]])
    expect(getUserFacingSessionId('orphan', sessions)).toBeUndefined()
    expect(getUserFacingSessionId('cycle-a', sessions)).toBeUndefined()
    expect(findPendingRequestForConversation('parent', pending, sessions)).toBeUndefined()
    expect(findPendingRequestForConversation('orphan', pending, sessions)).toBe(request)
  })

  it('reports only active delegated sessions for parent activity and stop, including grandchildren', () => {
    expect(getActiveSessionDescendantIds('parent', sessions)).toEqual(['child', 'grandchild'])
    expect(getActiveSessionDescendantIds('other', sessions)).toEqual(['other-child'])
    expect(getActiveSessionDescendantIds('branch', sessions)).toEqual([])
    expect(getActiveSessionDescendantIds('missing-parent', sessions)).toEqual([])
  })

  it('uses host delegation lineage when direct parent metadata is unavailable', () => {
    const withLateLineage = new Map<string, SessionVisibilityInput & { isProcessing?: boolean }>([
      ['root', { id: 'root' }],
      ['delegated', { id: 'delegated', delegation: { rootSessionId: 'root' }, isProcessing: true }],
    ])

    expect(getUserFacingSessionId('delegated', withLateLineage)).toBe('root')
    expect(getActiveSessionDescendantIds('root', withLateLineage)).toEqual(['delegated'])
  })

  it('routes internal request attention to a user conversation without exposing children', () => {
    const withAttentionTargets = new Map<string, SessionVisibilityInput>([
      ['root', { id: 'root' }],
      ['parent-child', { id: 'parent-child', parentSessionId: 'root' }],
      ['delegation-only', { id: 'delegation-only', delegation: { rootSessionId: 'root' } }],
      ['orphan', { id: 'orphan', parentSessionId: 'missing' }],
      ['cycle-a', { id: 'cycle-a', parentSessionId: 'cycle-b' }],
      ['cycle-b', { id: 'cycle-b', parentSessionId: 'cycle-a' }],
    ])

    expect(getInternalRequestNavigationTarget('parent-child', withAttentionTargets)).toBe('root')
    expect(getInternalRequestNavigationTarget('delegation-only', withAttentionTargets)).toBe('root')
    expect(getInternalRequestNavigationTarget('root', withAttentionTargets)).toBeUndefined()
    expect(getInternalRequestNavigationTarget('orphan', withAttentionTargets)).toBeUndefined()
    expect(getInternalRequestNavigationTarget('cycle-a', withAttentionTargets)).toBeUndefined()
    expect(getInternalRequestNavigationTarget('missing', withAttentionTargets)).toBeUndefined()
  })
})
