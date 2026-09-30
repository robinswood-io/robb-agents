import { registerObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageToStored, storedToMessage, type AgentEvent, type Message, type ObjectiveOutcomeDeclaration } from '@craft-agent/core/types'
import { readSessionJsonl, writeSessionJsonl } from '@craft-agent/shared/sessions/jsonl'
import { pickSessionFields } from '@craft-agent/shared/sessions/utils'
import { checkObjectiveEvidenceBeforeMutation, clearObjectiveEvidenceGate, getObjectiveEvidenceCompletionGap } from '@craft-agent/shared/agent'
import { READ_ONLY_GIT_HARDENING_ARGS } from '@craft-agent/shared/agent/bash-validator'
import { StructuredMissionVerdictSchema } from '@craft-agent/shared/missions'
import { createPendingTurnRecovery } from './turn-recovery.ts'
import {
  buildAutonomyStructuredFallbackPrompt,
  createAutonomyFallbackIntent,
  isAutonomyStructuredFallbackPrompt,
} from './autonomy-browser-fallback.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { transitionObjectiveContract, turnProgressFingerprint } from './objective-contract.ts'

type Managed = ReturnType<typeof createManagedSession>

type CompletionEvent = {
  sessionId: string
  workspaceId: string
  reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  finalMessageId?: string
  finalText?: string
}

interface Harness {
  manager: SessionManager
  managed: Managed
  sentEvents: Array<Record<string, unknown>>
  telemetryNames: string[]
  resumedSessionIds: string[]
  completions: CompletionEvent[]
}

const roots: string[] = []
const sessionIds: string[] = []
const safeGit = `git ${READ_ONLY_GIT_HARDENING_ARGS.join(' ')}`

function makeHarness(id: string): Harness {
  const rootPath = mkdtempSync(join(tmpdir(), 'session-objective-outcome-'))
  roots.push(rootPath)
  sessionIds.push(id)
  const managed = createManagedSession({
    id,
    name: 'Objective outcome integration',
  }, {
    id: `workspace-${id}`,
    name: 'Objective outcome workspace',
    rootPath,
    createdAt: Date.now(),
  } as never, { messagesLoaded: true })
  const manager = new SessionManager()
  const sentEvents: Array<Record<string, unknown>> = []
  const telemetryNames: string[] = []
  const resumedSessionIds: string[] = []
  const completions: CompletionEvent[] = []
  const internals = manager as unknown as {
    sessions: Map<string, Managed>
    enqueuePersist: (session: Managed) => boolean
    flushSession: (sessionId: string) => Promise<void>
    sendEvent: (event: Record<string, unknown>) => void
    emitExecutionTelemetry: (_session: Managed, event: { name: string }) => void
    startGenerationTelemetry: () => void
    finishGenerationTelemetry: () => void
    beginAutomaticSessionStatusLifecycle: () => Promise<void>
    finishAutomaticSessionStatusLifecycle: () => Promise<void>
    isSessionBeingViewed: () => boolean
    markSessionRead: () => Promise<void>
    processNextQueuedMessage: (sessionId: string) => void
    disposeManagedAgentRuntime: () => Promise<void>
  }
  internals.sessions.set(id, managed)
  // Exercise the real persistence boundary's UI publication without disk writes.
  internals.enqueuePersist = () => true
  internals.flushSession = async () => {}
  internals.sendEvent = event => sentEvents.push(event)
  internals.emitExecutionTelemetry = (_session, event) => telemetryNames.push(event.name)
  internals.startGenerationTelemetry = () => {}
  internals.finishGenerationTelemetry = () => {}
  internals.beginAutomaticSessionStatusLifecycle = async () => {}
  internals.finishAutomaticSessionStatusLifecycle = async () => {}
  internals.isSessionBeingViewed = () => true
  internals.markSessionRead = async () => {}
  internals.processNextQueuedMessage = sessionId => resumedSessionIds.push(sessionId)
  internals.disposeManagedAgentRuntime = async () => {
    managed.agent = null
  }
  manager.onSessionComplete(event => completions.push(event as CompletionEvent))
  return { manager, managed, sentEvents, telemetryNames, resumedSessionIds, completions }
}

function installAgent(harness: Harness, events: AgentEvent[], beforeChat?: () => void): string[] {
  const redirected: string[] = []
  const agent = {
    async *chat(): AsyncGenerator<AgentEvent> {
      beforeChat?.()
      for (const event of events) yield event
    },
    getModel: () => 'test/objective-model',
    getSessionId: () => null,
    isProcessing: () => false,
    setAllSources: () => {},
    redirect: (message: string) => {
      redirected.push(message)
      return true
    },
  }
  harness.managed.agent = agent as never
  ;(harness.manager as unknown as {
    getOrCreateAgent: (session: Managed) => Promise<typeof agent>
  }).getOrCreateAgent = async session => {
    session.agent = agent as never
    return agent
  }
  return redirected
}

function bindLiveToolAdmission(harness: Harness): void {
  const agent = harness.managed.agent
  const userMessage = harness.managed.messages.findLast(message => message.role === 'user')
  if (!agent || !userMessage) throw new Error('Live tool admission requires an agent and user boundary')
  const runtime = harness.manager as unknown as {
    runtimeProcessingGenerations: WeakMap<object, number>
    runtimeToolAdmissionBindings: WeakMap<object, Record<string, unknown>>
    objectiveAuthorityEpochs: WeakMap<Managed, number>
  }
  runtime.runtimeProcessingGenerations.set(agent, harness.managed.processingGeneration)
  runtime.runtimeToolAdmissionBindings.set(agent, {
    managed: harness.managed,
    sessionId: harness.managed.id,
    generation: harness.managed.processingGeneration,
    activeObjective: harness.managed.activeObjective,
    authorityEpoch: runtime.objectiveAuthorityEpochs.get(harness.managed) ?? 0,
    userMessage,
    userMessageId: userMessage.id,
    messageCountAtHandoff: harness.managed.messages.length,
    lastSentOptions: harness.managed.lastSentOptions,
    automaticRecovery: harness.managed.lastSentOptions?.automaticRecovery,
    pendingTurnRecovery: harness.managed.pendingTurnRecovery,
    recoveryDispatch: harness.managed.pendingTurnRecovery?.recoveryDispatch,
  })
}

async function processEvent(harness: Harness, event: AgentEvent): Promise<void> {
  await (harness.manager as unknown as {
    processEvent: (session: Managed, event: AgentEvent, generation?: number) => Promise<void>
  }).processEvent(harness.managed, event, harness.managed.processingGeneration)
}

function enableAutomaticToolFallback(harness: Harness): void {
  writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    id: harness.managed.workspace.id,
    name: harness.managed.workspace.name,
    slug: harness.managed.workspace.id,
    createdAt: 1,
    updatedAt: 1,
    automaticToolFallbackEnabled: true,
  }))
}

function outcomeComment(declaration: ObjectiveOutcomeDeclaration): string {
  return `<!-- robb_objective_outcome ${JSON.stringify(declaration)} -->`
}

function activeObjective(userMessageId: string): NonNullable<Managed['activeObjective']> {
  return {
    schemaVersion: 1,
    objectiveId: userMessageId,
    userMessageId,
    lastUserMessageId: userMessageId,
    startedAt: Date.now(),
    budgetBaselineUsd: 0,
    tokenBaseline: 0,
    continuationCount: 0,
    orchestrationMode: 'mission',
    risk: 'standard',
    requiresExecutionEvidence: true,
    completionCriteria: [
      'requested-outcome-delivered',
      'relevant-checks-passed',
      'no-safe-work-remaining',
    ],
    terminalState: 'active',
  }
}

beforeEach(() => {
  roots.length = 0
  sessionIds.length = 0
})

