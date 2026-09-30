import { describe, expect, it } from 'bun:test'
import { inspectAutonomousLineage, orderAutonomousRestartFrontier, type AutonomousSessionNode } from './autonomous-session-admission'

function fixture() {
  const nodes = new Map<string, AutonomousSessionNode>()
  const make = (id: string, parentSessionId?: string) => {
    const node: AutonomousSessionNode = { id, parentSessionId, workspace: { id: 'workspace' }, createdAt: 10,
      activeObjective: { userMessageId: `${id}-objective`, terminalState: 'active', startedAt: 1 }, pendingTurnRecovery: {} }
    nodes.set(id, node); return node
  }
  return { nodes, make, get: (id: string) => nodes.get(id) }
}

describe('automatic delegation lineage', () => {
  it('retains all 90 descendants of a root requiring its own decision, without modifying history', () => {
    const f = fixture(); const root = f.make('root')
    root.userInputRequests = [{ sessionId: root.id, status: 'pending', objectiveUserMessageId: root.activeObjective!.userMessageId }]
    const children = Array.from({ length: 90 }, (_, i) => f.make(`child-${i}`, root.id))
    const before = JSON.stringify([...f.nodes.values()])
    for (const child of children) expect(inspectAutonomousLineage(child, f.get)).toMatchObject({ allowed: false, reason: 'decision', blockedBy: root.id })
    expect(JSON.stringify([...f.nodes.values()])).toBe(before)
    root.userInputRequests[0]!.status = 'answered'
    expect(children.every(child => inspectAutonomousLineage(child, f.get).allowed)).toBe(true)
  })

  it('does not mistake an aggregated descendant question or a superseded question for a parent decision', () => {
    const f = fixture(); const root = f.make('root'); const child = f.make('child', root.id)
    root.userInputRequests = [{ sessionId: child.id, status: 'pending' }, { sessionId: root.id, status: 'pending', objectiveUserMessageId: 'old-objective' }]
    expect(inspectAutonomousLineage(child, f.get).allowed).toBe(true)
  })

  it('bounds a historical depth-29 chain and a prospective fifth delegation', () => {
    const f = fixture(); let parent = f.make('root')
    for (let depth = 1; depth <= 29; depth++) {
      parent = f.make(`depth-${depth}`, parent.id)
      expect(inspectAutonomousLineage(parent, f.get).allowed).toBe(depth <= 4)
      if (depth === 4) expect(inspectAutonomousLineage(parent, f.get, true)).toMatchObject({ allowed: false, reason: 'depth', depth: 5 })
    }
  })

  it.each(['exhausted', 'complete_verified', 'blocked_human', 'blocked_policy'])('retains the target itself when its objective is %s', terminalState => {
    const f = fixture(); const root = f.make('root'); const child = f.make('child', root.id)
    child.activeObjective!.terminalState = terminalState
    expect(inspectAutonomousLineage(child, f.get)).toMatchObject({ allowed: false, reason: 'terminal', blockedBy: child.id })
    expect(inspectAutonomousLineage(root, f.get).allowed).toBe(true)
  })

  it.each([undefined, null])('does not classify a legacy %s objective state as terminal', terminalState => {
    const f = fixture(); const root = f.make('root')
    ;(root.activeObjective as { terminalState?: string | null }).terminalState = terminalState
    expect(inspectAutonomousLineage(root, f.get)).toMatchObject({ allowed: true })
  })

  it.each(['stopped', 'terminal', 'parent_paused', 'parent_changed', 'missing_parent', 'cross_workspace', 'cycle'] as const)('fails closed for %s', reason => {
    const f = fixture(); const root = f.make('root'); const child = f.make('child', root.id)
    if (reason === 'stopped') root.stopRequested = true
    if (reason === 'terminal') root.activeObjective!.terminalState = 'exhausted'
    if (reason === 'parent_paused') root.pendingTurnRecovery = undefined
    if (reason === 'parent_changed') root.activeObjective!.startedAt = 11
    if (reason === 'missing_parent') f.nodes.delete(root.id)
    if (reason === 'cross_workspace') root.workspace.id = 'different'
    if (reason === 'cycle') root.parentSessionId = child.id
    expect(inspectAutonomousLineage(child, f.get)).toMatchObject({ allowed: false, reason })
  })

  it('starts children before waiting parents and preserves sibling order', () => {
    const f = fixture(); const root = f.make('root'); const first = f.make('first', root.id); const second = f.make('second', root.id)
    expect(orderAutonomousRestartFrontier([root, first, second], f.get).map(node => node.id)).toEqual(['first', 'second', 'root'])
    root.isProcessing = true; root.pendingTurnRecovery = undefined
    expect(inspectAutonomousLineage(first, f.get).allowed).toBe(true)
  })
})
