import { registerObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageToStored, type AgentEvent, type Message, type ObjectiveOutcomeDeclaration } from '@craft-agent/core/types'
import { clearObjectiveEvidenceGate, getObjectiveEvidenceCompletionGap } from '@craft-agent/shared/agent'
import { createPendingTurnRecovery } from './turn-recovery.ts'
import {
  buildAutonomyStructuredFallbackPrompt,
  isAutonomyStructuredFallbackPrompt,
} from './autonomy-browser-fallback.ts'
import { SessionManager, createManagedSession } from './SessionManager.ts'

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
    persistSession: (session: Managed) => void
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
  internals.persistSession = () => {}
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

async function processEvent(harness: Harness, event: AgentEvent): Promise<void> {
  await (harness.manager as unknown as {
    processEvent: (session: Managed, event: AgentEvent, generation?: number) => Promise<void>
  }).processEvent(harness.managed, event, harness.managed.processingGeneration)
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
    })
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
    })
  })

  it('demotes a false mission final and queues a bounded recovery carrying validation gaps', async () => {
    const harness = makeHarness('false-final')
    installAgent(harness, [
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
    expect(harness.resumedSessionIds).toEqual([harness.managed.id])
    expect(harness.completions).toEqual([])
  })

  it('accepts a verified completion receipt backed by executed mutation and check results', async () => {
    const harness = makeHarness('verified-final')
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
      { type: 'text_complete', text: `Implémentation vérifiée.\n${outcomeComment(receipt)}` },
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
  })

  it('redirects a browser failure to the structured-access fallback prompt', async () => {
    const harness = makeHarness('structured-fallback')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'browser-tool-message',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolName: 'mcp__session__browser_tool',
      toolUseId: 'browser-1',
      toolStatus: 'executing',
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
    expect(harness.managed.messages[0]).toMatchObject({ toolStatus: 'error', toolExecuted: true })
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
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery(userMessage.id, 1)

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

  it('keeps the objective root while anchoring recovery to an accepted continuation steer', async () => {
    const harness = makeHarness('continuation-steer')
    const redirected = installAgent(harness, [])
    harness.managed.messages.push({
      id: 'user-root',
      role: 'user',
      content: 'Implémente et vérifie le changement.',
      timestamp: 1,
    })
    harness.managed.activeObjective = activeObjective('user-root')
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('user-root', 1)
    harness.managed.isProcessing = true

    await harness.manager.sendMessage(harness.managed.id, 'Poursuis.')

    const continuation = harness.managed.messages.at(-1)!
    expect(harness.managed.activeObjective).toMatchObject({
      objectiveId: 'user-root',
      userMessageId: 'user-root',
      lastUserMessageId: continuation.id,
      continuationCount: 1,
      terminalState: 'active',
    })
    expect(harness.managed.pendingTurnRecovery?.userMessageId).toBe(continuation.id)
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

    expect(harness.managed.messageQueue).toEqual([{
      message: fallbackPrompt,
      options: {
        hidden: true,
        internalOrigin: { kind: 'browser-fallback' },
        automaticRecovery: {
          originalUserMessageId: 'user-fallback-root',
          cause: 'runtime_error',
        },
      },
    }])
    expect(harness.managed.messages).toHaveLength(1)
    expect(harness.managed.wasInterrupted).toBe(true)
  })
})