afterEach(() => {
  for (const sessionId of sessionIds) clearObjectiveEvidenceGate(sessionId)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('SessionManager objective outcome integration', () => {
  it('exposes objective and recovery snapshots in the session DTO and publishes nested changes and clears', async () => {
    const harness = makeHarness('objective-snapshots')
    const persist = () => (harness.manager as unknown as {
      persistSession: (session: Managed) => void
    }).persistSession(harness.managed)
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
    expect((first.activeObjective as Managed['activeObjective'])?.acceptanceCriteria).toBeUndefined()
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
    const agent = harness.managed.agent as unknown as {
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
    const internals = harness.manager as unknown as {
      enqueuePersist: (session: Managed) => boolean
      flushSession: (sessionId: string) => Promise<void>
    }
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
    expect(baselineAdmissionDispatchedAtProviderDispatch).toEqual(fails ? undefined : expect.any(Number))
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
    const agent = harness.managed.agent as unknown as {
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
    ;(harness.manager as unknown as {
      flushSession: (sessionId: string) => Promise<void>
    }).flushSession = async () => {
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
    const sessions = (parent.manager as unknown as { sessions: Map<string, Managed> }).sessions
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
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
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
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
  })

  it('recovers instead of inventing an authority blocker for a purely read-only root mission', async () => {
    const harness = makeHarness('read-only-root-is-not-authority-boundary')
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
          evidence: [current.userMessageId] },
      }
      ;(events[2] as Extract<AgentEvent, { type: 'text_complete' }>).text =
        `Préflight lecture seule terminé ; aucune mutation n’a été exécutée.\n${outcomeComment(receipt)}`
    })

    await harness.manager.sendMessage(harness.managed.id,
      'Effectue uniquement le préflight Zero en lecture seule. N’effectue aucune mutation distante et ne déploie rien.')

    expect(harness.managed.activeObjective?.terminalState).toBe('active')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'objective_incomplete',
      validationGaps: ['blocker evidence does not reference a matching host-observed blocker'],
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('<automatic_turn_recovery')
  })

  it('replays the PLC checkpoint without accepting an invented pending confirmation', async () => {
    const harness = makeHarness('plc-invented-confirmation')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue',
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: false, evidence: ['assistant-final'] },
        { id: 'relevant-checks-passed', satisfied: false, evidence: ['assistant-final'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [
        'Attendre l’ouverture de l’accès et le contrat technique ISAGRI.',
        'Recevoir la confirmation d’envoi déjà demandée.',
        'Exécuter l’extraction ISAGRI réelle, la rapprocher de SharePoint et obtenir une revue indépendante PASS.',
      ],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Les parties sûres sont terminées ; la confirmation déjà demandée reste attendue.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      Object.assign(harness.managed.activeObjective!, {
        orchestrationMode: 'mission', risk: 'standard',
        completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      })
      delete harness.managed.activeObjective!.requiresExecutionEvidence
      delete harness.managed.activeObjective!.requiresObservationEvidence
      delete harness.managed.activeObjective!.requiresAcceptanceCriteria
      delete harness.managed.activeObjective!.acceptanceCriteria
      delete harness.managed.activeObjective!.evidenceRequirement
      delete harness.managed.activeObjective!.evidenceDomain
    })

    await harness.manager.sendMessage(harness.managed.id, 'Poursuis la mission PLC depuis les résultats déjà vérifiés.')

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'objective_incomplete',
      validationGaps: expect.arrayContaining([
        'remainingWork claims a pending human confirmation, but no structured question, authentication flow, or permission request is pending',
      ]),
    })
    expect(harness.managed.activeObjective?.lastOutcome).toBeUndefined()
    expect(harness.managed.messageQueue[0]?.message).toContain('no structured question, authentication flow, or permission request is pending')
  })

  it('normalizes a copied terminal criterion instead of spending a continuation retry on it', async () => {
    const harness = makeHarness('continued-no-safe-normalization')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue',
      criteria: [{ id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] }],
      remainingWork: ['Run the final target-bound verification'],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Verification remains.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id, 'Implémente la correction puis vérifie-la.')

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: receipt.remainingWork,
    })
    expect(harness.managed.activeObjective?.lastOutcome).toMatchObject({
      state: 'continue',
      criteria: [{ id: 'no-safe-work-remaining', satisfied: false, evidence: [] }],
    })
    expect(harness.managed.messageQueue[0]?.message).toContain('valid progress receipt')
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
  })

  it('accepts a concrete continuation before the first requested mutation executes', async () => {
    const harness = makeHarness('valid-pre-execution-continuation')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Inspect the current implementation, then apply the scoped parser fix'], blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Current state inspected; implementation remains.
${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id, 'Implémente la correction du parseur puis vérifie-la.')

    expect(harness.managed.activeObjective?.requiresExecutionEvidence).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: receipt.remainingWork,
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
  })

  it('continues corrective work when high-stakes evidence or review is still pending', async () => {
    const harness = makeHarness('valid-high-stakes-continuation')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Inspect the authoritative legal source, apply the scoped correction, then obtain a fresh independent review'],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `The source inspection and correction remain actionable.
${outcomeComment(receipt)}` },
      { type: 'complete' },
    ])

    await harness.manager.sendMessage(harness.managed.id,
      'Corrige ce contrat juridique après vérification des sources officielles, puis fais une revue indépendante.')

    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes', evidenceRequirement: 'authoritative-sources-before-mutation', terminalState: 'active',
    })
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: receipt.remainingWork,
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.messages.some(message => message.errorCode === 'objective_validation_failed')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
  })

  it.each(['app_restart', 'runtime_error', 'stream_ended', 'tool_checkpoint', 'premature_final',
    'objective_incomplete', 'evidence_gate'] as const)(
    'preserves validated continuation work and its logical origin across %s', async cause => {
      const harness = makeHarness(`continuation-${cause}`)
      harness.managed.messages.push({ id: 'continuation-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
      harness.managed.activeObjective = activeObjective('continuation-root')
      harness.managed.pendingTurnRecovery = {
        ...createPendingTurnRecovery('continuation-root', 1),
        lastCause: 'objective_continue',
        continuationWork: ['Run the final verification'],
        continuationOrigin: 'objective_continue',
      }
      const enqueue = (harness.manager as unknown as {
        enqueueAutomaticTurnRecovery: (
          managed: Managed,
          cause: 'app_restart' | 'runtime_error' | 'stream_ended' | 'tool_checkpoint' | 'premature_final'
            | 'objective_incomplete' | 'evidence_gate',
        ) => Promise<boolean>
      }).enqueueAutomaticTurnRecovery.bind(harness.manager)

      expect(await enqueue(harness.managed, cause)).toBe(true)
      expect(harness.managed.pendingTurnRecovery).toMatchObject({
        attempts: 1, lastCause: cause,
        continuationWork: ['Run the final verification'],
        continuationOrigin: 'objective_continue',
      })
      if (cause === 'evidence_gate') {
        expect(harness.managed.messageQueue[0]?.message).toContain('strictly read-only')
        expect(harness.managed.messageQueue[0]?.message).toContain('evidence-only pass must not execute it')
        expect(harness.managed.messageQueue[0]?.message).toContain('deferred until a later authorized continuation')
        expect(harness.managed.messageQueue[0]?.message).not.toContain('then resume without repeating')
        expect(harness.managed.messageQueue[0]?.message).not.toContain('remainingWork to execute')
      } else {
        expect(harness.managed.messageQueue[0]?.message).toContain('recovery event did not replace')
      }
      expect(harness.managed.messageQueue[0]?.message).toContain('Run the final verification')
    },
  )

  it('carries authenticated continuation provenance through a real structural tool checkpoint', async () => {
    const harness = makeHarness('continuation-real-tool-checkpoint')
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Edit', toolUseId: 'bounded-edit', input: { file_path: 'target.json' } },
      {
        type: 'tool_result', toolName: 'Edit', toolUseId: 'bounded-edit',
        result: 'Tool-call budget checkpoint', isError: false, executed: false,
        continuationRequired: true,
        checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'Continue in the next bounded pass.' },
      },
      { type: 'complete' },
    ], () => {
      Object.assign(harness.managed.pendingTurnRecovery!, {
        attempts: 1,
        lastCause: 'objective_continue',
        continuationWork: ['Finish the edit', 'Run the final verification'],
        continuationOrigin: 'objective_continue',
      })
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 2, lastCause: 'tool_checkpoint',
      continuationWork: ['Finish the edit', 'Run the final verification'],
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('tool-call budget reached a structural checkpoint')
    expect(harness.managed.messageQueue[0]?.message).toContain('Reconcile its preserved remainingWork')
    expect(harness.managed.messageQueue[0]?.message).toContain('Run the final verification')
  })

  it('preserves an authenticated continuation snapshot when a tool checkpoint exhausts its limit', async () => {
    const harness = makeHarness('continuation-exhausted-tool-checkpoint')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'continuation-exhausted-tool-checkpoint',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 1 } },
    }))
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Edit', toolUseId: 'bounded-edit', input: { file_path: 'target.json' } },
      {
        type: 'tool_result', toolName: 'Edit', toolUseId: 'bounded-edit',
        result: 'Tool-call budget checkpoint', isError: false, executed: false,
        continuationRequired: true,
        checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'Continue in the next bounded pass.' },
      },
      { type: 'complete' },
    ], () => {
      Object.assign(harness.managed.pendingTurnRecovery!, {
        attempts: 1,
        lastCause: 'objective_continue',
        continuationWork: ['Finish the edit', 'Run the final verification'],
        continuationOrigin: 'objective_continue',
      })
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis vérifie-le.')

    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      interruptedTurnRecovery: { recovery: {
        attempts: 1, lastCause: 'tool_checkpoint',
        continuationWork: ['Finish the edit', 'Run the final verification'],
        continuationOrigin: 'objective_continue',
      } },
    })
    expect(harness.managed.activeObjective?.interruptedTurnRecovery?.recovery.exhaustedAt).toBeNumber()
    expect(harness.managed.messages.some(message => message.role === 'error')).toBe(false)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'info', message: expect.stringContaining('structural tool checkpoint'),
    }))
  })

  it('does not invent continuation provenance for an unrelated premature final', async () => {
    const harness = makeHarness('unrelated-premature-final')
    harness.managed.messages.push({ id: 'premature-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('premature-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('premature-root', 1)
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (managed: Managed, cause: 'premature_final') => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)

    expect(await enqueue(harness.managed, 'premature_final')).toBe(true)
    expect(harness.managed.pendingTurnRecovery?.continuationOrigin).toBeUndefined()
    expect(harness.managed.pendingTurnRecovery?.continuationWork).toBeUndefined()
    expect(harness.managed.messageQueue[0]?.message).not.toContain('Host-preserved remainingWork')
  })

  it.each([0, 1, 2])(
    'preserves legacy maxAutomaticAttempts=%i for validated continuations when no dedicated limit exists', async maxAutomaticAttempts => {
      const harness = makeHarness(`continuation-budget-${maxAutomaticAttempts}`)
      writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
        schemaVersion: 1,
        id: harness.managed.workspace.id,
        name: harness.managed.workspace.name,
        slug: `continuation-budget-${maxAutomaticAttempts}`,
        createdAt: 1,
        updatedAt: 1,
        costControl: { recovery: { maxAutomaticAttempts } },
      }))
      harness.managed.messages.push({ id: 'budget-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
      harness.managed.activeObjective = activeObjective('budget-root')
      harness.managed.pendingTurnRecovery = createPendingTurnRecovery('budget-root', 1)
      const enqueue = (harness.manager as unknown as {
        enqueueAutomaticTurnRecovery: (
          managed: Managed,
          cause: 'objective_continue',
          gaps: string[],
          continuationWork: string[],
        ) => Promise<boolean>
      }).enqueueAutomaticTurnRecovery.bind(harness.manager)

      for (let attempt = 0; attempt < maxAutomaticAttempts; attempt += 1) {
        expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(true)
        expect(harness.managed.pendingTurnRecovery?.attempts).toBe(attempt + 1)
        harness.managed.messageQueue.length = 0
        harness.managed.messages.push({
          id: `progress-${attempt}`, role: 'tool', content: `verified-${attempt}`, timestamp: attempt + 2,
          toolName: 'Read', toolUseId: `progress-call-${attempt}`, toolStatus: 'completed', toolExecuted: true,
          toolInput: { path: `target-${attempt}.json` }, toolResult: `verified-${attempt}`,
        })
      }
      expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(false)
      expect(harness.managed.pendingTurnRecovery).toMatchObject({
        attempts: maxAutomaticAttempts,
        exhaustedAt: expect.any(Number),
        continuationOrigin: 'objective_continue',
      })
    },
  )

  it('allows four semantically progressing validated continuations by default', async () => {
    const harness = makeHarness('default-validated-continuation-budget')
    harness.managed.messages.push({ id: 'budget-root', role: 'user', content: 'Finish the target.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('budget-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('budget-root', 1)
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (
        managed: Managed,
        cause: 'objective_continue',
        gaps: string[],
        continuationWork: string[],
      ) => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(true)
      expect(harness.managed.pendingTurnRecovery?.attempts).toBe(attempt + 1)
      harness.managed.messageQueue.length = 0
      harness.managed.messages.push({
        id: `default-progress-${attempt}`, role: 'tool', content: `verified-${attempt}`, timestamp: attempt + 2,
        toolName: 'Read', toolUseId: `default-progress-call-${attempt}`, toolStatus: 'completed', toolExecuted: true,
        toolInput: { path: `default-target-${attempt}.json` }, toolResult: `verified-${attempt}`,
      })
    }

    expect(await enqueue(harness.managed, 'objective_continue', [], ['Finish verification'])).toBe(false)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 4,
      exhaustedAt: expect.any(Number),
      continuationOrigin: 'objective_continue',
    })
  })

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
    installAgent(harness, [
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
      ;(harness.manager as unknown as { sessions: Map<string, Managed> }).sessions.set(reviewer.id, reviewer)
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
    runtime.automaticAdmissionReservations.delete(harness.managed.id)

    installAgent(harness, [
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
    ;(harness.manager as unknown as { sessions: Map<string, Managed> }).sessions.set(reviewer.id, reviewer)

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
    expect((harness.manager as unknown as { deferredAutomaticSessions: Set<string> })
      .deferredAutomaticSessions.has(harness.managed.id)).toBe(true)

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
    ;(harness.manager as unknown as { sessions: Map<string, Managed> }).sessions.set(reviewer.id, reviewer)
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
    runtime.sessions.set(reserved.id, reserved)
    runtime.sessions.set(relaunched.id, relaunched)
    runtime.sessions.set(restoredRecovery.id, restoredRecovery)
    runtime.automaticAdmissionReservations.add(reserved.id)

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
    runtime.sessions.set(orphan.id, orphan)

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
    runtime.sessions.set(reviewer.id, reviewer)

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
    runtime.sessions.set(reviewer.id, reviewer)

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
    installAgent(harness, [
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
      ;(harness.manager as unknown as { sessions: Map<string, Managed> }).sessions.set(stale.id, stale)
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

  it('validates an explicitly read-only review with a legacy mutation flag at both live completion and restart', async () => {
    const harness = makeHarness('readonly-review-legacy')
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', remainingWork: [], blocker: null,
      criteria: [
        { id: 'existing-deployment', satisfied: true, evidence: ['read-existing'] },
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['read-existing'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['read-existing'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
    }
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Read', toolUseId: 'read-existing', input: { path: 'deployment.json' } },
      { type: 'tool_result', toolName: 'Read', toolUseId: 'read-existing', result: '{"verified":true}', isError: false, executed: true },
      { type: 'text_complete', text: `Déploiement existant vérifié en lecture seule.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria({
        ...harness.managed.activeObjective!, requiresExecutionEvidence: true,
      }, [{ id: 'existing-deployment', description: 'Existing deployment verified', toolName: 'Read', input: { path: 'deployment.json' }, checks: [{ path: '$.verified', equals: true }] }])
    })
    await harness.manager.sendMessage(harness.managed.id, 'Revue indépendante en lecture seule. Ne modifie rien. Vérifie le déploiement existant.')
    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.activeObjective?.requiresExecutionEvidence).toBe(true)
    expect(harness.managed.messages.filter(message => message.role === 'tool').map(message => message.toolName)).toEqual(['Read'])
    expect(harness.managed.messageQueue).toEqual([])
    const objective = harness.managed.activeObjective!
    objective.terminalState = 'active'
    objective.completedAt = undefined
    objective.lastOutcome = undefined
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery(objective.userMessageId)
    await (harness.manager as unknown as { resumePendingTurnAfterRestart: (id: string) => Promise<void> }).resumePendingTurnAfterRestart(harness.managed.id)
    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(objective.requiresExecutionEvidence).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
  })

  it.each(['satisfied', 'passed'])('accepts a verified completion receipt using %s backed by executed mutation and check results', async (fieldName) => {
    const harness = makeHarness(`verified-final-${fieldName}`)
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      criteria: [
        { id: 'requested-file-verified', satisfied: true, evidence: ['check-1'] },
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['write-1'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['check-1'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Write', toolUseId: 'write-1', input: { file_path: 'result.ts', content: 'export {}' } },
      { type: 'tool_result', toolName: 'Write', toolUseId: 'write-1', result: 'Wrote result.ts', isError: false, executed: true },
      { type: 'tool_start', toolName: 'Bash', toolUseId: 'check-1', input: { command: 'bun test result.ts' } },
      { type: 'tool_result', toolName: 'Bash', toolUseId: 'check-1', result: '{"file":"result.ts","passed":true}', isError: false, executed: true },
      { type: 'text_complete', text: `Implémentation vérifiée.\n${outcomeComment(receipt).replaceAll('"satisfied":', `"${fieldName}":`)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'requested-file-verified', description: 'Requested result.ts passes validation',
        toolName: 'Bash', input: { command: 'bun test result.ts' },
        checks: [{ path: 'file', equals: 'result.ts' }, { path: 'passed', equals: true }],
      }])
    })

    await harness.manager.sendMessage(harness.managed.id, 'Implémente le changement puis teste-le.')

    expect(harness.managed.activeObjective).toMatchObject({
      terminalState: 'complete_verified',
      lastOutcome: receipt,
      completedAt: expect.any(Number),
    })
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.completions).toHaveLength(1)
    expect(harness.completions[0]).toMatchObject({ reason: 'complete', finalText: 'Implémentation vérifiée.' })
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({ type: 'complete', reason: 'complete' }))
    const completeIndex = harness.sentEvents.findIndex(event => event.type === 'complete')
    expect(harness.sentEvents[completeIndex - 1]).toMatchObject({
      type: 'objective_changed',
      activeObjective: { terminalState: 'complete_verified', lastOutcome: receipt },
      pendingTurnRecovery: null,
    })
  })

  it('redirects a browser failure to the structured-access fallback prompt', async () => {
    const harness = makeHarness('structured-fallback')
    enableAutomaticToolFallback(harness)
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'structured-fallback-root', role: 'user', content: 'Inspecte la cible.', timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('structured-fallback-root')
    harness.managed.isProcessing = true
    bindLiveToolAdmission(harness)

    await processEvent(harness, {
      type: 'tool_start', toolName: 'mcp__session__browser_tool', toolUseId: 'browser-1', input: {},
    })

    await processEvent(harness, {
      type: 'tool_result',
      toolName: 'mcp__session__browser_tool',
      toolUseId: 'browser-1',
      result: 'UI navigation failed',
      isError: true,
      executed: true,
    })

    expect(redirected).toHaveLength(1)
    expect(isAutonomyStructuredFallbackPrompt(redirected[0]!)).toBe(true)
    expect(redirected[0]).toContain('native remote agent, SSH, database connection, application API')
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.messages.find(message => message.toolUseId === 'browser-1'))
      .toMatchObject({ toolStatus: 'error', toolExecuted: true })
  })

  it('does not synthesize a browser fallback when the active objective permits only a local or structured read', async () => {
    const harness = makeHarness('structured-read-excludes-browser-fallback')
    enableAutomaticToolFallback(harness)
    const redirected = installAgent(harness, [])
    const request = 'Réutilise les reçus persistants, effectue seulement une observation locale ou structurée strictement en lecture seule si un champ précis manque, puis clôture réellement l’objectif.'
    harness.managed.messages.push({
      id: 'structured-read-root', role: 'user', content: request, timestamp: 1,
    })
    harness.managed.activeObjective = {
      ...activeObjective('structured-read-root'), originalText: request,
    }
    harness.managed.isProcessing = true

    await processEvent(harness, {
      type: 'tool_start', toolName: 'mcp__crm__lookup', toolUseId: 'failed-structured-read', input: {},
    })
    await processEvent(harness, {
      type: 'tool_result', toolName: 'mcp__crm__lookup', toolUseId: 'failed-structured-read',
      result: 'HTTP 503 service unavailable', isError: true, executed: true,
    })

    expect(redirected).toEqual([])
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.autonomyEvents?.some(event => event.phase === 'fallback')).toBe(false)
  })

  it.each([
    ['browser', 'mcp__github__lookup', 'HTTP 503 service unavailable', 'browser_fallback', '<automatic_browser_fallback'],
    ['structured', 'mcp__session__browser_tool', 'UI navigation failed', 'structured_fallback', '<automatic_structured_fallback'],
  ] as const)('queues a bounded durable %s fallback when redirect is unavailable', async (
    _label, toolName, result, intentKind, marker,
  ) => {
    const harness = makeHarness(`bounded-${intentKind}`)
    enableAutomaticToolFallback(harness)
    installAgent(harness, [])
    ;(harness.managed.agent as any).redirect = () => false
    harness.managed.messages.push({ id: 'fallback-root', role: 'user', content: 'Inspecte la cible.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('fallback-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('fallback-root', 1)
    harness.managed.isProcessing = true
    bindLiveToolAdmission(harness)

    await processEvent(harness, { type: 'tool_start', toolName, toolUseId: 'failed-call', input: {} })
    await processEvent(harness, {
      type: 'tool_result', toolName, toolUseId: 'failed-call', result, isError: true, executed: true,
    })

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      recoveryDispatch: {
        phase: 'allocated', attempt: 1, cause: 'runtime_error',
        fallbackIntent: { kind: intentKind, failedToolName: toolName },
      },
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain(marker)
    expect(harness.managed.messageQueue[0]?.options?.automaticRecovery?.dispatchId)
      .toBe(harness.managed.pendingTurnRecovery?.recoveryDispatch?.id)
  })

  it.each(['budget', 'lease', 'stagnation'] as const)(
    'does not queue a specialized fallback after %s exhaustion', async boundary => {
      const harness = makeHarness(`fallback-${boundary}-exhausted`)
      enableAutomaticToolFallback(harness)
      harness.managed.messages.push({ id: 'fallback-root', role: 'user', content: 'Inspecte la cible.', timestamp: 1 })
      harness.managed.activeObjective = activeObjective('fallback-root')
      harness.managed.pendingTurnRecovery = {
        ...createPendingTurnRecovery('fallback-root', 1),
        ...(boundary === 'budget' ? { attempts: 8 }
          : boundary === 'lease' ? { leaseExpiresAt: Date.now() - 1 }
            : {
                lastProgressFingerprint: turnProgressFingerprint(harness.managed.messages, 'fallback-root'),
                stagnantAttempts: 1,
              }),
      }
      const runtime = harness.manager as any
      const intent = createAutonomyFallbackIntent('browser_fallback', 'mcp__crm__lookup')
      const queued = await runtime.enqueueAutomaticTurnRecovery(
        harness.managed, 'runtime_error', undefined, undefined, undefined, intent,
      )
      expect(queued).toBe(false)
      expect(harness.managed.messageQueue).toEqual([])
      expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    },
  )

  it('ignores a fallback event once the objective is complete_verified', async () => {
    const harness = makeHarness('terminal-fallback')
    enableAutomaticToolFallback(harness)
    harness.managed.messages.push({ id: 'fallback-root', role: 'user', content: 'Inspecte la cible.', timestamp: 1 })
    harness.managed.activeObjective = { ...activeObjective('fallback-root'), terminalState: 'complete_verified' }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('fallback-root', 1)
    const queued = await (harness.manager as any).enqueueAutomaticTurnRecovery(
      harness.managed,
      'runtime_error',
      undefined,
      undefined,
      undefined,
      createAutonomyFallbackIntent('browser_fallback', 'mcp__crm__lookup'),
    )
    expect(queued).toBe(false)
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.pendingTurnRecovery?.attempts).toBe(0)
  })

  it('cancels an allocated fallback when the objective completes before queue drain', async () => {
    const harness = makeHarness('terminal-after-fallback-allocation')
    enableAutomaticToolFallback(harness)
    harness.managed.messages.push({ id: 'fallback-root', role: 'user', content: 'Inspecte la cible.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('fallback-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('fallback-root', 1)
    harness.managed.isProcessing = true
    harness.managed.processingGeneration = 1
    expect(await (harness.manager as any).enqueueAutomaticTurnRecovery(
      harness.managed,
      'runtime_error',
      undefined,
      undefined,
      undefined,
      createAutonomyFallbackIntent('browser_fallback', 'mcp__crm__lookup'),
    )).toBe(true)
    expect(harness.managed.messageQueue).toHaveLength(1)

    harness.managed.activeObjective.terminalState = 'complete_verified'
    harness.managed.activeObjective.completedAt = Date.now()
    await (harness.manager as any).onProcessingStopped(harness.managed.id, 'complete', 1)

    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.resumedSessionIds).toEqual([])
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({ type: 'complete', reason: 'complete' }))
    expect(harness.completions).toHaveLength(1)
    expect(harness.completions[0]).toMatchObject({ reason: 'complete' })
  })

  it('resumes after restart when an active mission has a persisted invalid final receipt', async () => {
    const harness = makeHarness('restart-invalid-final')
    const userMessage: Message = {
      id: 'user-restart',
      role: 'user',
      content: 'Implémente le changement puis teste-le.',
      timestamp: 1,
    }
    harness.managed.messages.push(userMessage, {
      id: 'invalid-final',
      role: 'assistant',
      content: 'Résultat prétendument terminé.',
      timestamp: 2,
      objectiveOutcomeError: 'malformed objective outcome receipt',
    })
    harness.managed.activeObjective = activeObjective(userMessage.id)
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery(userMessage.id)

    await (harness.manager as unknown as {
      resumePendingTurnAfterRestart: (sessionId: string) => Promise<void>
    }).resumePendingTurnAfterRestart(harness.managed.id)

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'objective_incomplete',
      validationGaps: expect.arrayContaining(['malformed objective outcome receipt']),
    })
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messages.find(message => message.id === 'invalid-final')?.isIntermediate).toBe(true)
    expect(harness.resumedSessionIds).toEqual([harness.managed.id])
  })

  it('recognizes a persisted valid continue receipt and resumes its exact remaining work after restart', async () => {
    const harness = makeHarness('restart-valid-continuation')
    const userMessage: Message = {
      id: 'user-restart-continue', role: 'user',
      content: 'Implémente le changement puis teste-le.', timestamp: 1,
    }
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'continue', criteria: [],
      remainingWork: ['Run the final verification'], blocker: null,
    }
    harness.managed.messages.push(userMessage, {
      id: 'persisted-write', role: 'tool', content: 'Target updated', timestamp: 2,
      toolName: 'Write', toolUseId: 'persisted-write-call', toolStatus: 'completed',
      toolExecuted: true, toolInput: { file_path: 'target.json' }, toolResult: 'Target updated',
    }, {
      id: 'persisted-continue', role: 'assistant', content: 'Implementation checkpoint preserved.',
      timestamp: 3, objectiveOutcome: receipt,
    })
    harness.managed.activeObjective = activeObjective(userMessage.id)
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery(userMessage.id)

    await (harness.manager as unknown as {
      resumePendingTurnAfterRestart: (sessionId: string) => Promise<void>
    }).resumePendingTurnAfterRestart(harness.managed.id)

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1, lastCause: 'objective_continue', validationGaps: [],
      continuationWork: ['Run the final verification'],
      continuationOrigin: 'objective_continue',
    })
    expect(harness.managed.activeObjective?.lastOutcome).toEqual(receipt)
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('valid progress receipt')
    expect(harness.managed.messageQueue[0]?.message).toContain('Run the final verification')
    expect(harness.managed.messages.find(message => message.id === 'persisted-continue')?.isIntermediate).toBe(true)
    expect(harness.sentEvents.some(event => event.type === 'typed_error')).toBe(false)
    expect(harness.resumedSessionIds).toEqual([harness.managed.id])
  })

  it('surfaces a single bounded stop when a persisted recovery is exhausted at startup', async () => {
    const harness = makeHarness('restart-exhausted')
    harness.managed.messages.push({ id: 'user-root', role: 'user', content: 'Vérifie le résultat.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('user-root')
    harness.managed.pendingTurnRecovery = { ...createPendingTurnRecovery('user-root'), attempts: 256 }
    const resume = (harness.manager as unknown as {
      resumePendingTurnAfterRestart: (sessionId: string) => Promise<void>
    }).resumePendingTurnAfterRestart.bind(harness.manager)
    await resume(harness.managed.id)
    expect(harness.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    expect(harness.managed.messages.at(-1)).toMatchObject({ role: 'error', content: expect.stringContaining('Automatic continuation stopped after restart') })
    expect(harness.resumedSessionIds).toEqual([])
    await resume(harness.managed.id)
    expect(harness.sentEvents.filter(event => event.type === 'error')).toHaveLength(1)
  })

  it('normalizes blocked objectives to error for UI and conductor completion', async () => {
    const harness = makeHarness('blocked-completion')
    harness.managed.messages.push({
      id: 'user-blocked',
      role: 'user',
      content: 'Publish the release.',
      timestamp: 1,
    }, {
      id: 'assistant-blocked',
      role: 'assistant',
      content: 'MFA is required.',
      timestamp: 2,
    })
    harness.managed.activeObjective = {
      ...activeObjective('user-blocked'),
      terminalState: 'blocked_human',
    }
    harness.managed.isProcessing = true

    await (harness.manager as unknown as {
      onProcessingStopped: (sessionId: string, reason: 'complete') => Promise<void>
    }).onProcessingStopped(harness.managed.id, 'complete')

    expect(harness.sentEvents).toContainEqual(expect.objectContaining({ type: 'complete', reason: 'error' }))
    expect(harness.completions).toHaveLength(1)
    expect(harness.completions[0]?.reason).toBe('error')
  })

  it('emits the late real result and success telemetry after a non-executed checkpoint', async () => {
    const harness = makeHarness('late-tool-result')
    harness.managed.messages.push({
      id: 'late-tool-message',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolName: 'Write',
      toolUseId: 'late-write-1',
      toolStatus: 'completed',
      toolExecuted: false,
      toolResult: 'Tool-call budget checkpoint: Write was not executed.',
      toolCheckpoint: {
        schemaVersion: 1,
        kind: 'tool-call-budget',
        reason: 'Write was not executed before the lease expired.',
      },
    })

    await processEvent(harness, {
      type: 'tool_result',
      toolName: 'Write',
      toolUseId: 'late-write-1',
      result: 'Wrote result.ts',
      isError: false,
      executed: true,
    })

    expect(harness.managed.messages[0]).toMatchObject({
      toolStatus: 'completed',
      toolExecuted: true,
      toolResult: 'Wrote result.ts',
    })
    expect(harness.managed.messages[0]?.toolCheckpoint).toBeUndefined()
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolUseId: 'late-write-1',
      result: 'Wrote result.ts',
      executed: true,
    }))
    expect(harness.telemetryNames).toContain('tool.completed')
  })

  it('rehydrates only non-empty, actually executed evidence after a restart', () => {
    const harness = makeHarness('restart-evidence')
    const userMessage: Message = {
      id: 'user-legal',
      role: 'user',
      content: 'Corrige ce contrat juridique après vérification des sources.',
      timestamp: 1,
    }
    harness.managed.messages.push(userMessage, {
      id: 'checkpoint-read',
      role: 'tool',
      content: '',
      timestamp: 2,
      toolName: 'WebFetch',
      toolUseId: 'checkpoint-fetch',
      toolStatus: 'completed',
      toolExecuted: false,
      toolResult: 'https://legifrance.gouv.fr source officielle qui ne doit pas compter car l’appel n’a pas été exécuté.',
    }, {
      id: 'empty-read',
      role: 'tool',
      content: '',
      timestamp: 3,
      toolName: 'WebFetch',
      toolUseId: 'empty-fetch',
      toolStatus: 'completed',
      toolExecuted: true,
      toolResult: '',
    })
    harness.managed.activeObjective = {
      ...activeObjective(userMessage.id),
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
      completionCriteria: [
        'requested-outcome-delivered',
        'relevant-checks-passed',
        'no-safe-work-remaining',
        'independent-review-passed',
      ],
    }

    ;(harness.manager as unknown as {
      rehydrateObjectiveEvidence: (session: Managed) => void
    }).rehydrateObjectiveEvidence(harness.managed)
    expect(getObjectiveEvidenceCompletionGap(harness.managed.id)).toBe('authoritative evidence has not been inspected')

    harness.managed.messages.push({
      id: 'executed-read',
      role: 'tool',
      content: '',
      timestamp: 4,
      toolName: 'WebFetch',
      toolUseId: 'executed-fetch',
      toolStatus: 'completed',
      toolExecuted: true,
      toolResult: 'Source officielle consultée sur https://legifrance.gouv.fr avec le texte en vigueur et son article applicable.',
    })
    ;(harness.manager as unknown as {
      rehydrateObjectiveEvidence: (session: Managed) => void
    }).rehydrateObjectiveEvidence(harness.managed)
    expect(getObjectiveEvidenceCompletionGap(harness.managed.id)).toBe('independent review has not been completed')
  })

  it('rehydrates the high-stakes gate only from persisted objective authority', () => {
    const rehydrate = (harness: Harness) => (harness.manager as unknown as {
      rehydrateObjectiveEvidence: (session: Managed) => void
    }).rehydrateObjectiveEvidence(harness.managed)

    const readOnly = makeHarness('read-only-negated-high-stakes-words')
    readOnly.managed.messages.push({
      id: 'user-read-only-security',
      role: 'user',
      content: 'Analyse la sécurité du déploiement en lecture seule. Ne pas modifier les fichiers ni déployer.',
      timestamp: 1,
    })
    readOnly.managed.activeObjective = activeObjective('user-read-only-security')
    rehydrate(readOnly)
    expect(getObjectiveEvidenceCompletionGap(readOnly.managed.id)).toBeUndefined()

    const mutating = makeHarness('authorized-high-stakes-mutation')
    mutating.managed.messages.push({
      id: 'user-legal-mutation',
      role: 'user',
      content: 'Corrige ce contrat juridique après vérification des sources.',
      timestamp: 1,
    })
    mutating.managed.activeObjective = {
      ...activeObjective('user-legal-mutation'),
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    }
    rehydrate(mutating)
    expect(getObjectiveEvidenceCompletionGap(mutating.managed.id)).toBe('authoritative evidence has not been inspected')
  })

  it('rehydrates an amendment-promoted security gate and resets an older legal domain', () => {
    const rehydrate = (harness: Harness) => (harness.manager as unknown as {
      rehydrateObjectiveEvidence: (session: Managed) => void
    }).rehydrateObjectiveEvidence(harness.managed)

    const promoted = makeHarness('amendment-promoted-security')
    const promotedRoot: Message = {
      id: 'promoted-root', role: 'user', content: 'Prépare puis vérifie la page.', timestamp: 1,
    }
    const securityAmendment: Message = {
      id: 'security-amendment', role: 'user',
      content: 'Corrige maintenant les permissions de sécurité.', timestamp: 2,
    }
    promoted.managed.messages.push(promotedRoot, securityAmendment)
    promoted.managed.activeObjective = transitionObjectiveContract({
      existing: transitionObjectiveContract({
        messageId: promotedRoot.id, text: promotedRoot.content, nowMs: promotedRoot.timestamp,
      }),
      messageId: securityAmendment.id,
      text: securityAmendment.content,
      nowMs: securityAmendment.timestamp,
    })
    expect(promoted.managed.activeObjective.risk).toBe('high-stakes')
    rehydrate(promoted)
    expect(checkObjectiveEvidenceBeforeMutation(promoted.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })

    const changed = makeHarness('legal-to-security-amendment')
    const legalRoot: Message = {
      id: 'legal-root', role: 'user', content: 'Corrige ce contrat juridique.', timestamp: 1,
    }
    changed.managed.messages.push(legalRoot, {
      id: 'legal-source', role: 'tool', content: '', timestamp: 2,
      toolName: 'WebFetch', toolUseId: 'legal-source-call', toolStatus: 'completed',
      toolExecuted: true, isError: false,
      toolResult: 'Source juridique officielle consultée sur https://legifrance.gouv.fr avec le texte applicable.',
    })
    const legalObjective = transitionObjectiveContract({
      messageId: legalRoot.id, text: legalRoot.content, nowMs: legalRoot.timestamp,
    })
    changed.managed.activeObjective = legalObjective
    rehydrate(changed)
    expect(getObjectiveEvidenceCompletionGap(changed.managed.id)).toBe('independent review has not been completed')

    const changedAmendment: Message = {
      ...securityAmendment, id: 'changed-security-amendment', timestamp: 3,
    }
    changed.managed.messages.push(changedAmendment)
    changed.managed.activeObjective = transitionObjectiveContract({
      existing: legalObjective,
      messageId: changedAmendment.id,
      text: changedAmendment.content,
      nowMs: changedAmendment.timestamp,
    })
    rehydrate(changed)
    expect(getObjectiveEvidenceCompletionGap(changed.managed.id)).toBe('authoritative evidence has not been inspected')
    expect(checkObjectiveEvidenceBeforeMutation(changed.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it.each([
    'Fix the security vulnerability.',
    'Rotate the security credentials.',
    'Configure the RBAC permissions.',
  ])('rehydrates the host-authorized security domain for %s', text => {
    const harness = makeHarness(`security-authority-${text.split(' ')[0]!.toLowerCase()}`)
    const root: Message = { id: 'security-root', role: 'user', content: text, timestamp: 1 }
    harness.managed.messages.push(root)
    harness.managed.activeObjective = transitionObjectiveContract({
      messageId: root.id, text: root.content, nowMs: root.timestamp,
    })
    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    })

    ;(harness.manager as unknown as {
      rehydrateObjectiveEvidence: (session: Managed) => void
    }).rehydrateObjectiveEvidence(harness.managed)
    expect(checkObjectiveEvidenceBeforeMutation(harness.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it('uses a read-only audit subject only after a later deictic correction authorizes it', () => {
    const harness = makeHarness('read-only-security-amendment')
    const root: Message = {
      id: 'read-only-domain-root', role: 'user', content: 'Corrige ce contrat juridique.', timestamp: 1,
    }
    const amendment: Message = {
      id: 'read-only-security', role: 'user',
      content: 'Analyse les permissions de sécurité en lecture seule. Ne modifie rien.', timestamp: 2,
    }
    const correction: Message = {
      id: 'correct-security-findings', role: 'user', content: 'Fais les corrections nécessaires.', timestamp: 3,
    }
    harness.managed.messages.push(root, amendment, correction)
    const audited = transitionObjectiveContract({
      existing: transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: root.timestamp }),
      messageId: amendment.id, text: amendment.content, nowMs: amendment.timestamp,
    })
    expect(audited.evidenceDomain).toBe('legal')
    harness.managed.activeObjective = transitionObjectiveContract({
      existing: audited, messageId: correction.id, text: correction.content, nowMs: correction.timestamp,
    })
    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes', evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    })

    ;(harness.manager as unknown as {
      rehydrateObjectiveEvidence: (session: Managed) => void
    }).rehydrateObjectiveEvidence(harness.managed)
    expect(checkObjectiveEvidenceBeforeMutation(harness.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it('retains an older security gate anchor beyond the bounded amendment window', () => {
    const harness = makeHarness('long-amendment-security-anchor')
    const root: Message = {
      id: 'long-root', role: 'user', content: 'Prépare puis vérifie la page.', timestamp: 1,
    }
    const security: Message = {
      id: 'long-security', role: 'user',
      content: 'Corrige maintenant les permissions de sécurité.', timestamp: 2,
    }
    harness.managed.messages.push(root, security)
    let objective = transitionObjectiveContract({
      existing: transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: root.timestamp }),
      messageId: security.id, text: security.content, nowMs: security.timestamp,
    })
    for (let index = 0; index < 20; index += 1) {
      const presentation: Message = {
        id: `presentation-${index}`, role: 'user', content: `Utilise un ton simple ${index}.`, timestamp: 3 + index,
      }
      harness.managed.messages.push(presentation)
      objective = transitionObjectiveContract({
        existing: objective,
        messageId: presentation.id,
        text: presentation.content,
        nowMs: presentation.timestamp,
      })
    }
    const production: Message = {
      id: 'production-amendment', role: 'user',
      content: 'Déploie maintenant la page en production.', timestamp: 23,
    }
    harness.managed.messages.push(production)
    harness.managed.activeObjective = transitionObjectiveContract({
      existing: objective,
      messageId: production.id,
      text: production.content,
      nowMs: production.timestamp,
    })
    expect(harness.managed.activeObjective).toMatchObject({
      risk: 'high-stakes',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    })

    ;(harness.manager as unknown as {
      rehydrateObjectiveEvidence: (session: Managed) => void
    }).rehydrateObjectiveEvidence(harness.managed)
    expect(checkObjectiveEvidenceBeforeMutation(harness.managed.id, 'Write', 'local-write'))
      .toMatchObject({ allowed: false, reason: expect.stringContaining('security source') })
  })

  it('atomically replaces the objective and recovery anchor when a distinct user steer is accepted', async () => {
    const harness = makeHarness('distinct-steer')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-objective-a',
      role: 'user',
      content: 'Analyse le module A.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-objective-a')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-objective-a', 1)
    harness.managed.isProcessing = true

    await harness.manager.sendMessage(harness.managed.id, 'Nouvel objectif : crée et vérifie le rapport B.')

    const steeredUser = harness.managed.messages.at(-1)!
    expect(steeredUser.role).toBe('user')
    expect(harness.managed.activeObjective).toMatchObject({
      objectiveId: steeredUser.id,
      userMessageId: steeredUser.id,
      lastUserMessageId: steeredUser.id,
      continuationCount: 0,
      terminalState: 'active',
    })
    expect(harness.managed.pendingTurnRecovery?.userMessageId).toBe(steeredUser.id)
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toContain('Nouvel objectif : crée et vérifie le rapport B.')
    expect(redirected[0]).toContain(`objective_user_message_id="${steeredUser.id}"`)
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'user_message',
      status: 'accepted',
    }))
  })

  it('keeps the objective and recovery budgets when an accepted user steer clarifies the task', async () => {
    const harness = makeHarness('continuation-steer')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-root',
      role: 'user',
      content: 'Implémente et vérifie le changement.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-root')
    harness.managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery('user-root', 1),
      attempts: 3, stagnantAttempts: 1, leaseExpiresAt: 12345,
      validationGaps: ['Business criterion lacks matching post-action evidence: document'],
    }
    harness.managed.isProcessing = true

    await harness.manager.sendMessage(harness.managed.id, 'Le document reste illisible, utilise plutôt le navigateur.')

    const continuation = harness.managed.messages.at(-1)!
    expect(harness.managed.activeObjective).toMatchObject({
      objectiveId: 'user-root',
      userMessageId: 'user-root',
      lastUserMessageId: continuation.id,
      continuationCount: 1,
      terminalState: 'active',
    })
    expect(harness.managed.pendingTurnRecovery?.userMessageId).toBe(continuation.id)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 3, stagnantAttempts: 1, startedAt: 1, leaseExpiresAt: 12345,
      validationGaps: ['Business criterion lacks matching post-action evidence: document'],
    })
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toContain('objective_user_message_id="user-root"')
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('does not replace the running objective when an internal follow-up is queued', async () => {
    const harness = makeHarness('queued-follow-up')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-running-objective',
      role: 'user',
      content: 'Implémente et vérifie le changement A.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-running-objective')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-running-objective', 1)
    harness.managed.isProcessing = true

    await harness.manager.sendMessage(
      harness.managed.id,
      'Le spécialiste a terminé le rapport B.',
      undefined,
      undefined,
      { internalOrigin: { kind: 'agent-message', senderSessionId: 'specialist-b' } },
    )

    expect(redirected).toEqual([])
    expect(harness.managed.activeObjective).toMatchObject({
      objectiveId: 'user-running-objective',
      userMessageId: 'user-running-objective',
      lastUserMessageId: 'user-running-objective',
    })
    expect(harness.managed.pendingTurnRecovery?.userMessageId).toBe('user-running-objective')
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]).toMatchObject({
      message: 'Le spécialiste a terminé le rapport B.',
      options: { internalOrigin: { kind: 'agent-message', senderSessionId: 'specialist-b' } },
    })
    expect(harness.sentEvents).toContainEqual(expect.objectContaining({
      type: 'user_message',
      status: 'queued',
    }))
  })

  it('does not reset the parent objective or retry budget when a queued agent report is consumed', async () => {
    const harness = makeHarness('consumed-agent-report')
    harness.managed.messages.push({ id: 'parent-root', role: 'user', content: 'Vérifie le document.', timestamp: 1 })
    const objective = activeObjective('parent-root')
    harness.managed.activeObjective = objective
    harness.managed.pendingTurnRecovery = { ...createPendingTurnRecovery('parent-root', 1), attempts: 4 }
    let consumed = false
    installAgent(harness, [{ type: 'complete' }], () => {
      consumed = true
      expect(harness.managed.activeObjective).toEqual(objective)
      expect(harness.managed.pendingTurnRecovery).toMatchObject({ userMessageId: 'parent-root', attempts: 4, startedAt: 1 })
    })
    await harness.manager.sendMessage(harness.managed.id, 'Le spécialiste a terminé son rapport.', undefined, undefined, {
      internalOrigin: { kind: 'agent-message', senderSessionId: 'specialist' },
    })
    expect(consumed).toBe(true)
  })

  it('stops repeated contract rejection despite volatile successful tool output and persisted recovery', async () => {
    const harness = makeHarness('unchanged-contract')
    const rootText = 'Déploie le résultat demandé puis vérifie-le.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 })
    harness.managed.activeObjective = { ...activeObjective('root'), originalText: rootText }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('root')
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (managed: Managed, cause: 'objective_incomplete' | 'app_restart', gaps?: string[]) => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)
    const gaps = ['Business criterion lacks matching post-action evidence: delivered']
    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(true)
    harness.managed.messageQueue.length = 0
    harness.managed.messages.push({ id: 'date1', role: 'tool', content: '', timestamp: 2, toolName: 'Bash', toolInput: { command: 'date' }, toolResult: '12:00:01', toolStatus: 'completed', toolExecuted: true })
    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(false)
    harness.managed.messageQueue.length = 0
    harness.managed.messages.push({ id: 'date2', role: 'tool', content: '', timestamp: 3, toolName: 'Bash', toolInput: { command: 'date' }, toolResult: '12:00:02', toolStatus: 'completed', toolExecuted: true })
    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(false)
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    expect(harness.managed.messageQueue).toEqual([])
    harness.managed.pendingTurnRecovery = JSON.parse(JSON.stringify(harness.managed.pendingTurnRecovery))
    harness.managed.messages.push({ id: 'date3', role: 'tool', content: '', timestamp: 4, toolName: 'Bash', toolInput: { command: 'date' }, toolResult: '12:00:03', toolStatus: 'completed', toolExecuted: true })
    expect(await enqueue(harness.managed, 'app_restart')).toBe(false)
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('grants one escalated bounded recovery before maxNoProgress=1 exhausts the unchanged gap', async () => {
    const harness = makeHarness('bounded-escalation-before-exhaustion')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'bounded-escalation-before-exhaustion',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 4, maxNoProgressAttempts: 1 } },
    }))
    harness.managed.messages.push({ id: 'root', role: 'user', content: 'Vérifie le résultat en lecture seule.', timestamp: 1 })
    harness.managed.activeObjective = {
      ...activeObjective('root'),
      originalText: 'Vérifie le résultat en lecture seule.',
      requiresExecutionEvidence: false,
    }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('root')
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (
        managed: Managed,
        cause: 'objective_incomplete',
        gaps?: string[],
      ) => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)
    const gaps = ['missing structured objective outcome receipt']

    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(true)
    expect(harness.managed.messageQueue[0]?.message).toContain('attempt="1"')
    harness.managed.messageQueue.length = 0

    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({ attempts: 2, stagnantAttempts: 1 })
    expect(harness.managed.messageQueue[0]?.message).toContain('attempt="2"')
    harness.managed.messageQueue.length = 0

    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(false)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      stagnantAttempts: 1,
      exhaustedAt: expect.any(Number),
    })
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('keeps an execution recovery substantive when the only mutation is unrelated to its target', () => {
    const harness = makeHarness('unrelated-mutation-is-not-execution-proof')
    const rootText = 'Déploie le service Orion sur le serveur de production.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 }, {
      id: 'unrelated-write', role: 'tool', content: '', timestamp: 2,
      toolName: 'Write', toolUseId: 'unrelated-write', toolStatus: 'completed', toolExecuted: true,
      toolInput: { file_path: '/tmp/unrelated-note.txt' }, toolResult: 'Wrote unrelated note.',
    })
    harness.managed.activeObjective = {
      ...activeObjective('root'),
      originalText: rootText,
      requiresExecutionEvidence: true,
    }
    const classify = (harness.manager as unknown as {
      classifyAutomaticRecoveryWorkForSession: (
        managed: Managed,
        cause: 'objective_incomplete',
        gaps?: string[],
      ) => string
    }).classifyAutomaticRecoveryWorkForSession.bind(harness.manager)

    expect(classify(harness.managed, 'objective_incomplete', [
      'missing structured objective outcome receipt',
    ])).toBe('substantive')
  })

  it('routes terminal reconciliation recovery as read-only even when the root requested a mutation', () => {
    const harness = makeHarness('terminal-reconciliation-is-read-only')
    const rootText = 'Déploie le service Orion sur le serveur de production.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 })
    harness.managed.activeObjective = {
      ...activeObjective('root'),
      originalText: rootText,
      requiresExecutionEvidence: true,
      terminalReconciliation: { messageId: 'terminal-close', timestamp: 2 },
    }
    const classify = (harness.manager as unknown as {
      classifyAutomaticRecoveryWorkForSession: (
        managed: Managed,
        cause: 'objective_incomplete',
        gaps?: string[],
      ) => string
    }).classifyAutomaticRecoveryWorkForSession.bind(harness.manager)

    expect(classify(harness.managed, 'objective_incomplete', [
      'missing structured objective outcome receipt',
    ])).toBe('read-only-verification')
  })

  it('retains a rejected contract across an empty runtime diagnostic and exhausts only on the next unchanged rejection', async () => {
    const harness = makeHarness('runtime-keeps-validation-gap')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'runtime-keeps-validation-gap',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 4, maxNoProgressAttempts: 1 } },
    }))
    const rootText = 'Déploie le résultat demandé puis vérifie-le.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 })
    harness.managed.activeObjective = { ...activeObjective('root'), originalText: rootText }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('root')
    const enqueue = (harness.manager as unknown as {
      enqueueAutomaticTurnRecovery: (
        managed: Managed,
        cause: 'objective_incomplete' | 'runtime_error',
        gaps?: string[],
      ) => Promise<boolean>
    }).enqueueAutomaticTurnRecovery.bind(harness.manager)
    const gap = 'malformed objective outcome receipt: criteria[2].satisfied must be a boolean'

    expect(await enqueue(harness.managed, 'objective_incomplete', [gap])).toBe(true)
    harness.managed.messageQueue.length = 0
    expect(await enqueue(harness.managed, 'runtime_error', [])).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      stagnantAttempts: 0,
      validationGaps: [gap],
    })
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeUndefined()
    harness.managed.messageQueue.length = 0
    expect(await enqueue(harness.managed, 'objective_incomplete', [gap])).toBe(false)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      exhaustedAt: expect.any(Number),
      validationGaps: [gap],
    })
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('repairs only a persisted false completion contradicted by its own final receipt', () => {
    const harness = makeHarness('restore-unfinished-final')
    const unfinished: ObjectiveOutcomeDeclaration = {
      state: 'continue',
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: false, evidence: ['assistant-final'] },
        { id: 'no-safe-work-remaining', satisfied: false, evidence: ['assistant-final'] },
      ],
      remainingWork: ['Send and verify the two approved messages.'],
      blocker: null,
    }
    const final: Message = {
      id: 'unfinished-final', role: 'assistant', content: 'Two sends remain.',
      timestamp: 4, objectiveOutcome: unfinished,
    }
    const restored = createManagedSession({
      id: 'restored-unfinished',
      lastFinalMessageId: final.id,
      activeObjective: {
        ...activeObjective('root'), startedAt: 1,
        terminalState: 'complete_verified', completedAt: 5,
      },
    }, harness.managed.workspace, { messagesLoaded: true, messages: [final] })
    expect(restored.activeObjective).toMatchObject({
      terminalState: 'exhausted', lastOutcome: unfinished,
    })
    expect(restored.activeObjective?.completedAt).toBeUndefined()
    expect(restored.pendingTurnRecovery).toBeUndefined()

    const unrelated = createManagedSession({
      id: 'restored-unrelated', lastFinalMessageId: 'other-final',
      activeObjective: {
        ...activeObjective('root'), startedAt: 1,
        terminalState: 'complete_verified', completedAt: 5,
      },
    }, harness.managed.workspace, { messagesLoaded: true, messages: [final] })
    expect(unrelated.activeObjective?.terminalState).toBe('complete_verified')

    const duplicate = createManagedSession({
      id: 'restored-duplicate', lastFinalMessageId: final.id,
      activeObjective: {
        ...activeObjective('root'), startedAt: 1,
        terminalState: 'complete_verified', completedAt: 5,
      },
    }, harness.managed.workspace, { messagesLoaded: true, messages: [final, { ...final }] })
    expect(duplicate.activeObjective?.terminalState).toBe('complete_verified')
  })

  it('never marks a delivered final as verified when registered outcome evidence is missing', async () => {
    const harness = makeHarness('final-with-unmet-objective')
    const declaration: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['assistant-final'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
        { id: 'target-verified', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Travail annoncé.\n${outcomeComment(declaration)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.pendingTurnRecovery = {
        ...harness.managed.pendingTurnRecovery!, attempts: 256,
      }
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'target-verified', description: 'Read the requested result',
        toolName: 'Read', input: { path: 'target.json' }, checks: [{ path: '$.valid', equals: true }],
      }])
    })

    await harness.manager.sendMessage(harness.managed.id, 'Livre le résultat et vérifie target.json.')
    expect(harness.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(harness.managed.activeObjective?.completedAt).toBeUndefined()
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      exhaustedAt: expect.any(Number),
      validationGaps: expect.arrayContaining([
        'Business criterion lacks matching post-action evidence: target-verified',
      ]),
    })
    expect(harness.managed.messages.findLast(message => message.role === 'error'))
      .toMatchObject({ errorCode: 'objective_validation_failed', errorCanRetry: true })
  })

  it('preserves the actual exhausted validation diagnostic across disk, restart and retry without resetting its objective budget', async () => {
    const harness = makeHarness('durable-validation-failure')
    const invalidFinal: AgentEvent[] = [
      { type: 'text_complete', text: 'Résultat conservé. <!-- robb_objective_outcome {"state":"complete_verified"} -->' },
      { type: 'complete' },
    ]
    installAgent(harness, invalidFinal, () => {
      harness.managed.pendingTurnRecovery = {
        ...harness.managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 7,
        validationGaps: ['Previous rejection which is no longer the current diagnostic'],
      }
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'saved-target', description: 'Existing target must be verified', toolName: 'Read',
        input: { path: 'target.json' }, checks: [{ path: '$.valid', equals: true }],
      }])
      harness.managed.messages.push({
        id: 'preserved-action', role: 'tool', content: '', timestamp: Date.now(),
        toolName: 'Write', toolUseId: 'existing-write', toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: 'target.json' }, toolResult: 'The requested target was saved successfully.',
      })
      harness.managed.messages.push({
        id: 'preserved-check', role: 'tool', content: '', timestamp: Date.now(),
        toolName: 'Read', toolUseId: 'provider-check-id', toolStatus: 'completed', toolExecuted: true,
        toolInput: { path: 'target.json' }, toolResult: '{"valid":true}',
      })
    })
    await harness.manager.sendMessage(harness.managed.id, 'Implémente le résultat puis teste-le.')
    const diagnostic = 'malformed objective outcome receipt: criteria must be a bounded array'
    const stopped = structuredClone(harness.managed.pendingTurnRecovery)
    expect(structuredClone(stopped)).toMatchObject({ attempts: 256, stagnantAttempts: 7, lastCause: 'objective_incomplete', exhaustedAt: expect.any(Number), validationGaps: expect.arrayContaining([diagnostic]) })
    expect(stopped?.validationGaps).not.toContain('Previous rejection which is no longer the current diagnostic')
    const error = harness.managed.messages.at(-1)!
    expect(structuredClone(error)).toMatchObject({ role: 'error', errorCode: 'objective_validation_failed', errorCanRetry: true, errorDetails: expect.arrayContaining([diagnostic]) })
    expect(harness.sentEvents.findLast(event => event.type === 'typed_error')).toMatchObject({ error: { code: 'objective_validation_failed', details: error.errorDetails } })

    const path = join(harness.managed.workspace.rootPath, 'session.jsonl')
    writeSessionJsonl(path, {
      ...pickSessionFields(harness.managed), workspaceRootPath: harness.managed.workspace.rootPath,
      createdAt: 1, lastUsedAt: Date.now(), messages: harness.managed.messages.map(messageToStored),
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as never)
    const persisted = readSessionJsonl(path)!
    const restored = createManagedSession(persisted as never, harness.managed.workspace, {
      messagesLoaded: true, messages: persisted.messages.map(storedToMessage),
    })
    harness.managed = restored
    const internals = harness.manager as unknown as {
      sessions: Map<string, Managed>; flushSession: () => Promise<void>;
      resumePendingTurnAfterRestart: (sessionId: string) => Promise<void>;
    }
    internals.sessions.set(restored.id, restored)
    await internals.resumePendingTurnAfterRestart(restored.id)
    expect(restored.isProcessing).toBe(false)
    expect(restored.messageQueue).toEqual([])
    expect(restored.pendingTurnRecovery).toEqual(stopped)
    const objective = structuredClone(restored.activeObjective)
    const originalMessages = structuredClone(restored.messages)
    const userId = restored.messages.find(message => message.role === 'user' && !message.hidden)!.id

    internals.flushSession = async () => { throw new Error('Fixture retry marker flush failed') }
    await expect(harness.manager.retryTurn(restored.id, userId)).rejects.toThrow('Fixture retry marker flush failed')
    expect(restored.pendingTurnRecovery).toEqual(stopped)
    expect(restored.activeObjective).toEqual(objective)
    expect(restored.messages).toEqual(originalMessages)
    expect(restored.isProcessing).toBe(false)
    internals.flushSession = async () => {}
    installAgent(harness, invalidFinal)
    let dispatch: Promise<void> | undefined
    const send = harness.manager.sendMessage.bind(harness.manager)
    harness.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    await expect(harness.manager.retryTurn(restored.id, userId)).resolves.toEqual({ status: 'started' })
    expect(restored.lastSentMessage).toContain(diagnostic)
    expect(restored.lastSentMessage).toContain('Do not repeat an external mutation')
    expect(restored.lastSentMessage).toContain('"messageId":"preserved-check"')
    await dispatch
    expect(structuredClone(restored.pendingTurnRecovery)).toMatchObject({ attempts: 256, stagnantAttempts: 7, exhaustedAt: expect.any(Number), validationGaps: expect.arrayContaining([diagnostic]) })
    expect(restored.activeObjective).toEqual(objective)
    expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(restored.messages.filter(message => message.role === 'tool')).toEqual(originalMessages.filter(message => message.role === 'tool'))

    installAgent(harness, [{ type: 'text_complete', text: 'Une phrase nouvelle.' }, { type: 'complete' }], () => {
      expect(restored.pendingTurnRecovery?.attempts).toBe(0)
      expect(restored.activeObjective?.userMessageId).not.toBe(userId)
      expect(restored.activeObjective?.acceptanceCriteria).toBeUndefined()
    })
    await harness.manager.sendMessage(restored.id, 'Nouvel objectif : bonjour.')
    expect(restored.activeObjective?.terminalState).toBe('complete_verified')
    expect(restored.pendingTurnRecovery).toBeUndefined()
  })

  it.each(['setup', 'network'])('keeps the exhausted validation budget when an accepted retry fails during %s and does not restart it automatically', async failure => {
    const harness = makeHarness(`validation-retry-${failure}`)
    installAgent(harness, [
      { type: 'text_complete', text: 'Résultat fixture. <!-- robb_objective_outcome {"state":"complete_verified"} -->' },
      { type: 'complete' },
    ], () => { harness.managed.pendingTurnRecovery = { ...harness.managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 7 } })
    await harness.manager.sendMessage(harness.managed.id, 'Implémente le résultat puis vérifie-le.')
    const stopped = structuredClone(harness.managed.pendingTurnRecovery!)
    const root = harness.managed.activeObjective!.userMessageId
    if (failure === 'setup') {
      ;(harness.manager as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => { throw new Error('Fixture runtime unavailable before provider startup') }
      harness.managed.agent = null
    } else {
      installAgent(harness, [
        { type: 'typed_error', error: { code: 'network_error', title: 'Fixture network failure', message: 'Connection unavailable', actions: [], canRetry: true } },
        { type: 'complete' },
      ])
    }
    let dispatch: Promise<void> | undefined
    const send = harness.manager.sendMessage.bind(harness.manager)
    harness.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    await expect(harness.manager.retryTurn(harness.managed.id, root)).resolves.toEqual({ status: 'started' })
    await dispatch
    expect(harness.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(harness.managed.pendingTurnRecovery?.attempts).toBe(stopped.attempts)
    expect(harness.managed.pendingTurnRecovery?.stagnantAttempts).toBe(stopped.stagnantAttempts)
    expect(harness.managed.pendingTurnRecovery?.validationGaps).toEqual(stopped.validationGaps)
    expect(harness.managed.pendingTurnRecovery?.validationExhausted).toBe(true)
    expect(harness.managed.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(harness.managed.isProcessing).toBe(false)
    harness.manager.retryTurn = async () => { throw new Error('A stopped retry must not start automatically') }
    const marker = structuredClone(harness.managed.pendingTurnRecovery)
    await (harness.manager as unknown as { resumePendingTurnAfterRestart: (id: string) => Promise<void> }).resumePendingTurnAfterRestart(harness.managed.id)
    expect(harness.managed.pendingTurnRecovery).toEqual(marker)
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('accepts exact absolute input and JSON output from the actual event persistence path without another turn', async () => {
    const harness = makeHarness('exact-tool-evidence')
    const target = join(process.cwd(), 'output.json')
    const command = `cat '${target}'`
    const result = JSON.stringify({ path: target, passed: true })
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        { id: 'document-verified', satisfied: true, evidence: ['verify-document'] },
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['verify-document'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['verify-document'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
    }
    installAgent(harness, [
      { type: 'tool_start', toolName: 'Bash', toolUseId: 'verify-document', input: { command } },
      { type: 'tool_result', toolName: 'Bash', toolUseId: 'verify-document', result, isError: false, executed: true },
      { type: 'text_complete', text: `Document vérifié.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'document-verified', description: 'Document exact inspected', toolName: 'functions.bash',
        input: { command }, checks: [{ path: '$.path', equals: target }, { path: '$.passed', equals: true }],
      }])
    })
    await harness.manager.sendMessage(harness.managed.id, 'Vérifie le document demandé.')
    const tool = harness.managed.messages.find(message => message.toolUseId === 'verify-document')!
    expect(tool.toolInput).toEqual({ command })
    expect(tool.toolResult).toBe(result)
    expect(messageToStored(tool).toolInput).toEqual({ command })
    expect(messageToStored(tool).toolResult).toBe(result)
    expect(harness.sentEvents.find(event => event.type === 'tool_start')?.toolInput).toEqual({ command })
    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.resumedSessionIds).toEqual([])
  })

  it('does not credit a late pre-steer tool result to the new objective or its recovery checkpoint', async () => {
    const harness = makeHarness('late-result-objective-scope')
    installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-old-root',
      role: 'user',
      content: 'Analyse le module précédent.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-old-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-old-root', 1)
    harness.managed.isProcessing = true

    await processEvent(harness, {
      type: 'tool_start',
      toolName: 'WebFetch',
      toolUseId: 'old-fetch',
      input: { url: 'https://legifrance.gouv.fr/old-objective' },
    })
    await harness.manager.sendMessage(
      harness.managed.id,
      'Nouvel objectif : corrige ce contrat juridique puis vérifie-le.',
    )
    const newObjectiveUserId = harness.managed.messages.at(-1)!.id
    expect(harness.managed.activeObjective?.userMessageId).toBe(newObjectiveUserId)

    await processEvent(harness, {
      type: 'tool_result',
      toolName: 'WebFetch',
      toolUseId: 'old-fetch',
      result: 'Source officielle consultée sur https://legifrance.gouv.fr avec le texte en vigueur et son article applicable.',
      isError: false,
      executed: true,
      continuationRequired: true,
    })

    expect(getObjectiveEvidenceCompletionGap(harness.managed.id)).toBe('authoritative evidence has not been inspected')
    expect(harness.managed.pendingTurnRecovery).toMatchObject({ userMessageId: newObjectiveUserId })
    expect(harness.managed.pendingTurnRecovery?.continuationRequired).toBeUndefined()
    expect(harness.managed.autonomyEvents?.some(event => (
      event.phase === 'verified' && event.toolName === 'WebFetch'
    )) ?? false).toBe(false)
  })

  it('requeues an undelivered accepted steer with its original identity and restores the prior objective', async () => {
    const harness = makeHarness('undelivered-user-steer')
    const redirected = installAgent(harness, [])
    const originalObjective = activeObjective('user-objective-a')
    const originalRecovery = createPendingTurnRecovery('user-objective-a', 1)
    harness.managed.messages.push({
      id: 'user-objective-a',
      role: 'user',
      content: 'Analyse le module A.',
      timestamp: 1,
    })
    harness.managed.activeObjective = originalObjective
    harness.managed.pendingTurnRecovery = originalRecovery
    harness.managed.isProcessing = true
    const steerOptions = { optimisticMessageId: 'optimistic-objective-b' }
    const originalText = 'Nouvel objectif : crée et vérifie le rapport B.'

    await harness.manager.sendMessage(
      harness.managed.id,
      originalText,
      undefined,
      undefined,
      steerOptions,
    )
    const steeredMessage = harness.managed.messages.at(-1)!
    expect(redirected).toHaveLength(1)
    expect(redirected[0]).toContain('<host_objective_contract')
    expect(harness.managed.activeObjective?.userMessageId).toBe(steeredMessage.id)

    await processEvent(harness, { type: 'steer_undelivered', message: redirected[0]! })
    await processEvent(harness, { type: 'steer_undelivered', message: redirected[0]! })

    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]).toMatchObject({
      message: originalText,
      messageId: steeredMessage.id,
      optimisticMessageId: steerOptions.optimisticMessageId,
    })
    expect(harness.managed.messageQueue[0]?.options).toBe(steerOptions)
    expect(harness.managed.activeObjective).toBe(originalObjective)
    expect(harness.managed.pendingTurnRecovery).toBe(originalRecovery)
    expect(steeredMessage.content).toBe(originalText)
    expect(steeredMessage.content).not.toContain('host_objective_contract')
    expect(harness.managed.messageQueue[0]?.message).not.toContain('host_objective_contract')
    expect(harness.sentEvents.filter(event => event.type === 'user_message')).toHaveLength(1)
  })

  it('requeues an undelivered structured fallback as a hidden automatic runtime recovery', async () => {
    const harness = makeHarness('undelivered-structured-fallback')
    enableAutomaticToolFallback(harness)
    harness.managed.messages.push({
      id: 'user-fallback-root',
      role: 'user',
      content: 'Inspecte le système distant.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-fallback-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-fallback-root', 1)
    const fallbackPrompt = buildAutonomyStructuredFallbackPrompt('mcp__session__browser_tool')

    await processEvent(harness, { type: 'steer_undelivered', message: fallbackPrompt })
    const allocation = structuredClone(harness.managed.pendingTurnRecovery?.recoveryDispatch)
    await processEvent(harness, { type: 'steer_undelivered', message: fallbackPrompt })

    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      recoveryDispatch: {
        phase: 'allocated',
        attempt: 1,
        cause: 'runtime_error',
        origin: 'automatic',
        fallbackIntent: {
          kind: 'structured_fallback',
          failedToolName: 'mcp__session__browser_tool',
        },
      },
    })
    expect(harness.managed.pendingTurnRecovery?.recoveryDispatch).toEqual(allocation)
    expect(harness.managed.messageQueue).toHaveLength(1)
    expect(harness.managed.messageQueue[0]?.message).toContain('<automatic_turn_recovery')
    expect(harness.managed.messageQueue[0]?.message).toContain(fallbackPrompt)
    expect(harness.managed.messageQueue[0]?.options).toMatchObject({
      hidden: true,
      internalOrigin: { kind: 'browser-fallback' },
      automaticRecovery: {
        originalUserMessageId: 'user-fallback-root',
        cause: 'runtime_error',
        dispatchAttempt: 1,
      },
    })
    expect(harness.managed.messages).toHaveLength(1)
    expect(harness.managed.wasInterrupted).toBe(true)
  })
})
