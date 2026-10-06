import { afterEach, describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'
import { objectiveReviewBinding, transitionObjectiveContract } from './objective-contract'

const managers: SessionManager[] = []
function harness() {
  const manager = new SessionManager(); managers.push(manager)
  const host = manager as any
  host.sendEvent = () => {}
  const workspace = { id: 'wait-test', rootPath: '/tmp/robb-wait-test', name: 'Wait', createdAt: 1 }
  const make = (id: string, ws = workspace) => {
    const session = createManagedSession({ id, name: id }, ws as never, { messagesLoaded: true })
    const parent = host.sessions.get('parent')
    if (id === 'parent') {
      session.activeObjective = transitionObjectiveContract({
        messageId: 'parent-objective', text: 'Coordinate the delegated waits.', nowMs: 1,
      })
      session.isProcessing = true
    } else if (parent?.workspace.id === ws.id && parent.activeObjective) {
      const objectiveId = parent.activeObjective.objectiveId ?? parent.activeObjective.userMessageId
      session.parentSessionId = parent.id
      session.delegation = {
        rootSessionId: parent.id,
        rootObjectiveId: objectiveId,
        parentObjectiveId: objectiveId,
        depth: 1,
        role: 'worker',
      }
    }
    host.sessions.set(id, session)
    return session
  }
  return { host, make }
}
afterEach(async () => { for (const manager of managers.splice(0)) await manager.cleanup() })

describe('delegated waits through SessionManager', () => {
  it('waits for all targets host-side and preserves an earlier one-shot final payload', async () => {
    const { host, make } = harness(); const parent = make('parent'); const a = make('all-a'); const b = make('all-b')
    a.processingGeneration = 1; b.processingGeneration = 1; b.isProcessing = true
    host.emitSessionComplete({
      sessionId: a.id, workspaceId: a.workspace.id, reason: 'complete',
      finalMessageId: 'all-a-final', finalText: 'A final',
    })

    const pending = host.waitForDelegatedSessions(parent, [a.id, b.id], 1_000, undefined, 'all')
    await new Promise(resolve => setImmediate(resolve))
    expect(host.sessionWaitListeners.size).toBe(1)
    b.isProcessing = false
    host.emitSessionComplete({
      sessionId: b.id, workspaceId: b.workspace.id, reason: 'complete',
      finalMessageId: 'all-b-final', finalText: 'B final',
    })

    const result = await pending
    expect(result).toMatchObject({
      outcome: 'completed',
      mode: 'all',
      sessions: [
        { sessionId: a.id, reason: 'complete', finalText: 'A final' },
        { sessionId: b.id, reason: 'complete', finalText: 'B final' },
      ],
    })
    expect(host.sessionWaitListeners.size).toBe(0)
  })

  it('mode:all returns an already-terminal unchanged snapshot without subscribing', async () => {
    const { host, make } = harness(); const parent = make('parent'); const child = make('all-terminal')
    child.processingGeneration = 1
    host.emitSessionComplete({
      sessionId: child.id, workspaceId: child.workspace.id, reason: 'complete',
      finalMessageId: 'all-terminal-final', finalText: 'Delivered once',
    })
    const first = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(first.sessions[0].finalText).toBe('Delivered once')

    const result = await host.waitForDelegatedSessions(
      parent,
      [child.id],
      1_000,
      { [child.id]: first.sessions[0].cursor },
      'all',
    )
    expect(result).toMatchObject({
      outcome: 'completed',
      mode: 'all',
      sessions: [{ sessionId: child.id, changed: false, reason: 'complete' }],
    })
    expect(result.sessions[0].finalText).toBeUndefined()
    expect(host.sessionWaitListeners.size).toBe(0)
  })

  it('mode:all clears stale attention and diagnostics after a target resumes and succeeds', async () => {
    const { host, make } = harness(); const parent = make('parent'); const a = make('attention-a'); const b = make('attention-b')
    a.processingGeneration = 1
    a.activeObjective = { terminalState: 'exhausted', startedAt: 1, userMessageId: 'request' } as any
    a.pendingTurnRecovery = { userMessageId: 'request', attempts: 5, exhaustedAt: 10, validationExhausted: true } as any
    b.processingGeneration = 1; b.isProcessing = true

    const pending = host.waitForDelegatedSessions(parent, [a.id, b.id], 1_000, undefined, 'all')
    await new Promise(resolve => setImmediate(resolve))
    expect(host.sessionWaitListeners.size).toBe(1)

    // External human authority resumes A while B is still active. Waking the
    // subscription must replace, not merge, A's prior attention snapshot.
    a.pendingTurnRecovery = undefined
    a.activeObjective!.terminalState = 'active'
    a.isProcessing = true
    for (const listener of host.sessionWaitListeners) listener(a.id)
    await new Promise(resolve => setImmediate(resolve))
    a.isProcessing = false
    a.activeObjective!.terminalState = 'complete_verified'
    host.emitSessionComplete({
      sessionId: a.id, workspaceId: a.workspace.id, reason: 'complete', finalText: 'A recovered',
    })
    await new Promise(resolve => setImmediate(resolve))
    b.isProcessing = false
    host.emitSessionComplete({
      sessionId: b.id, workspaceId: b.workspace.id, reason: 'complete', finalText: 'B final',
    })

    const result = await pending
    expect(result.outcome).toBe('completed')
    expect(result.sessions[0]).toMatchObject({
      sessionId: a.id, state: 'idle', reason: 'complete', finalText: 'A recovered',
    })
    expect(result.sessions[0].needsAttention).toBeUndefined()
    expect(result.sessions[0].diagnostic).toBeUndefined()
  })

  it('mode:all clears an old truncation flag when a later cursor has short final text', async () => {
    const { host, make } = harness(); const parent = make('parent'); const a = make('text-a'); const b = make('text-b')
    a.processingGeneration = 1; b.processingGeneration = 1; b.isProcessing = true
    host.emitSessionComplete({
      sessionId: a.id, workspaceId: a.workspace.id, reason: 'complete', finalText: 'x'.repeat(40_000),
    })
    const pending = host.waitForDelegatedSessions(parent, [a.id, b.id], 1_000, undefined, 'all')
    await new Promise(resolve => setImmediate(resolve))

    a.processingGeneration = 2
    a.isProcessing = true
    for (const listener of host.sessionWaitListeners) listener(a.id)
    await new Promise(resolve => setImmediate(resolve))
    a.isProcessing = false
    host.emitSessionComplete({
      sessionId: a.id, workspaceId: a.workspace.id, reason: 'complete', finalText: 'short final',
    })
    await new Promise(resolve => setImmediate(resolve))
    b.isProcessing = false
    host.emitSessionComplete({
      sessionId: b.id, workspaceId: b.workspace.id, reason: 'complete', finalText: 'B final',
    })

    const result = await pending
    expect(result.sessions[0]).toMatchObject({ finalText: 'short final', reason: 'complete' })
    expect(result.sessions[0].finalTextTruncated).toBeUndefined()
  })

  it('delivers a pre-subscription completion receipt once and lets the next sibling finish', async () => {
    const { host, make } = harness(); const parent = make('parent'); const a = make('a'); const b = make('b')
    a.processingGeneration = 1; b.processingGeneration = 1; b.isProcessing = true
    const receipt = JSON.stringify({ status: 'PASS', observations: 'x'.repeat(4500) })
    host.emitSessionComplete({ sessionId: a.id, workspaceId: a.workspace.id, reason: 'complete', finalMessageId: 'a-final', finalText: receipt })
    const first = await host.waitForDelegatedSessions(parent, ['a', 'b'], 1000)
    expect(first.sessions[0].finalText).toBe(receipt)
    const next = host.waitForDelegatedSessions(parent, ['a', 'b'], 1000)
    await new Promise(resolve => setImmediate(resolve))
    expect(host.sessionWaitListeners.size).toBe(1)
    b.isProcessing = false
    host.emitSessionComplete({ sessionId: b.id, workspaceId: b.workspace.id, reason: 'error' })
    const result = await next
    expect(result.sessions[0].changed).toBe(false)
    expect(result.sessions[0].finalText).toBeUndefined()
    expect(result.sessions[1].reason).toBe('error')
    expect(host.sessionWaitListeners.size).toBe(0)
  })

  it('keeps a deferred recovery active until its real terminal event', async () => {
    const { host, make } = harness(); const parent = make('parent'); const child = make('deferred')
    parent.isProcessing = true; child.parentSessionId = parent.id; child.processingGeneration = 2
    child.activeObjective = { terminalState: 'active', startedAt: 1, userMessageId: 'request' } as any
    child.pendingTurnRecovery = { userMessageId: 'request', attempts: 1, continuationRequired: true } as any
    host.deferredAutomaticSessions.add(child.id)
    const pending = host.waitForDelegatedSessions(parent, [child.id], 1000)
    await new Promise(resolve => setImmediate(resolve))
    expect(host.sessionWaitListeners.size).toBe(1)
    child.pendingTurnRecovery = undefined; host.deferredAutomaticSessions.delete(child.id)
    child.activeObjective!.terminalState = 'complete_verified'
    host.emitSessionComplete({ sessionId: child.id, workspaceId: child.workspace.id, reason: 'complete', finalText: 'Verified result' })
    expect((await pending).sessions[0].finalText).toBe('Verified result')
    expect(host.sessionWaitListeners.size).toBe(0)
  })

  it('reports an exhausted target with a retained machine inbox and masks its older PASS', async () => {
    const { host, make } = harness(); const parent = make('parent'); const child = make('exhausted-inbox')
    child.processingGeneration = 2
    child.activeObjective = { terminalState: 'exhausted', startedAt: 1, userMessageId: 'request' } as any
    child.pendingTurnRecovery = { userMessageId: 'request', attempts: 5, exhaustedAt: 10, validationExhausted: true } as any
    const held = { messageId: 'machine', message: 'Previous delivery', options: { internalOrigin: { kind: 'agent-message' as const, senderSessionId: parent.id } } }
    child.messageQueue.push(held)
    host.deferredAutomaticSessions.add(child.id)
    host.emitSessionComplete({ sessionId: child.id, workspaceId: child.workspace.id, reason: 'complete', finalMessageId: 'old-final', finalText: '{"status":"PASS"}' })
    const result = await host.waitForDelegatedSessions(parent, [child.id], 1000)
    expect(result.outcome).toBe('completed')
    expect(result.sessions[0]).toMatchObject({ state: 'idle', needsAttention: true, objectiveState: 'exhausted' })
    expect(result.sessions[0].reason).not.toBe('complete')
    expect(result.sessions[0].finalText).toBeUndefined()
    expect(result.sessions[0].finalMessageId).toBeUndefined()
    expect(child.messageQueue[0]).toBe(held)
    expect(child.pendingTurnRecovery?.attempts).toBe(5)
    expect(host.sessionWaitListeners.size).toBe(0)
  })

  it('preserves verified completion when an older machine inbox remains held', async () => {
    const { host, make } = harness(); const parent = make('parent'); const child = make('verified-inbox')
    child.processingGeneration = 2
    child.activeObjective = { terminalState: 'complete_verified', startedAt: 1, userMessageId: 'request' } as any
    child.messageQueue.push({ messageId: 'machine', message: 'Previous delivery', options: { internalOrigin: { kind: 'agent-message', senderSessionId: parent.id } } })
    host.deferredAutomaticSessions.add(child.id)
    const receipt = '{"status":"PASS","objectiveId":"request"}'
    host.emitSessionComplete({ sessionId: child.id, workspaceId: child.workspace.id, reason: 'complete', finalMessageId: 'verified-final', finalText: receipt })
    const result = await host.waitForDelegatedSessions(parent, [child.id], 1000)
    expect(result.outcome).toBe('completed')
    expect(result.sessions[0]).toMatchObject({ state: 'idle', reason: 'complete', finalMessageId: 'verified-final', finalText: receipt })
    expect(result.sessions[0].needsAttention).not.toBe(true)
    expect(child.messageQueue).toHaveLength(1)
  })

  it('keeps an accepted human continuation active beside an exhausted machine inbox', async () => {
    const { host, make } = harness(); const parent = make('parent'); const child = make('human-retry')
    child.processingGeneration = 2
    child.activeObjective = { terminalState: 'exhausted', startedAt: 1, userMessageId: 'request' } as any
    child.pendingTurnRecovery = { userMessageId: 'request', attempts: 5, exhaustedAt: 10, validationExhausted: true } as any
    child.messageQueue.push({ messageId: 'machine', message: 'Previous delivery', options: { internalOrigin: { kind: 'agent-message', senderSessionId: parent.id } } })
    child.messages.push({ id: 'human', role: 'user', content: 'Retry the existing objective.', timestamp: 3, isQueued: true })
    child.messageQueue.push({ messageId: 'human', message: 'Retry the existing objective.' })
    const queued = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(queued.outcome).toBe('timeout')
    expect(queued.sessions[0].state).toBe('active')
    expect(queued.sessions[0].needsAttention).not.toBe(true)
    // The real retry now owns a running turn; the old machine item remains.
    child.messageQueue.pop(); child.isProcessing = true
    const running = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(running.outcome).toBe('timeout')
    expect(running.sessions[0].state).toBe('active')
    expect(running.sessions[0].needsAttention).not.toBe(true)
    expect(child.pendingTurnRecovery?.attempts).toBe(5)
  })

  it('never upgrades an idle checkpoint to PASS and rejects a mixed-workspace wait', async () => {
    const { host, make } = harness(); const parent = make('parent'); const child = make('checkpoint')
    child.processingGeneration = 2
    child.messages = [{ id: 'checkpoint-final', role: 'assistant', content: '{"status":"PASS"}', timestamp: 1 }]
    child.lastFinalMessageId = 'checkpoint-final'
    make('foreign', { id: 'other', rootPath: '/tmp/other', name: 'Other', createdAt: 1 })
    const result = await host.waitForDelegatedSessions(parent, ['checkpoint'], 0)
    expect(result.sessions[0].reason).toBeUndefined()
    expect(result.sessions[0].finalText).toBeUndefined()
    await expect(host.waitForDelegatedSessions(parent, ['checkpoint', 'foreign'], 0))
      .rejects.toThrow('Wait targets must be current delegated descendants')
  })

  it('wakes on a user question without marking the turn successfully completed', async () => {
    const { host, make } = harness(); const parent = make('parent'); const child = make('child')
    child.processingGeneration = 1; child.isProcessing = true
    const pending = host.waitForDelegatedSessions(parent, ['child'], 1000)
    await new Promise(resolve => setImmediate(resolve))
    child.userInputRequests = [{ id: 'question', sessionId: child.id, status: 'pending', createdAt: 1 }] as any
    host.emitUserInputChanged(child)
    const result = await pending
    expect(result.sessions[0].needsAttention).toBe(true)
    expect(result.sessions[0].reason).toBeUndefined()
    expect(host.sessionWaitListeners.size).toBe(0)
  })

  it('never falls back to generic lineage for a reviewer bound to an obsolete terminal SHA', async () => {
    const { host, make } = harness(); const parent = make('parent'); const reviewer = make('reviewer')
    const base = parent.activeObjective!
    const terminalObjective = parent.activeObjective = {
      ...base,
      requiresAcceptanceCriteria: true,
      acceptanceCriteria: [{
        id: 'target-a', description: 'Target A is current', toolName: 'mcp__documents__inspect',
        input: { target: 'a' }, checks: [{ path: '$.ok', equals: true }],
      }],
      acceptanceRegisteredRevision: base.acceptanceRevision ?? base.userMessageId,
      acceptanceRegisteredAt: 2,
      terminalReconciliation: { messageId: 'close-a', timestamp: 3 },
    }
    const binding = objectiveReviewBinding(terminalObjective)
    reviewer.delegation = {
      ...reviewer.delegation!,
      role: 'reviewer',
      reviewBinding: binding,
    }
    parent.activeObjective = {
      ...terminalObjective,
      lastUserMessageId: 'retarget-b',
      acceptanceRevision: 'retarget-b',
      acceptanceNeedsReview: true,
      terminalReconciliation: undefined,
    }

    await expect(host.waitForDelegatedSessions(parent, [reviewer.id], 0))
      .rejects.toThrow('Wait targets must be current delegated descendants')
  })
})
