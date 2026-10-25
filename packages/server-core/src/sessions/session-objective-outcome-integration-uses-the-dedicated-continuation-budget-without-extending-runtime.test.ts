import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageToStored, type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { createManagedSession } from "./SessionManager.ts";
import { type Harness, type Managed, activeObjective, installAgent, installReviewedAgent, makeHarness, outcomeComment, processEvent, roots, safeGit, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

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
  it('uses the dedicated continuation budget without extending runtime-error retries', async () => {
    const harness = makeHarness('dedicated-validated-continuation-budget')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'dedicated-validated-continuation-budget',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: {
        maxAutomaticAttempts: 1,
        maxValidatedContinuationAttempts: 3,
      } },
    }))
    harness.managed.messages.push({ id: 'budget-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('budget-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('budget-root', 1)
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (
        managed: Managed,
        cause: 'objective_continue' | 'runtime_error',
        gaps?: string[],
        continuationWork?: string[],
      ) => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)

    expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(true)
    harness.managed.messageQueue.length = 0
    harness.managed.messages.push({
      id: 'dedicated-progress', role: 'tool', content: 'verified', timestamp: 2,
      toolName: 'Read', toolUseId: 'dedicated-progress-call', toolStatus: 'completed', toolExecuted: true,
      toolInput: { path: 'target.json' }, toolResult: 'verified',
    })
    expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      continuationOrigin: 'objective_continue',
    })

    harness.managed.messageQueue.length = 0
    expect(await enqueue(harness.managed, 'runtime_error')).toBe(false)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      lastCause: 'runtime_error',
      exhaustedAt: expect.any(Number),
      continuationOrigin: 'objective_continue',
    })
  })

  it('extends structural checkpoints only when they retain validated continuation provenance', async () => {
    const makeCheckpointHarness = (id: string, withProvenance: boolean) => {
      const harness = makeHarness(id)
      writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        id: harness.managed.workspace.id,
        name: harness.managed.workspace.name,
        slug: id,
        createdAt: 1,
        updatedAt: 1,
        costControl: { recovery: {
          maxAutomaticAttempts: 1,
          maxValidatedContinuationAttempts: 3,
        } },
      }))
      harness.managed.messages.push(
        { id: 'budget-root', role: 'user', content: 'Finish the target.', timestamp: 1 },
        {
          id: 'checkpoint-progress', role: 'tool', content: 'verified', timestamp: 2,
          toolName: 'Read', toolUseId: 'checkpoint-progress-call', toolStatus: 'completed', toolExecuted: true,
          toolInput: { path: 'target.json' }, toolResult: 'verified',
        },
      )
      harness.managed.activeObjective = activeObjective('budget-root')
      harness.managed.pendingTurnRecovery = {
        ...createPendingTurnRecovery('budget-root', 1),
        attempts: 1,
        lastProgressFingerprint: 'previous-progress',
        ...(withProvenance ? {
          lastCause: 'objective_continue' as const,
          continuationWork: ['Finish verification'],
          continuationOrigin: 'objective_continue' as const,
        } : {}),
      }
      return harness
    }
    const enqueue = (harness: Harness) => (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (managed: Managed, cause: 'tool_checkpoint') => Promise<boolean>
    }).enqueueAutomaticTurnRecovery(harness.managed, 'tool_checkpoint')

    const validated = makeCheckpointHarness('validated-checkpoint-budget', true)
    expect(await enqueue(validated)).toBe(true)
    expect(validated.managed.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      lastCause: 'tool_checkpoint',
      continuationOrigin: 'objective_continue',
    })

    const unrelated = makeCheckpointHarness('unrelated-checkpoint-budget', false)
    expect(await enqueue(unrelated)).toBe(false)
    expect(unrelated.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'tool_checkpoint',
      exhaustedAt: expect.any(Number),
    })
    expect(unrelated.managed.pendingTurnRecovery?.continuationOrigin).toBeUndefined()
  })

  it('pauses an exhausted valid continuation without emitting objective_validation_failed', async () => {
    const harness = makeHarness('continuation-live-exhaustion')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'continuation-live-exhaustion',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 0 } },
    }))
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Run the final verification'], blocker: null,
    }
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Write', toolUseId: 'completed-change', input: { file_path: 'target.json' } },
      { type: 'tool_result', toolName: 'Write', toolUseId: 'completed-change', result: 'Target updated', isError: false, executed: true },
      { type: 'text_complete', text: `Implementation checkpoint preserved.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      lastOutcome: receipt,
      interruptedTurnRecovery: {
        recovery: {
          attempts: 0,
          lastCause: 'objective_continue',
          continuationWork: ['Run the final verification'],
          continuationOrigin: 'objective_continue',
        },
      },
    })
    expect(harness.managed.activeObjective?.interruptedTurnRecovery?.recovery.exhaustedAt).toBeNumber()
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error'
      && (event.error as { code?: string } | undefined)?.code === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'info', message: expect.stringContaining('reported remaining work were preserved'),
    }))
  })

  it('keeps a prior validated continuation when a legacy final omits its receipt', async () => {
    const harness = makeHarness('legacy-continuation-missing-receipt')
    const prior: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Run the final verification against target.json'], blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: 'The target still needs final verification.' },
      { type: 'complete' },
    ], () => {
      harness.managed.activeObjective!.lastOutcome = prior
      harness.managed.pendingTurnRecovery = {
        ...harness.managed.pendingTurnRecovery!, budgetHistoryUnavailable: true,
      }
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.activeObjective).toMatchObject({
      terminalState: 'exhausted', lastOutcome: prior,
      interruptedTurnRecovery: {
        recovery: {
          budgetHistoryUnavailable: true,
          continuationWork: ['Run the final verification against target.json'],
        },
      },
    })
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
    expect(harness.resumedSessionIds).toEqual([])
  })

  it('hides a malformed receipt and persists its extraction error without making it operational', async () => {
    const harness = makeHarness('receipt-error')
    harness.managed.agent = { getModel: () => 'test/objective-model' } as never

    await processEvent(harness, {
      type: 'text_complete',
      text: 'Résultat visible.\n<!-- robb_objective_outcome {"state":"complete_verified" -->',
    })

    const assistant = harness.managed.messages.at(-1)!
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: 'Résultat visible.',
      objectiveOutcomeError: 'malformed objective outcome receipt',
    })
    expect(messageToStored(assistant).objectiveOutcomeError).toBe('malformed objective outcome receipt')
    expect(harness.managed.messages.some(message => message.role === 'error')).toBe(false)
    expect(harness.sentEvents.at(-1)).toMatchObject({
      type: 'text_complete',
      text: 'Résultat visible.',
      objectiveOutcome: null,
      objectiveOutcomeError: assistant.objectiveOutcomeError,
    })
  })

  it('demotes a false mission final and queues a bounded recovery carrying validation gaps', async () => {
    const harness = makeHarness('false-final')
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Read', toolUseId: 'existing-check', input: { path: 'target.json' } },
      { type: 'tool_result', toolName: 'Read', toolUseId: 'existing-check', result: '{"verified":true}', isError: false, executed: true },
      { type: 'text_complete', text: 'Le changement est terminé.', turnId: 'turn-false-final' },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis teste-le.')

    const assistant = harness.managed.messages.find(message => message.role === 'assistant')!
    const streamedFinal = harness.sentEvents.find(event => (
      event.type === 'text_complete' && event.isIntermediate !== true
    ))
    const demotion = harness.sentEvents.find(event => (
      event.type === 'text_complete' && event.isIntermediate === true
    ))
    expect(assistant.isIntermediate).toBe(true)
    expect(demotion?.messageId).toBe(streamedFinal?.messageId)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'objective_incomplete',
      validationGaps: expect.arrayContaining(['missing structured objective outcome receipt']),
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('Host validation gaps to correct')
    expect(harness.managed.messageQueue[0]?.message).toContain('missing structured objective outcome receipt')
    const savedCheck = harness.managed.messages.find(message => message.toolUseId === 'existing-check')!
    expect(harness.managed.messageQueue[0]?.message).toContain(`"messageId":"${savedCheck.id}"`)
    expect(harness.resumedSessionIds).toEqual([harness.managed.id])
    expect(harness.completions).toEqual([])
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'objective_changed',
      activeObjective: expect.objectContaining({ terminalState: 'active' }),
      pendingTurnRecovery: expect.objectContaining({ attempts: 0 }),
    }))
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'objective_changed',
      activeObjective: expect.objectContaining({ terminalState: 'active' }),
      pendingTurnRecovery: expect.objectContaining({ attempts: 1, lastCause: 'objective_incomplete' }),
    }))
    expect(harness.sentEvents.some(event => event.type === 'complete')).toBe(false)
  })

  it('keeps a parent active when it declares blocked_policy before its delegated reviewer stops', async () => {
    const harness = makeHarness('delegated-review-still-running')
    const finalReceipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      criteria: [
        { id: 'requested-file-verified', satisfied: true, evidence: ['check-parent'] },
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['write-parent'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['check-parent'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [],
      blocker: null,
    }
    const prematureBlockedReceipt: ObjectiveOutcomeDeclaration = {
      state: 'blocked_policy',
      criteria: [],
      remainingWork: ['Consume the terminal verdict from the already-dispatched reviewer.'],
      blocker: {
        kind: 'policy',
        description: 'A host policy check was denied while the delegated reviewer was still running.',
        evidence: ['parent-policy-denial'],
      },
    }
    let reviewer!: Managed
    installReviewedAgent(harness, [
      { type: 'tool_start', toolName: 'Write', toolUseId: 'write-parent', input: { file_path: 'target.ts', content: 'export {}' } },
      { type: 'tool_result', toolName: 'Write', toolUseId: 'write-parent', result: 'Updated target.ts', isError: false, executed: true },
      { type: 'tool_start', toolName: 'Bash', toolUseId: 'check-parent', input: { command: 'bun test target.ts' } },
      { type: 'tool_result', toolName: 'Bash', toolUseId: 'check-parent', result: '{"passed":true}', isError: false, executed: true },
      { type: 'tool_start', toolName: 'mcp__ops__ssh_execute', toolUseId: 'parent-policy-denial', input: { server: 'staging', command: `${safeGit} rev-parse HEAD` } },
      { type: 'tool_result', toolName: 'mcp__ops__ssh_execute', toolUseId: 'parent-policy-denial', result: 'MCP write operations are blocked in Explore. Switch to Ask or Allow All mode.', isError: true, executed: true },
      { type: 'text_complete', text: `Blocked while the reviewer is still running.\n${outcomeComment(prematureBlockedReceipt)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'requested-file-verified', description: 'The requested target passes its exact verification.',
        toolName: 'Bash', input: { command: 'bun test target.ts' }, checks: [{ path: 'passed', equals: true }],
      }])
      const parentObjectiveId = harness.managed.activeObjective!.objectiveId!
      reviewer = createManagedSession({
        id: 'current-reviewer',
        parentSessionId: harness.managed.id,
        delegation: {
          rootSessionId: harness.managed.id,
          rootObjectiveId: parentObjectiveId,
          parentObjectiveId,
          depth: 1,
          role: 'reviewer',
        },
      }, harness.managed.workspace, { messagesLoaded: true })
      reviewer.messages.push({ id: 'review-request', role: 'user', content: 'Review the exact target.', timestamp: 1 })
      reviewer.activeObjective = activeObjective('review-request')
      reviewer.pendingTurnRecovery = createPendingTurnRecovery('review-request', 1)
      reviewer.isProcessing = true
      reviewer.processingGeneration = 1
      ;sessionRuntimeStateForTest(harness.manager).sessions.set(reviewer.id, reviewer)
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implement and verify the requested target.')

    expect(harness.managed.activeObjective?.terminalState).toBe('active')
    expect(harness.managed.activeObjective?.completedAt).toBeUndefined()
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'premature_final',
      validationGaps: [expect.stringContaining(reviewer.id)],
    })
    expect(harness.managed.messages.find(message => message.role === 'assistant')?.isIntermediate).toBe(true)
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.completions).toEqual([])
    expect(harness.sentEvents.some(event => event.type === 'complete')).toBe(false)

    const runtime = harness.manager as unknown as {
      claimAutomaticAdmission: (session: Managed) => boolean
      automaticAdmissionReservations: Set<string>
    }
    expect(runtime.claimAutomaticAdmission(harness.managed)).toBe(false)

    await harness.manager.sendMessage(
      harness.managed.id,
      'Reviewer terminal verdict: PASS for the exact target and objective binding.',
      undefined,
      undefined,
      {
        hidden: true,
        internalOrigin: {
          kind: 'agent-message', senderSessionId: reviewer.id,
          deliveryId: 'current-reviewer-terminal-delivery',
        },
      },
    )
    expect(harness.managed.messageQueue.map(item => item.options?.internalOrigin?.deliveryId
      ?? item.options?.automaticRecovery?.cause)).toEqual([
      'current-reviewer-terminal-delivery',
      'premature_final',
    ])

    reviewer.activeObjective!.terminalState = 'complete_verified'
    sessionRuntimeStateForTest(runtime).automaticAdmissionReservations.delete(harness.managed.id)

    installReviewedAgent(harness, [
      { type: 'text_complete', text: `Delegated result consumed; the existing implementation and checks remain verified.\n${outcomeComment(finalReceipt)}` },
      { type: 'complete' },
    ])
    const completed = new Promise<void>(resolve => {
      const off = harness.manager.onSessionComplete(event => {
        if (event.sessionId === harness.managed.id) { off(); resolve() }
      })
    })
    // Restore the real dispatcher before publishing the child's stop. Its
    // normal deferred-admission wake must consume the delivery; the test must
    // not manually replay the parent queue.
    delete (harness.manager as unknown as Record<string, unknown>).processNextQueuedMessage
    await (harness.manager as unknown as {
      onProcessingStopped: (
        sessionId: string,
        reason: 'complete' | 'interrupted' | 'error' | 'timeout',
        processingGeneration?: number,
      ) => Promise<void>
    }).onProcessingStopped(reviewer.id, 'complete', reviewer.processingGeneration)
    await completed

    const delivery = harness.managed.messages.find(message => (
      message.agentDelivery?.id === 'current-reviewer-terminal-delivery'
    ))
    expect(delivery?.agentDelivery).toMatchObject({ status: 'processed', attempts: 1 })
    expect(delivery?.isQueued).toBe(false)
    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
  })
});
