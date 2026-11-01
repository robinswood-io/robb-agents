import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { type Message, type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { createAutonomyFallbackIntent, isAutonomyStructuredFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { turnProgressFingerprint } from "./objective-contract.ts";
import { activeObjective, bindLiveToolAdmission, enableAutomaticToolFallback, installAgent, installReviewedAgent, makeHarness, outcomeComment, processEvent, roots, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

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
    delete objective.completedAt;
    delete objective.lastOutcome;
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery(objective.userMessageId)
    await (sessionManagerForTest(harness.manager)).resumePendingTurnAfterRestart(harness.managed.id)
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
    installReviewedAgent(harness, [
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

    expect<unknown>(harness.managed.activeObjective).toMatchObject({
      terminalState: 'complete_verified',
      lastOutcome: receipt,
      completedAt: (expect.any(Number) as unknown),
    })
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.completions).toHaveLength(1)
    expect(harness.completions[0]).toMatchObject({ reason: 'complete', finalText: 'Implémentation vérifiée.' })
    expect<unknown>(harness.sentEvents).toContainEqual((expect.objectContaining({ type: 'complete', reason: 'complete' }) as unknown))
    const completeIndex = harness.sentEvents.findIndex(event => event["type"] === 'complete')
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
    ;harness.managed.agent!.redirect = () => false
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
      const runtime = sessionManagerForTest(harness.manager)
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
    const queued = await (sessionManagerForTest(harness.manager)).enqueueAutomaticTurnRecovery(
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
    expect(await (sessionManagerForTest(harness.manager)).enqueueAutomaticTurnRecovery(
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
    await (sessionManagerForTest(harness.manager)).onProcessingStopped(harness.managed.id, 'complete', 1)

    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.managed.pendingTurnRecovery).toBeUndefined()
    expect(harness.resumedSessionIds).toEqual([])
    expect<unknown>(harness.sentEvents).toContainEqual((expect.objectContaining({ type: 'complete', reason: 'complete' }) as unknown))
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

    await (sessionManagerForTest(harness.manager)).resumePendingTurnAfterRestart(harness.managed.id)

    expect<unknown>(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'objective_incomplete',
      validationGaps: (expect.arrayContaining(['malformed objective outcome receipt']) as unknown),
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

    await (sessionManagerForTest(harness.manager)).resumePendingTurnAfterRestart(harness.managed.id)

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
    expect(harness.sentEvents.some(event => event["type"] === 'typed_error')).toBe(false)
    expect(harness.resumedSessionIds).toEqual([harness.managed.id])
  })

  it('surfaces a single bounded stop when a persisted recovery is exhausted at startup', async () => {
    const harness = makeHarness('restart-exhausted')
    harness.managed.messages.push({ id: 'user-root', role: 'user', content: 'Vérifie le résultat.', timestamp: 1 })
    harness.managed.activeObjective = activeObjective('user-root')
    harness.managed.pendingTurnRecovery = { ...createPendingTurnRecovery('user-root'), attempts: 256 }
    const resume = (sessionManagerForTest(harness.manager)).resumePendingTurnAfterRestart.bind(harness.manager)
    await resume(harness.managed.id)
    expect(harness.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    expect<unknown>(harness.managed.messages.at(-1)).toMatchObject({ role: 'error', content: (expect.stringContaining('Automatic continuation stopped after restart') as unknown) })
    expect(harness.resumedSessionIds).toEqual([])
    await resume(harness.managed.id)
    expect(harness.sentEvents.filter(event => event["type"] === 'error')).toHaveLength(1)
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

    await (sessionManagerForTest(harness.manager)).onProcessingStopped(harness.managed.id, 'complete')

    expect<unknown>(harness.sentEvents).toContainEqual((expect.objectContaining({ type: 'complete', reason: 'error' }) as unknown))
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
    expect<unknown>(harness.sentEvents).toContainEqual((expect.objectContaining({
      type: 'tool_result',
      toolUseId: 'late-write-1',
      result: 'Wrote result.ts',
      executed: true,
    }) as unknown))
    expect(harness.telemetryNames).toContain('tool.completed')
  })
});
