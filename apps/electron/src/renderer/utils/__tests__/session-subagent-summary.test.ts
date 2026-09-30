import { describe, expect, it } from 'bun:test'
import { summarizeSessionsForSidebar } from '../session-subagent-summary'

type TestSession = {
  id: string
  parentSessionId?: string
  delegation?: { rootSessionId?: string }
  isProcessing?: boolean
  hasPendingUserInput?: boolean
  hasPendingAuth?: boolean
  pendingTurnRecovery?: { exhaustedAt?: number; validationExhausted?: boolean }
}

const session = (
  id: string,
  options: Omit<TestSession, 'id'> = {},
): TestSession => ({ id, ...options })

describe('summarizeSessionsForSidebar', () => {
  it('keeps only parent sessions directly accessible from the sidebar', () => {
    const summary = summarizeSessionsForSidebar([
      session('child-a', { parentSessionId: 'parent' }),
      session('other'),
      session('parent'),
      session('child-b', { parentSessionId: 'parent' }),
    ])

    expect(summary.topLevelSessions.map(item => item.id)).toEqual(['other', 'parent'])
    expect(summary.subagentsBySessionId.get('parent')).toEqual({
      totalCount: 2,
      runningCount: 0,
    })
  })

  it('counts every descendant and reports how many are running', () => {
    const summary = summarizeSessionsForSidebar([
      session('parent'),
      session('child', { parentSessionId: 'parent', isProcessing: true }),
      session('grandchild', { parentSessionId: 'child', isProcessing: true }),
      session('completed-grandchild', { parentSessionId: 'child' }),
    ])

    expect(summary.subagentsBySessionId.get('parent')).toEqual({
      totalCount: 3,
      runningCount: 2,
    })
    expect(summary.subagentsBySessionId.get('child')).toEqual({
      totalCount: 2,
      runningCount: 1,
    })
  })

  it('counts durable recovery and human/auth handoffs as active without reviving exhausted children', () => {
    const summary = summarizeSessionsForSidebar([
      session('parent'),
      session('recovering', { parentSessionId: 'parent', pendingTurnRecovery: {} }),
      session('question', { parentSessionId: 'parent', hasPendingUserInput: true }),
      session('auth', { parentSessionId: 'parent', hasPendingAuth: true }),
      session('exhausted', { parentSessionId: 'parent', pendingTurnRecovery: { exhaustedAt: 10 } }),
      session('validation-exhausted', {
        parentSessionId: 'parent',
        pendingTurnRecovery: { validationExhausted: true },
      }),
    ])

    expect(summary.subagentsBySessionId.get('parent')).toEqual({
      totalCount: 5,
      runningCount: 3,
    })
  })

  it('keeps summaries isolated between parent sessions', () => {
    const summary = summarizeSessionsForSidebar([
      session('parent-a'),
      session('child-a', { parentSessionId: 'parent-a', isProcessing: true }),
      session('parent-b'),
      session('child-b', { parentSessionId: 'parent-b' }),
    ])

    expect(summary.subagentsBySessionId.get('parent-a')).toEqual({
      totalCount: 1,
      runningCount: 1,
    })
    expect(summary.subagentsBySessionId.get('parent-b')).toEqual({
      totalCount: 1,
      runningCount: 0,
    })
  })

  it('projects workspace descendants onto a filtered parent without exposing child rows', () => {
    const parent = session('parent')
    const summary = summarizeSessionsForSidebar([parent], [
      parent,
      session('child', { parentSessionId: 'parent', isProcessing: true }),
      session('grandchild', { parentSessionId: 'child', isProcessing: true }),
      session('unrelated'),
    ])

    expect(summary.topLevelSessions.map(item => item.id)).toEqual(['parent'])
    expect(summary.subagentsBySessionId.get('parent')).toEqual({
      totalCount: 2,
      runningCount: 2,
    })
  })

  it('keeps orphaned child sessions internal when their parent is unavailable', () => {
    const summary = summarizeSessionsForSidebar([
      session('orphan', { parentSessionId: 'missing-parent', isProcessing: true }),
      session('visible'),
    ])

    expect(summary.topLevelSessions.map(item => item.id)).toEqual(['visible'])
    expect(summary.subagentsBySessionId.size).toBe(0)
  })

  it('aggregates a delegated child from its host root before direct lineage hydrates', () => {
    const summary = summarizeSessionsForSidebar([
      session('root'),
      session('delegated', { delegation: { rootSessionId: 'root' }, isProcessing: true }),
    ])

    expect(summary.topLevelSessions.map(item => item.id)).toEqual(['root'])
    expect(summary.subagentsBySessionId.get('root')).toEqual({
      totalCount: 1,
      runningCount: 1,
    })
  })

  it('keeps malformed self-links and cycles internal without looping', () => {
    const summary = summarizeSessionsForSidebar([
      session('self-linked', { parentSessionId: 'self-linked' }),
      session('cycle-a', { parentSessionId: 'cycle-b' }),
      session('cycle-b', { parentSessionId: 'cycle-a' }),
    ])

    expect(summary.topLevelSessions).toEqual([])
    expect(summary.subagentsBySessionId.size).toBe(0)
  })
})
