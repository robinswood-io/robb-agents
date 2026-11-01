import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { messageToStored, type AgentEvent, type Message, type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { StructuredMissionVerdictSchema } from "@craft-agent/shared/missions";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { createManagedSession } from "./SessionManager.ts";
import { transitionObjectiveContract } from "./objective-contract.ts";
import { type Managed, activeObjective, installAgent, makeHarness, outcomeComment, processEvent, roots, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

beforeEach(() => {
  roots.length = 0
  sessionIds.length = 0
  process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
})
afterEach(() => {
  delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
  for (const sessionId of sessionIds) clearObjectiveEvidenceGate(sessionId)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('SessionManager objective outcome integration', () => {
  it('exposes objective and recovery snapshots in the session DTO and publishes nested changes and clears', async () => {
    const harness = makeHarness('objective-snapshots')
    const persist = () => (sessionManagerForTest(harness.manager)).persistSession(harness.managed)
    persist()
    expect(harness.sentEvents).toEqual([])

    harness.managed.activeObjective = activeObjective('user-snapshot')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-snapshot')
    persist()
    const first = harness.sentEvents[0]!
    expect(first).toMatchObject({
      type: 'objective_changed', sessionId: harness.managed.id,
      activeObjective: { userMessageId: 'user-snapshot', terminalState: 'active' },
      pendingTurnRecovery: { userMessageId: 'user-snapshot', attempts: 0 },
    })
    const session = await harness.manager.getSession(harness.managed.id)
    expect(session?.activeObjective).toEqual(harness.managed.activeObjective)
    expect(session?.pendingTurnRecovery).toEqual(harness.managed.pendingTurnRecovery)
    expect(harness.manager.getSessions(harness.managed.workspace.id)[0]?.activeObjective).toEqual(harness.managed.activeObjective)

    persist()
    expect(harness.sentEvents).toHaveLength(1)
    harness.managed.activeObjective.acceptanceCriteria = [{
      id: 'delivery', description: 'Delivery confirmed', toolName: 'mcp__delivery__get_status',
      input: { id: 'target' }, checks: [{ path: '$.delivered', equals: true }],
    }]
    harness.managed.pendingTurnRecovery.attempts = 1
    persist()
    expect(harness.sentEvents).toHaveLength(2)
    expect(first).toMatchObject({ pendingTurnRecovery: { attempts: 0 } })
    expect((first["activeObjective"] as Managed['activeObjective'])?.acceptanceCriteria).toBeUndefined()
    expect(harness.sentEvents[1]).toMatchObject({
      activeObjective: { acceptanceCriteria: [{ id: 'delivery' }] },
      pendingTurnRecovery: { attempts: 1 },
    })

    harness.managed.pendingTurnRecovery = undefined
    persist()
    expect(harness.sentEvents.at(-1)).toMatchObject({ activeObjective: { terminalState: 'active' }, pendingTurnRecovery: null })
    harness.managed.activeObjective = undefined
    persist()
    expect(harness.sentEvents.at(-1)).toMatchObject({ activeObjective: null, pendingTurnRecovery: null })
    persist()
    expect(harness.sentEvents).toHaveLength(4)
  })

  it.each([
    { label: 'successful', fails: false, expectedOutcome: 'succeeded' as const },
    { label: 'failed', fails: true, expectedOutcome: 'failed' as const },
  ])('flushes a $label context-compaction receipt before provider chat continues', async ({ fails, expectedOutcome }) => {
    const harness = makeHarness(`compaction-flush-${expectedOutcome}`)
    harness.managed.tokenUsage = {
      inputTokens: 100_000,
      outputTokens: 1_000,
      totalTokens: 101_000,
      contextTokens: 100_000,
      costUsd: 1,
    }
    const order: string[] = []
    let contextAtProviderDispatch: number | undefined
    let awaitingBaselineAtProviderDispatch: true | undefined
    let baselineAdmissionDispatchedAtProviderDispatch: number | undefined
    installAgent(harness, [
      { type: 'text_complete', text: 'Contexte traité.' },
      { type: 'complete' },
    ], () => {
      order.push('chat')
      contextAtProviderDispatch = harness.managed.tokenUsage?.contextTokens
      awaitingBaselineAtProviderDispatch = harness.managed.contextCompactionAttempt?.awaitingProviderContextBaseline
      baselineAdmissionDispatchedAtProviderDispatch = harness.managed.contextCompactionAttempt?.providerBaselineAdmissionDispatchedAt
    })
    const agent = harness.managed.agent as {
      compactContext: () => Promise<{
        summary: string
        firstKeptEntryId: string
        tokensBefore: number
        estimatedTokensAfter: number
      }>
    }
    agent.compactContext = async () => {
      order.push('compact')
      if (fails) throw new Error('Synthetic compaction backend failure')
      return {
        summary: [
          '## Goal', 'Preserve the active task.',
          '## Constraints & Preferences', '- Do not replay effects.',
          '## Progress', '- Context compacted.',
          '## Key Decisions', '- Keep durable receipts.',
          '## Next Steps', '1. Continue the provider turn.',
          '## Critical Context', '- Session state is retained.',
        ].join('\n'),
        firstKeptEntryId: 'entry-after-compaction',
        tokensBefore: 100_000,
        estimatedTokensAfter: 50_000,
      }
    }
    const internals = sessionManagerForTest(harness.manager)
    internals.enqueuePersist = session => {
      if (session.contextCompactionAttempt) order.push(`persist:${session.contextCompactionAttempt.outcome}`)
      return true
    }
    internals.flushSession = async () => {
      if (harness.managed.contextCompactionAttempt) {
        order.push(`flush:${harness.managed.contextCompactionAttempt.outcome}`)
      }
    }

    await harness.manager.sendMessage(harness.managed.id, 'Résume précisément l’état actuel.')

    expect(harness.managed.contextCompactionAttempt?.outcome).toBe(expectedOutcome)
    expect(harness.managed.contextCompactionAttempt?.contextTokensAfter).toBeUndefined()
    expect(harness.managed.contextCompactionAttempt?.awaitingProviderContextBaseline)
      .toBe(fails ? undefined : true)
    expect(contextAtProviderDispatch).toBe(fails
      ? Math.max(1, Math.ceil('Résume précisément l’état actuel.'.length / 4))
      : 100_000)
    expect(awaitingBaselineAtProviderDispatch).toBe(fails ? undefined : true)
    expect<unknown>(baselineAdmissionDispatchedAtProviderDispatch).toEqual(fails ? undefined : (expect.any(Number) as unknown))
    expect(order.slice(0, 3)).toEqual([
      'compact',
      `persist:${expectedOutcome}`,
      `flush:${expectedOutcome}`,
    ])
    const chatIndex = order.indexOf('chat')
    expect(chatIndex).toBeGreaterThan(2)
    expect(order.slice(0, chatIndex).filter(item => item === `flush:${expectedOutcome}`)).toHaveLength(2)
    if (fails) expect(harness.managed.providerContextBoundaryMessageId).toBe(
      harness.managed.messages.find(message => message.role === 'user' && !message.hidden)?.id,
    )
  })

  it('captures only the first provider-scale measurement after host compaction', async () => {
    const harness = makeHarness('compaction-provider-baseline')
    harness.managed.tokenUsage = {
      inputTokens: 100_000,
      outputTokens: 1_000,
      totalTokens: 101_000,
      contextTokens: 100_000,
      costUsd: 1,
    }
    installAgent(harness, [
      { type: 'usage_update', usage: { inputTokens: 61_000, contextWindow: 200_000 } },
      { type: 'text_complete', text: 'Le contexte compacté est prêt.' },
      {
        type: 'complete',
        usage: {
          inputTokens: 70_000,
          contextTokens: 68_000,
          outputTokens: 200,
          contextWindow: 200_000,
        },
      },
    ])
    const agent = harness.managed.agent as {
      compactContext: () => Promise<{
        summary: string
        firstKeptEntryId: string
        tokensBefore: number
        estimatedTokensAfter: number
      }>
    }
    agent.compactContext = async () => ({
      summary: [
        '## Goal', 'Preserve the active task.',
        '## Constraints & Preferences', '- Do not replay effects.',
        '## Progress', '- Context compacted.',
        '## Key Decisions', '- Wait for provider usage.',
        '## Next Steps', '1. Continue the provider turn.',
        '## Critical Context', '- Session state is retained.',
      ].join('\n'),
      firstKeptEntryId: 'entry-after-compaction',
      tokensBefore: 100_000,
      estimatedTokensAfter: 18_000,
    })
    let flushedBaseline: number | undefined
    ;(sessionManagerForTest(harness.manager)).flushSession = async () => {
      flushedBaseline = harness.managed.contextCompactionAttempt?.providerContextBaselineTokens
    }

    await harness.manager.sendMessage(harness.managed.id, 'Résume le contexte actuel.')

    expect(harness.managed.contextCompactionAttempt).toMatchObject({
      outcome: 'succeeded',
      providerContextBaselineTokens: 61_000,
    })
    expect(harness.managed.contextCompactionAttempt).not.toHaveProperty('awaitingProviderContextBaseline')
    expect(harness.managed.contextCompactionAttempt).not.toHaveProperty('contextTokensAfter')
    expect(flushedBaseline).toBe(61_000)
    expect(harness.managed.tokenUsage?.contextTokens).toBe(68_000)
  })

  it('captures a complete-event provider context when no usage update preceded it', async () => {
    const harness = makeHarness('compaction-complete-baseline')
    harness.managed.contextCompactionAttempt = {
      attemptedAt: 1_000,
      contextTokensBefore: 100_000,
      outcome: 'succeeded',
      objectiveRootId: 'objective-root',
      awaitingProviderContextBaseline: true,
      hardLimitTokens: 120_000,
    }
    await processEvent(harness, {
      type: 'complete',
      usage: {
        inputTokens: 70_000,
        contextTokens: 57_000,
        outputTokens: 200,
        contextWindow: 200_000,
      },
    })

    expect(harness.managed.contextCompactionAttempt).toMatchObject({
      providerContextBaselineTokens: 57_000,
    })
    expect(harness.managed.contextCompactionAttempt).not.toHaveProperty('awaitingProviderContextBaseline')
  })

  it('omits delegated children from unread workspace badges while retaining manual branches', () => {
    const parent = makeHarness('unread-parent')
    parent.managed.hasUnread = true
    const sessions = sessionRuntimeStateForTest(parent.manager).sessions
    const add = (id: string, fields: Partial<Managed>) => {
      const managed = createManagedSession({ id }, parent.managed.workspace, { messagesLoaded: true, hasUnread: true, ...fields })
      sessions.set(id, managed)
    }
    add('delegated', { parentSessionId: parent.managed.id })
    add('delegated-root-fallback', { delegation: {
      rootSessionId: parent.managed.id, rootObjectiveId: 'root-objective',
      parentObjectiveId: 'root-objective', depth: 1, role: 'worker',
    } })
    add('task-node-fallback', { taskNodeId: 'internal-task-node' })
    add('mission-work-fallback', { missionWorkItemId: 'internal-mission-work', missionRole: 'worker' })
    add('manual-branch', { branchFromMessageId: 'source-message', branchFromSessionPath: join(parent.managed.workspace.rootPath, parent.managed.id) })
    add('hidden', { hidden: true })
    add('archived', { isArchived: true })
    const summary = parent.manager.getUnreadSummary()
    expect(summary.totalUnreadSessions).toBe(2)
    expect(summary.byWorkspace[parent.managed.workspace.id]).toBe(2)
    expect(summary.hasUnreadByWorkspace[parent.managed.workspace.id]).toBe(true)
  })

  it('extracts and hides a valid receipt while retaining it in stored message data', async () => {
    const harness = makeHarness('receipt-extraction')
    harness.managed.agent = { getModel: () => 'test/objective-model' } as never
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue',
      criteria: [],
      remainingWork: ['Run the final verification'],
      blocker: null,
    }

    await processEvent(harness, {
      type: 'text_complete',
      text: `Avancement conservé.\n${outcomeComment(receipt)}`,
      turnId: 'turn-receipt',
    })

    const assistant = harness.managed.messages.at(-1)!
    expect(assistant.content).toBe('Avancement conservé.')
    expect(assistant.objectiveOutcome).toEqual(receipt)
    expect(assistant.content).not.toContain('robb_objective_outcome')
    expect(messageToStored(assistant).objectiveOutcome).toEqual(receipt)
    expect(harness.sentEvents.at(-1)).toMatchObject({
      type: 'text_complete',
      text: 'Avancement conservé.',
      objectiveOutcome: receipt,
      objectiveOutcomeError: null,
    })
  })

  it('completes a Mission reviewer with a structured verdict plus stripped objective transport receipt', async () => {
    const harness = makeHarness('mission-reviewer-transport')
    harness.managed.missionRole = 'reviewer'
    harness.managed.permissionMode = 'safe'
    const verdict = {
      targetType: 'objective' as const,
      targetId: 'objective-one',
      result: 'pass' as const,
      summary: 'The objective satisfies its acceptance criterion.',
      criteria: [{
        criterionId: 'objective-ok',
        result: 'pass' as const,
        evidenceRefs: ['artifact://reviewed-result'],
        explanation: 'The reviewed artifact contains the expected result.',
      }],
      affectedWorkItemIds: [],
      corrections: [],
    }
    const verdictJson = JSON.stringify(verdict)
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', criteria: [], remainingWork: [], blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `${verdictJson}\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      const objective = harness.managed.activeObjective!
      objective.delegatedRole = 'reviewer'
      objective.orchestrationMode = 'mission'
      objective.completionCriteria = []
      delete objective.requiresExecutionEvidence
      delete objective.requiresObservationEvidence
      delete objective.requiresAcceptanceCriteria
      delete objective.acceptanceCriteria
      delete objective.evidenceRequirement
      delete objective.evidenceDomain
    })

    await harness.manager.sendMessage(harness.managed.id, 'Review objective one and return its Mission verdict.')

    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.completions).toHaveLength(1)
    expect(harness.completions[0]).toMatchObject({ reason: 'complete', finalText: verdictJson })
    const assistant = [...harness.managed.messages].reverse().find(message => message.role === 'assistant')!
    expect(assistant.content).toBe(verdictJson)
    expect(assistant.content).not.toContain('robb_objective_outcome')
    expect(StructuredMissionVerdictSchema.parse(JSON.parse(harness.completions[0]!.finalText!))).toEqual(verdict)
  })

  it('continues a valid progress receipt without reporting a validation failure', async () => {
    const harness = makeHarness('valid-continuation')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Run the final verification'], blocker: null,
    }
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Write', toolUseId: 'preserved-change', input: { file_path: 'target.json' } },
      { type: 'tool_result', toolName: 'Write', toolUseId: 'preserved-change', result: 'Target updated', isError: false, executed: true },
      { type: 'text_complete', text: `Implementation checkpoint preserved.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: ['Run the final verification'],
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('valid progress receipt')
    expect(harness.managed.messageQueue[0]?.message).toContain('Run the final verification')
    expect(harness.managed.messages.find(message => message.role === 'assistant')?.isIntermediate).toBe(true)
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents.some(event => event["type"] === 'typed_error')).toBe(false)
  })

  it('keeps a blocked mission incomplete when a required receipt and registered checks are absent', async () => {
    const harness = makeHarness('blocked-mission-without-receipt')
    delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
    const finalText = '**Mission bloquée à la lecture du fichier.** Aucun livrable n’a été créé.'
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Read', toolUseId: 'blocked-read', input: { file_path: 'synthetic.csv' } },
      { type: 'tool_result', toolName: 'Read', toolUseId: 'blocked-read', result: 'Read timed out', isError: true, executed: true },
      { type: 'text_complete', text: finalText },
      { type: 'complete' },
    ], () => {
      const objective = harness.managed.activeObjective!
      objective.requiresAcceptanceCriteria = true
      objective.requiresExecutionEvidence = true
      delete objective.acceptanceCriteria
    })

    await harness.manager.sendMessage(harness.managed.id, 'Read the synthetic file and produce the requested deliverables.')

    expect(harness.managed.activeObjective?.terminalState).toBe('blocked_policy')
    expect(harness.managed.activeObjective?.completionCriteria).toEqual([
      'requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining',
    ])
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.messages.some(message => message.role === 'tool'
      && message.toolName === 'Read' && message.isError === true)).toBe(true)
    expect([...harness.managed.messages].reverse().find(message => message.role === 'assistant')?.content)
      .toBe(finalText)
  })

  it('does not verify success when required checks were never registered', async () => {
    const harness = makeHarness('mission-without-registered-checks')
    delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
    installAgent(harness, [
      { type: 'text_complete', text: 'Le correctif est prêt et les tests sont validés.' },
      { type: 'complete' },
    ], () => {
      const objective = harness.managed.activeObjective!
      objective.requiresAcceptanceCriteria = true
      objective.requiresExecutionEvidence = true
      delete objective.acceptanceCriteria
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.activeObjective?.terminalState).not.toBe('complete_verified')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({ attempts: 1, lastCause: 'objective_incomplete' })
    expect(harness.managed.messageQueue).toHaveLength(1)
  })

  it('does not recover after a completed read-only preflight reaches its explicit authority boundary', async () => {
    const harness = makeHarness('read-only-authority-boundary')
    const rootText = 'Déploie Zero sur le serveur de staging puis vérifie le service.'
    const root: Message = {
      id: 'zero-deployment-root', role: 'user', content: rootText, timestamp: Date.now() - 1,
    }
    harness.managed.messages.push(root)
    harness.managed.activeObjective = transitionObjectiveContract({
      messageId: root.id, text: root.content, nowMs: root.timestamp,
    })
    const events: AgentEvent[] = [
      { type: 'tool_start', toolName: 'mcp__rbw-servers__get_status', toolUseId: 'zero-preflight-call',
        input: { server: 'zero' } },
      { type: 'tool_result', toolName: 'mcp__rbw-servers__get_status', toolUseId: 'zero-preflight-call',
        result: '{"reachable":true}', isError: false, executed: true },
      { type: 'text_complete', text: '' },
      { type: 'complete' },
    ]
    installAgent(harness, events, () => {
      const current = harness.managed.activeObjective!
      const boundaryId = current.lastUserMessageId
      if (!boundaryId || boundaryId === current.userMessageId) {
        throw new Error('Expected the read-only restriction to remain a later objective amendment')
      }
      current.requiresAcceptanceCriteria = true
      current.acceptanceCriteria = [{
        id: 'zero-preflight', description: 'Zero staging preflight is reachable',
        toolName: 'mcp__rbw-servers__get_status', input: { server: 'zero' },
        checks: [{ path: '$.reachable', equals: true }],
      }]
      const receipt: ObjectiveOutcomeDeclaration = {
        state: 'blocked_human', criteria: [],
        remainingWork: ['Déployer Zero sur staging uniquement après une autorisation explicite'],
        blocker: { kind: 'external_authorization', description: 'Le déploiement reste hors autorité',
          evidence: [boundaryId] },
      }
      ;(events[2] as Extract<AgentEvent, { type: 'text_complete' }>).text =
        `Préflight lecture seule terminé ; aucune mutation n’a été exécutée.\n${outcomeComment(receipt)}`
    })

    await harness.manager.sendMessage(harness.managed.id,
      'Effectue uniquement le préflight Zero en lecture seule. N’effectue aucune mutation distante et ne déploie rien.')

    expect(harness.managed.activeObjective?.terminalState).toBe('blocked_human')
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.messages.some(message => message.hidden
      && message.content.includes('<automatic_turn_recovery'))).toBe(false)
    expect(harness.sentEvents.some(event => event["type"] === 'typed_error')).toBe(false)
  })
});
