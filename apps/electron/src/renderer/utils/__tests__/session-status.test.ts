import { describe, expect, it } from 'bun:test'
import { resolveObjectiveSessionStatus } from '../session-status'

describe('resolveObjectiveSessionStatus', () => {
  it('projects verified objectives as done despite a stale review status', () => {
    expect(resolveObjectiveSessionStatus({
      sessionStatus: 'needs-review',
      activeObjective: { terminalState: 'complete_verified' },
    })).toBe('done')
  })

  it('projects exhausted and blocked objectives as reviewable rather than running', () => {
    for (const terminalState of ['exhausted', 'blocked_human', 'blocked_policy'] as const) {
      expect(resolveObjectiveSessionStatus({
        sessionStatus: 'in-progress',
        activeObjective: { terminalState },
      })).toBe('needs-review')
    }
    expect(resolveObjectiveSessionStatus({
      sessionStatus: 'blocked',
      activeObjective: { terminalState: 'exhausted' },
    })).toBe('blocked')
  })

  it('preserves user-defined organization for active and objective-free sessions', () => {
    expect(resolveObjectiveSessionStatus({
      sessionStatus: 'legal-review',
      activeObjective: { terminalState: 'active' },
    })).toBe('legal-review')
    expect(resolveObjectiveSessionStatus({ sessionStatus: 'backlog' })).toBe('backlog')
    expect(resolveObjectiveSessionStatus({})).toBe('todo')
  })
})
