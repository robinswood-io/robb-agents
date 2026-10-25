import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { createManagedSession } from "./SessionManager.ts";
import { type Managed, activeObjective, installAgent, installReviewedAgent, makeHarness, outcomeComment, roots, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

beforeEach(() => {
  roots.length = 0
  sessionIds.length = 0
  process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT = '1'
})
afterEach(() => {
  delete process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT
  for (const sessionId of sessionIds) clearObjectiveEvidenceGate(sessionId)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('SessionManager objective outcome integration', () => {
  it('does not mint another continuation attempt while waiting on a reviewer after budget exhaustion', async () => {
    const harness = makeHarness('delegated-review-budget-exhausted')
    harness.managed.messages.push(
      { id: 'parent-root', role: 'user', content: 'Complete the existing objective.', timestamp: 1 },
      { id: 'premature-parent-final', role: 'assistant', content: 'Blocked before the reviewer finished.', timestamp: 2 },
    )
    harness.managed.activeObjective = activeObjective('parent-root')
    harness.managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery('parent-root', 1),
      attempts: 8,
    }
    const reviewer = createManagedSession({
      id: 'budget-exhausted-reviewer',
      parentSessionId: harness.managed.id,
      delegation: {
        rootSessionId: harness.managed.id,
        rootObjectiveId: 'parent-root',
        parentObjectiveId: 'parent-root',
        depth: 1,
        role: 'reviewer',
      },
    }, harness.managed.workspace, { messagesLoaded: true })
    reviewer.activeObjective = activeObjective('reviewer-root')
    reviewer.pendingTurnRecovery = createPendingTurnRecovery('reviewer-root', 1)
    reviewer.isProcessing = true
    ;sessionRuntimeStateForTest(harness.manager).sessions.set(reviewer.id, reviewer)

    const deferred = await (harness.manager as unknown as {
      deferTerminalOutcomeForActiveDelegations: (session: Managed) => Promise<boolean>
    }).deferTerminalOutcomeForActiveDelegations(harness.managed)

    expect(deferred).toBe(true)
    expect(harness.managed.activeObjective?.terminalState).toBe('active')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 8,
      exhaustedAt: expect.any(Number),
      lastCause: 'premature_final',
      continuationRequired: false,
      validationGaps: [expect.stringContaining(reviewer.id)],
    })
    expect(harness.managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.messages.at(-1)).toMatchObject({
      id: 'premature-parent-final',
      isIntermediate: true,
    })
    expect(sessionRuntimeStateForTest(harness.manager).deferredAutomaticSessions.has(harness.managed.id)).toBe(true)

    harness.managed.activeObjective!.requiresExecutionEvidence = false
    harness.managed.activeObjective!.completionCriteria = []
    const finalReceipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', criteria: [], remainingWork: [], blocker: null,
    }
    let sawNonQueuedProcessingClaim = false
    installAgent(harness, [
      { type: 'text_complete', text: `Exhausted budget was not extended; delegated evidence was consumed.\n${outcomeComment(finalReceipt)}` },
      { type: 'complete' },
    ], () => {
      if (harness.managed.lastSentOptions?.internalOrigin?.deliveryId
        !== 'budget-exhausted-terminal-delivery') return
      const claimed = harness.managed.messages.find(message => (
        message.agentDelivery?.id === 'budget-exhausted-terminal-delivery'
      ))
      expect(claimed?.agentDelivery).toMatchObject({ status: 'processing', attempts: 1 })
      expect(claimed?.isQueued).toBe(false)
      expect(harness.managed.activeAgentDelivery).toEqual({
        deliveryId: 'budget-exhausted-terminal-delivery',
        generation: harness.managed.processingGeneration,
      })
      sawNonQueuedProcessingClaim = true
    })
    await harness.manager.sendMessage(
      harness.managed.id,
      'Reviewer terminal verdict delivered within the existing lineage.',
      undefined,
      undefined,
      {
        hidden: true,
        internalOrigin: {
          kind: 'agent-message', senderSessionId: reviewer.id,
          deliveryId: 'budget-exhausted-terminal-delivery',
        },
      },
    )
    expect(harness.managed.messageQueue).toHaveLength(1)
    reviewer.activeObjective!.terminalState = 'complete_verified'
    const completed = new Promise<void>(resolve => {
      const off = harness.manager.onSessionComplete(event => {
        if (event.sessionId === harness.managed.id) { off(); resolve() }
      })
    })
    delete (harness.manager as unknown as Record<string, unknown>).processNextQueuedMessage
    await (harness.manager as unknown as {
      onProcessingStopped: (
        sessionId: string,
        reason: 'complete' | 'interrupted' | 'error' | 'timeout',
        processingGeneration?: number,
      ) => Promise<void>
    }).onProcessingStopped(reviewer.id, 'complete', reviewer.processingGeneration)
    await completed

    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(sawNonQueuedProcessingClaim).toBe(true)
    expect(harness.managed.messages.find(message => (
      message.agentDelivery?.id === 'budget-exhausted-terminal-delivery'
    ))?.agentDelivery).toMatchObject({ status: 'processed', attempts: 1 })
  })

  it.each([
    { label: 'new bounded recovery', allocated: false },
    { label: 'persisted allocated recovery', allocated: true },
  ])('keeps an already queued reviewer verdict ahead of $label', async ({ allocated }) => {
    const harness = makeHarness(`queued-verdict-${allocated ? 'allocated' : 'new'}`)
    harness.managed.messages.push(
      { id: 'parent-root', role: 'user', content: 'Complete the existing objective.', timestamp: 1 },
      { id: 'premature-parent-final', role: 'assistant', content: 'Blocked before the reviewer finished.', timestamp: 2 },
    )
    harness.managed.activeObjective = activeObjective('parent-root')
    harness.managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery('parent-root', 1),
      ...(allocated ? {
        attempts: 1,
        lastCause: 'premature_final' as const,
        recoveryDispatch: {
          schemaVersion: 1 as const, id: 'persisted-recovery', attempt: 1,
          cause: 'premature_final' as const, origin: 'automatic' as const,
          allocatedAt: 2, phase: 'allocated' as const,
        },
      } : {}),
    }
    const reviewer = createManagedSession({
      id: 'queued-verdict-reviewer', parentSessionId: harness.managed.id,
      delegation: {
        rootSessionId: harness.managed.id,
        rootObjectiveId: 'parent-root', parentObjectiveId: 'parent-root',
        depth: 1, role: 'reviewer',
      },
    }, harness.managed.workspace, { messagesLoaded: true })
    reviewer.activeObjective = activeObjective('queued-verdict-reviewer-root')
    reviewer.isProcessing = true
    ;sessionRuntimeStateForTest(harness.manager).sessions.set(reviewer.id, reviewer)
    harness.managed.messageQueue.push({
      message: 'Reviewer terminal verdict already accepted.',
      messageId: 'queued-reviewer-verdict',
      options: {
        hidden: true,
        internalOrigin: {
          kind: 'agent-message', senderSessionId: reviewer.id, deliveryId: 'queued-reviewer-delivery',
        },
      },
    })

    const deferred = await (harness.manager as unknown as {
      deferTerminalOutcomeForActiveDelegations: (session: Managed) => Promise<boolean>
    }).deferTerminalOutcomeForActiveDelegations(harness.managed)

    expect(deferred).toBe(true)
    expect(harness.managed.pendingTurnRecovery?.attempts).toBe(1)
    expect(harness.managed.messageQueue.map(item => (
      item.options?.internalOrigin?.deliveryId ?? item.options?.automaticRecovery?.dispatchId
    ))).toEqual([
      'queued-reviewer-delivery',
      allocated ? 'persisted-recovery' : expect.any(String),
    ])
  })

  it('recognizes reserved, relaunched, and restored-recovery children in the current lineage', () => {
    const harness = makeHarness('delegated-review-runtime-activity')
    harness.managed.activeObjective = activeObjective('parent-root')
    const child = (id: string, finishedAt?: number) => createManagedSession({
      id, parentSessionId: harness.managed.id,
      delegation: {
        rootSessionId: harness.managed.id,
        rootObjectiveId: 'parent-root', parentObjectiveId: 'parent-root',
        depth: 1, role: 'reviewer', ...(finishedAt ? { finishedAt } : {}),
      },
    }, harness.managed.workspace, { messagesLoaded: true })
    const reserved = child('reserved-reviewer')
    const relaunched = child('relaunched-reviewer', 2)
    relaunched.activeObjective = activeObjective('relaunched-root')
    relaunched.isProcessing = true
    const restoredRecovery = child('restored-recovery-reviewer', 3)
    restoredRecovery.activeObjective = activeObjective('restored-recovery-root')
    restoredRecovery.pendingTurnRecovery = createPendingTurnRecovery('restored-recovery-root', 1)
    const runtime = harness.manager as unknown as {
      sessions: Map<string, Managed>
      automaticAdmissionReservations: Set<string>
      activeRelevantDelegatedDescendants: (session: Managed) => Managed[]
    }
    sessionRuntimeStateForTest(runtime).sessions.set(reserved.id, reserved)
    sessionRuntimeStateForTest(runtime).sessions.set(relaunched.id, relaunched)
    sessionRuntimeStateForTest(runtime).sessions.set(restoredRecovery.id, restoredRecovery)
    sessionRuntimeStateForTest(runtime).automaticAdmissionReservations.add(reserved.id)

    expect(runtime.activeRelevantDelegatedDescendants(harness.managed).map(session => session.id).sort())
      .toEqual(['relaunched-reviewer', 'reserved-reviewer', 'restored-recovery-reviewer'])
  })

  it('does not let an undispatched child persisted before a crash hold its parent open', async () => {
    const harness = makeHarness('delegated-undispatched-child-after-restart')
    harness.managed.messages.push({
      id: 'parent-root', role: 'user', content: 'Complete the existing objective.', timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('parent-root')
    const orphan = createManagedSession({
      id: 'undispatched-reviewer', parentSessionId: harness.managed.id,
      delegation: {
        rootSessionId: harness.managed.id,
        rootObjectiveId: 'parent-root', parentObjectiveId: 'parent-root',
        depth: 1, role: 'reviewer',
      },
    }, harness.managed.workspace, { messagesLoaded: true })
    const runtime = harness.manager as unknown as {
      sessions: Map<string, Managed>
      activeRelevantDelegatedDescendants: (session: Managed) => Managed[]
      deferTerminalOutcomeForActiveDelegations: (session: Managed) => Promise<boolean>
    }
    sessionRuntimeStateForTest(runtime).sessions.set(orphan.id, orphan)

    expect(orphan.messages).toEqual([])
    expect(orphan.activeObjective).toBeUndefined()
    expect(runtime.activeRelevantDelegatedDescendants(harness.managed)).toEqual([])
    expect(await runtime.deferTerminalOutcomeForActiveDelegations(harness.managed)).toBe(false)
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('keeps the exact delegated-child invariant during restart reconciliation', async () => {
    const harness = makeHarness('delegated-review-restart-reconciliation')
    const blocked: ObjectiveOutcomeDeclaration = {
      state: 'blocked_policy', criteria: [],
      remainingWork: ['Consume the existing reviewer verdict.'],
      blocker: {
        kind: 'policy', description: 'A policy check was denied.', evidence: ['restart-policy-denial'],
      },
    }
    harness.managed.messages.push(
      { id: 'parent-root', role: 'user', content: 'Complete the existing objective.', timestamp: 1 },
      {
        id: 'restart-policy-denial', role: 'tool', content: '', timestamp: 2,
        toolName: 'mcp__ops__ssh_execute', toolUseId: 'restart-policy-denial',
        toolStatus: 'error', toolExecuted: true, isError: true,
        toolInput: { server: 'staging', command: 'git status --short' },
        toolResult: 'MCP write operations are blocked in Explore. Switch to Ask or Allow All mode.',
      },
      {
        id: 'persisted-parent-final', role: 'assistant', timestamp: 3,
        content: 'Blocked before the reviewer finished.', objectiveOutcome: blocked,
      },
    )
    harness.managed.activeObjective = activeObjective('parent-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('parent-root')
    harness.managed.lastFinalMessageId = 'persisted-parent-final'
    const reviewer = createManagedSession({
      id: 'restart-reviewer', parentSessionId: harness.managed.id,
      delegation: {
        rootSessionId: harness.managed.id,
        rootObjectiveId: 'parent-root', parentObjectiveId: 'parent-root',
        depth: 1, role: 'reviewer',
      },
    }, harness.managed.workspace, { messagesLoaded: true })
    reviewer.activeObjective = activeObjective('restart-reviewer-root')
    reviewer.pendingTurnRecovery = createPendingTurnRecovery('restart-reviewer-root', 1)
    reviewer.isProcessing = true
    const runtime = harness.manager as unknown as {
      sessions: Map<string, Managed>
      resumePendingTurnAfterRestartOnce: (sessionId: string) => Promise<void>
    }
    sessionRuntimeStateForTest(runtime).sessions.set(reviewer.id, reviewer)

    await runtime.resumePendingTurnAfterRestartOnce(harness.managed.id)

    expect(harness.managed.activeObjective?.terminalState).toBe('active')
    expect(harness.managed.activeObjective?.completedAt).toBeUndefined()
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'premature_final',
      validationGaps: [expect.stringContaining(reviewer.id)],
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.options?.automaticRecovery?.cause).toBe('premature_final')
  })

  it('does not reopen an objective that was already terminal before restart reconciliation', async () => {
    const harness = makeHarness('delegated-review-already-terminal')
    harness.managed.messages.push(
      { id: 'parent-root', role: 'user', content: 'Complete the existing objective.', timestamp: 1 },
      { id: 'terminal-parent-final', role: 'assistant', content: 'Policy blocker already published.', timestamp: 2 },
    )
    harness.managed.activeObjective = {
      ...activeObjective('parent-root'), terminalState: 'blocked_policy', completedAt: 3,
    }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('parent-root', 1)
    harness.managed.lastFinalMessageId = 'terminal-parent-final'
    const reviewer = createManagedSession({
      id: 'late-reviewer', parentSessionId: harness.managed.id,
      delegation: {
        rootSessionId: harness.managed.id,
        rootObjectiveId: 'parent-root', parentObjectiveId: 'parent-root',
        depth: 1, role: 'reviewer',
      },
    }, harness.managed.workspace, { messagesLoaded: true })
    reviewer.activeObjective = activeObjective('late-reviewer-root')
    reviewer.isProcessing = true
    const runtime = harness.manager as unknown as {
      sessions: Map<string, Managed>
      resumePendingTurnAfterRestartOnce: (sessionId: string) => Promise<void>
    }
    sessionRuntimeStateForTest(runtime).sessions.set(reviewer.id, reviewer)

    await runtime.resumePendingTurnAfterRestartOnce(harness.managed.id)

    expect(harness.managed.activeObjective).toMatchObject({
      terminalState: 'blocked_policy', completedAt: 3,
    })
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('does not let a stale delegated objective delay a verified parent completion', async () => {
    const harness = makeHarness('stale-delegated-review')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      criteria: [
        { id: 'requested-file-verified', satisfied: true, evidence: ['check-parent'] },
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['write-parent'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['check-parent'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [], blocker: null,
    }
    installReviewedAgent(harness, [
      { type: 'tool_start', toolName: 'Write', toolUseId: 'write-parent', input: { file_path: 'target.ts', content: 'export {}' } },
      { type: 'tool_result', toolName: 'Write', toolUseId: 'write-parent', result: 'Updated target.ts', isError: false, executed: true },
      { type: 'tool_start', toolName: 'Bash', toolUseId: 'check-parent', input: { command: 'bun test target.ts' } },
      { type: 'tool_result', toolName: 'Bash', toolUseId: 'check-parent', result: '{"passed":true}', isError: false, executed: true },
      { type: 'text_complete', text: `Implementation verified.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'requested-file-verified', description: 'The requested target passes its exact verification.',
        toolName: 'Bash', input: { command: 'bun test target.ts' }, checks: [{ path: 'passed', equals: true }],
      }])
      const currentObjectiveId = harness.managed.activeObjective!.objectiveId!
      const stale = createManagedSession({
        id: 'stale-reviewer', parentSessionId: harness.managed.id,
        delegation: {
          rootSessionId: harness.managed.id,
          rootObjectiveId: currentObjectiveId,
          parentObjectiveId: 'superseded-parent-objective',
          depth: 1, role: 'reviewer',
        },
      }, harness.managed.workspace, { messagesLoaded: true })
      stale.activeObjective = activeObjective('stale-review-request')
      stale.pendingTurnRecovery = createPendingTurnRecovery('stale-review-request', 1)
      stale.isProcessing = true
      ;sessionRuntimeStateForTest(harness.manager).sessions.set(stale.id, stale)
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implement and verify the requested target.')

    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.completions).toHaveLength(1)
  })

  it('finishes a revised chat draft after its content review without an automatic retry or external action', async () => {
    const harness = makeHarness('content-review-final')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['content-review-1'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'tool_start', toolName: 'mcp__session__call_llm', toolUseId: 'content-review-1',
        input: { prompt: 'Review the draft against the user constraints: in person in Scotland, 5–20 October.' } },
      { type: 'tool_result', toolName: 'mcp__session__call_llm', toolUseId: 'content-review-1',
        result: JSON.stringify({ verdict: 'PASS', criteria: [{ id: 'relevant-checks-passed', passed: true }], findings: [] }),
        isError: false, executed: true },
      { type: 'text_complete', text: `I will be in Scotland from 5 to 20 October for an in-person conference.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      // Match the persisted mission metadata from the affected draft session;
      // no execution or target-bound acceptance checks were requested.
      harness.managed.activeObjective = {
        ...harness.managed.activeObjective!, orchestrationMode: 'mission', risk: 'high-stakes',
      }
    })

    await harness.manager.sendMessage(harness.managed.id,
      "C'est un bon début, tu peux l'améliorer : uniquement en présentiel en Écosse du 5 au 20 octobre.")

    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.completions).toHaveLength(1)
    expect(harness.completions[0]).toMatchObject({ reason: 'complete' })
    expect(harness.managed.messages.filter(message => message.role === 'tool').map(message => message.toolName))
      .toEqual(['mcp__session__call_llm'])
  })
});
