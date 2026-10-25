import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAutonomyBrowserFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { SessionManager, claimAutoRetryPending, createManagedSession } from "./SessionManager.ts";
import { type SourceActivatedEvent } from "./testing/source-activated-auto-retry-fixture.ts";

describe('source_activated auto-retry', () => {
  let tmpRoot: string

  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-autoretry-'))
    sm = new SessionManager()
    const internals = sm as unknown as { enqueuePersist: () => boolean; flushSession: () => Promise<void> }
    internals.enqueuePersist = () => true
    internals.flushSession = async () => {}
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'auto-retry test' },
      workspace as never,
      { messagesLoaded: true },
    )
    const rootId = `${id}-root`
    managed.messages.push({
      id: rootId,
      role: 'user',
      content: `Initial objective for ${id}`,
      timestamp: 100,
    })
    managed.activeObjective = {
      schemaVersion: 1,
      originalText: `Initial objective for ${id}`,
      objectiveId: rootId,
      userMessageId: rootId,
      lastUserMessageId: rootId,
      startedAt: 100,
      budgetBaselineUsd: 0,
      tokenBaseline: 0,
      continuationCount: 0,
      orchestrationMode: 'direct',
      risk: 'standard',
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      terminalState: 'active',
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery(rootId, 100)
    ;sessionRuntimeStateForTest(sm).sessions.set(id, managed)
    return managed
  }

  function stubRuntimeForRealSend(
    managed: ReturnType<typeof buildSession>,
    onChat: (message: string) => void,
  ) {
    const internals = sm as unknown as {
      enqueuePersist: () => boolean
      flushSession: () => Promise<void>
      sendEvent: () => void
      emitExecutionTelemetry: () => void
      startGenerationTelemetry: () => void
      finishGenerationTelemetry: () => void
      beginAutomaticSessionStatusLifecycle: () => Promise<void>
      finishAutomaticSessionStatusLifecycle: () => Promise<void>
      isSessionBeingViewed: () => boolean
      markSessionRead: () => Promise<void>
      processNextQueuedMessage: () => void
      getOrCreateAgent: () => Promise<unknown>
    }
    internals.enqueuePersist = () => true
    internals.flushSession = async () => {}
    internals.sendEvent = () => {}
    internals.emitExecutionTelemetry = () => {}
    internals.startGenerationTelemetry = () => {}
    internals.finishGenerationTelemetry = () => {}
    internals.beginAutomaticSessionStatusLifecycle = async () => {}
    internals.finishAutomaticSessionStatusLifecycle = async () => {}
    internals.isSessionBeingViewed = () => true
    internals.markSessionRead = async () => {}
    internals.processNextQueuedMessage = () => {}
    const agent: {
      onProviderHandoff?: () => void
      chat(message: string): AsyncGenerator<{ type: 'complete' }>
      getModel(): string
      getSessionId(): null
      isProcessing(): boolean
      setAllSources(): void
      redirect(): boolean
    } = {
      onProviderHandoff: undefined,
      async *chat(message: string) {
        onChat(message)
        agent.onProviderHandoff?.()
        // End this isolated replay without asking the completion gate to spend
        // another recovery attempt after the state snapshot has been captured.
        managed.stopRequested = true
        if (false) yield { type: 'complete' as const }
      },
      getModel: () => 'test/source-activation',
      getSessionId: () => null,
      isProcessing: () => false,
      setAllSources: () => {},
      redirect: () => false,
    }
    managed.agent = agent as never
    internals.getOrCreateAgent = async () => agent
  }

  /**
   * Replace `sendMessage` with a spy that records the call and appends a
   * placeholder user message to `managed.messages`. Appending makes the
   * content-match dedup observable through the real code path — without it,
   * subsequent "duplicate" calls wouldn't even reach the dedup check (no
   * pending state would have been mutated by the first call).
   */
  function spyOnSendMessage(sessionId: string) {
    const calls: string[] = []
    const managed = sessionRuntimeStateForTest(sm).sessions.get(sessionId)!
    ;(sm as unknown as { sendMessage: (id: string, msg: string, ...args: unknown[]) => Promise<void> }).sendMessage = async (id, msg, ...args) => {
      const m = sessionRuntimeStateForTest(sm).sessions.get(id)!
      const dispatchToken = args[11] as symbol | undefined
      const claim = claimAutoRetryPending(m, msg, Date.now(), dispatchToken)
      if (claim === 'drop' || claim === 'reserved') return
      calls.push(msg)
      managed.messages.push({ id: `m-${calls.length}`, role: 'user', content: msg, timestamp: Date.now() })
    }
    return calls
  }

  async function fireSourceActivated(
    sessionId: string,
    sourceSlug: string,
    originalMessage: string,
    cleanRawMessage = originalMessage,
  ) {
    const managed = sessionRuntimeStateForTest(sm).sessions.get(sessionId)!
    const binding = managed.activeObjective!
    managed.sourceActivationTurn = {
      generation: managed.processingGeneration,
      cancellationEpoch: 0,
      rawMessage: cleanRawMessage,
      objectiveId: binding.objectiveId ?? binding.userMessageId,
      objectiveRevision: binding.lastUserMessageId ?? binding.userMessageId,
    }
    const event: SourceActivatedEvent = { type: 'source_activated', sourceSlug, originalMessage }
    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
  }

  it('basic re-send — fires sendMessage with "[<slug> activated]" suffix', async () => {
    const sessionId = 'basic-resend'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'list my repos')
    expect(managed.sourceActivationRestartGeneration).toBe(managed.processingGeneration)
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['list my repos\n\n[github activated]'])
  })

  it('uses the clean provider input instead of replaying enriched event text', async () => {
    const sessionId = 'clean-provider-input'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)
    const emitted: unknown[] = []
    ;(sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => { emitted.push(event) }

    await fireSourceActivated(
      sessionId,
      'github',
      'list my repos\n\n<objective_contract>large host prompt</objective_contract>',
      'list my repos',
    )
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['list my repos\n\n[github activated]'])
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'source_activated',
      originalMessage: 'list my repos',
    }))
  })

  it('Stop cancels the timer and rejects a late source event from the stopped generation', async () => {
    const sessionId = 'stop-before-source-retry'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)
    const emitted: unknown[] = []
    ;(sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => { emitted.push(event) }

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    expect(managed.autoRetryTimer).toBeDefined()
    await sm.cancelProcessing(sessionId)
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    expect(managed.autoRetryTimer).toBeUndefined()
    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
    const eventCountAfterStop = emitted.length
    await (sm as unknown as { processEvent: (m: unknown, e: unknown, generation: number) => Promise<void> })
      .processEvent(managed, {
        type: 'source_activated', sourceSlug: 'linear', originalMessage: 'late provider text',
      }, managed.processingGeneration - 1)
    expect(emitted).toHaveLength(eventCountAfterStop)
    expect(managed.autoRetryTimer).toBeUndefined()
  })

  it('does not emit renderer retry authority for a terminal objective', async () => {
    const sessionId = 'terminal-source-event'
    const managed = buildSession(sessionId)
    managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified' }
    const objective = managed.activeObjective
    managed.sourceActivationTurn = {
      generation: managed.processingGeneration,
      cancellationEpoch: 0,
      rawMessage: 'inspect',
      objectiveId: objective.objectiveId!,
      objectiveRevision: objective.lastUserMessageId!,
    }
    const emitted: unknown[] = []
    ;(sm as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => { emitted.push(event) }

    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> })
      .processEvent(managed, { type: 'source_activated', sourceSlug: 'github', originalMessage: 'inspect' })

    expect(emitted).toEqual([])
    expect(managed.autoRetryPending).toBeUndefined()
    expect(managed.autoRetryTimer).toBeUndefined()
  })

  it('drops the scheduled retry when objective root or direct-user revision changes before the timer', async () => {
    for (const changed of ['root', 'revision'] as const) {
      const sessionId = `objective-changed-${changed}`
      const managed = buildSession(sessionId)
      const calls = spyOnSendMessage(sessionId)

      await fireSourceActivated(sessionId, 'github', 'inspect the repository')
      if (changed === 'root') {
        managed.activeObjective = {
          ...managed.activeObjective!,
          objectiveId: `${sessionId}-replacement-root`,
          userMessageId: `${sessionId}-replacement-root`,
          lastUserMessageId: `${sessionId}-replacement-root`,
        }
      } else {
        managed.activeObjective = {
          ...managed.activeObjective!,
          lastUserMessageId: `${sessionId}-new-revision`,
        }
      }

      await new Promise(r => setTimeout(r, 150))
      expect(calls).toEqual([])
      expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
      expect(claimAutoRetryPending(
        managed,
        'inspect the repository\n\n[github activated]',
        Date.now() + 60_000,
      )).toBe('reserved')
    }
  })

  it('replays the live PNS fallback as a hidden continuation without replacing objective identity, criteria or budget', async () => {
    const sessionId = 'pns-fallback-objective'
    const managed = buildSession(sessionId)
    const humanMessageId = 'msg-1789638600000-human3602'
    const humanObjective = 'Concentre-toi sur l’API serveur du contrat 3602 et la corrélation 85236791…feb0, corrige puis vérifie sans nouvel envoi.'
    managed.messages.push({
      id: humanMessageId,
      role: 'user',
      content: humanObjective,
      timestamp: 1789638600000,
    })
    managed.activeObjective = {
      schemaVersion: 1,
      originalText: humanObjective,
      requiresAcceptanceCriteria: true,
      requiresObservationEvidence: true,
      objectiveId: humanMessageId,
      userMessageId: humanMessageId,
      lastUserMessageId: humanMessageId,
      startedAt: 1789638600000,
      budgetBaselineUsd: 31.67,
      tokenBaseline: 1_183_646,
      continuationCount: 9,
      orchestrationMode: 'direct',
      risk: 'standard',
      completionCriteria: [
        'requested-outcome-delivered',
        'relevant-checks-passed',
        'no-safe-work-remaining',
      ],
      terminalState: 'active',
      acceptanceCriteria: [{
        id: 'pns-3602-reconciled',
        description: 'Le traitement 3602 est corrigé et réconcilié sans invitation dupliquée.',
        toolName: 'mcp__rbw-servers__ssh_execute',
        input: { server: 'pns', correlationId: '85236791…feb0' },
        checks: [
          { path: '$.contractId', equals: 3602 },
          { path: '$.duplicateInvitation', equals: false },
        ],
      }],
      acceptanceRegisteredRevision: humanMessageId,
      acceptanceRegisteredAt: 1789638600100,
      acceptanceRegisteredAtById: { 'pns-3602-reconciled': 1789638600100 },
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(humanMessageId, 1789638600000),
      attempts: 8,
      stagnantAttempts: 1,
      lastCause: 'objective_continue',
      continuationOrigin: 'objective_continue',
      continuationRequired: true,
      continuationWork: [
        'Lire l’échec 85236791…feb0',
        'Corriger le mapping e-doc',
        'Vérifier PDF, bucket, Cerfrance et POMO',
      ],
      validationGaps: ['La correction et la réconciliation du contrat 3602 ne sont pas vérifiées.'],
      lastProgressFingerprint: 'pns-before-source-activation',
    }
    const objectiveBefore = structuredClone(managed.activeObjective)
    const recoveryBefore = structuredClone(managed.pendingTurnRecovery)
    const fallback = buildAutonomyBrowserFallbackPrompt('WebFetch')
    const retriedMessage = `${fallback}\n\n[rbw-servers activated]`

    let captured: {
      effectiveMessage: string
      objective: typeof managed.activeObjective
      recovery: typeof managed.pendingTurnRecovery
      durableMessage: (typeof managed.messages)[number] | undefined
    } | undefined
    let resolveCapture!: () => void
    const capturedPromise = new Promise<void>(resolve => { resolveCapture = resolve })
    stubRuntimeForRealSend(managed, effectiveMessage => {
      captured = {
        effectiveMessage,
        objective: structuredClone(managed.activeObjective!),
        recovery: structuredClone(managed.pendingTurnRecovery!),
        durableMessage: structuredClone(managed.messages.at(-1)),
      }
      resolveCapture()
    })

    await fireSourceActivated(sessionId, 'rbw-servers', fallback)
    await Promise.race([
      capturedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('source retry did not start')), 1000)),
    ])

    expect(captured).toBeDefined()
    expect(captured!.objective).toEqual(objectiveBefore)
    expect(captured!.recovery).toEqual(recoveryBefore)
    expect(captured!.durableMessage).toMatchObject({
      role: 'user',
      content: retriedMessage,
      hidden: true,
      internalOrigin: {
        kind: 'source-activation',
        objectiveId: humanMessageId,
        objectiveRevision: humanMessageId,
      },
      isQueued: false,
    })
    expect(captured!.durableMessage!.id).not.toBe(humanMessageId)
    expect(captured!.effectiveMessage).toContain(retriedMessage)
    expect(captured!.effectiveMessage).not.toContain('host_objective_contract')
  })
});
