import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildAutonomyBrowserFallbackPrompt } from './autonomy-browser-fallback.ts'
import { createPendingTurnRecovery } from './turn-recovery.ts'
import {
  SessionManager,
  claimAutoRetryPending,
  commitRevocableSourceActivationRuntime,
  consumeSourceActivationRestart,
  createManagedSession,
  type AutoRetryPendingHost,
} from './SessionManager.ts'

// Regression test for craft-agents-oss#804.
//
// Before: the "[<slug> activated]" auto-retry only lived in the Electron renderer's
// event processor. Headless deployments (WebUI, docker server) stalled after a
// mid-turn source activation because nothing re-sent the original message.
//
// After: SessionManager.processEvent schedules a server-side resend on
// `source_activated`. To survive a mixed-version rollout where a v0.9.5 Electron
// client still ships the legacy renderer-side auto_retry, sendMessage rejects
// the text-only duplicate and accepts only the server timer's private capability.

type SourceActivatedEvent = {
  type: 'source_activated'
  sourceSlug: string
  originalMessage: string
}

function makePending(
  overrides: Partial<NonNullable<AutoRetryPendingHost['autoRetryPending']>> = {},
): NonNullable<AutoRetryPendingHost['autoRetryPending']> {
  return {
    content: 'do it\n\n[github activated]',
    rawMessage: 'do it',
    deadlineMs: 2_000,
    tombstoneExpiresAt: 30_000,
    objectiveId: 'objective-a',
    objectiveRevision: 'revision-a',
    sourceSlug: 'github',
    sourceActivationId: 'activation-a',
    generation: 0,
    cancellationEpoch: 0,
    messageCountAtSchedule: 0,
    dispatchToken: Symbol('source activation'),
    dispatchInFlight: false,
    dispatchAttempts: 0,
    committed: false,
    cancelled: false,
    ...overrides,
  }
}

describe('claimAutoRetryPending', () => {
  it('accepts only the server capability and drops text-only imitations and duplicates', () => {
    const dispatchToken = Symbol('server retry')
    const host = {
      autoRetryPending: makePending({ dispatchToken }),
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000)).toBe('drop')
    expect(host.autoRetryPending?.committed).toBe(false)
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000, Symbol('imitation'))).toBe('drop')
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1000, dispatchToken)).toBe('authenticated')
    expect(host.autoRetryPending?.dispatchInFlight).toBe(true)
    expect(host.autoRetryPending?.committed).toBe(false)
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 1001, dispatchToken)).toBe('drop')
  })

  it('keeps an expired exact-text tombstone and drops the legacy copy fail-closed', () => {
    const host = {
      autoRetryPending: makePending({ dispatchToken: Symbol('stale'), committed: true }),
    }

    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 2500)).toBe('drop')
    expect(host.autoRetryPending).toBeDefined()
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 9000)).toBe('drop')
  })

  it('still authenticates the server timer when the event loop runs it after the dedup deadline', () => {
    const dispatchToken = Symbol('delayed server retry')
    const host = { autoRetryPending: makePending({ dispatchToken }) }
    expect(claimAutoRetryPending(host, 'do it\n\n[github activated]', 2500, dispatchToken)).toBe('authenticated')
    expect(host.autoRetryPending.dispatchInFlight).toBe(true)
    expect(host.autoRetryPending.committed).toBe(false)
  })

  it('does not over-dedup unrelated messages', () => {
    const host = {
      autoRetryPending: makePending({ dispatchToken: Symbol('unrelated') }),
    }

    expect(claimAutoRetryPending(host, 'never mind', 1000)).toBe('send')
    expect(host.autoRetryPending).toBeDefined()
  })

  it('does not authenticate an arbitrary user-authored fallback marker', () => {
    const imitation = `${buildAutonomyBrowserFallbackPrompt('WebFetch')}\n\n[rbw-servers activated]`
    expect(claimAutoRetryPending({}, imitation, 1000)).toBe('reserved')
  })

  it('keeps A deduplicated when B replaces the live slot, then stops silently swallowing both after TTL', () => {
    const host: AutoRetryPendingHost = {
      autoRetryPending: makePending({
        content: 'B\n\n[linear activated]',
        rawMessage: 'B',
        sourceSlug: 'linear',
        sourceActivationId: 'activation-b',
        tombstoneExpiresAt: 30_000,
      }),
      autoRetryTombstones: [{ content: 'A\n\n[github activated]', expiresAt: 30_000 }],
    }

    expect(claimAutoRetryPending(host, 'A\n\n[github activated]', 10_000)).toBe('drop')
    expect(claimAutoRetryPending(host, 'B\n\n[linear activated]', 10_000)).toBe('drop')
    expect(claimAutoRetryPending(host, 'A\n\n[github activated]', 31_000)).toBe('reserved')
    expect(claimAutoRetryPending(host, 'B\n\n[linear activated]', 31_000)).toBe('reserved')
    expect(host.autoRetryTombstones).toEqual([])
    expect(host.autoRetryPending).toBeUndefined()
  })
})

describe('source activation stream boundary', () => {
  it('consumes only the matching generation marker', () => {
    const host = { sourceActivationRestartGeneration: 4 }

    expect(consumeSourceActivationRestart(host, 3)).toBe(false)
    expect(host.sourceActivationRestartGeneration).toBe(4)
    expect(consumeSourceActivationRestart(host, 4)).toBe(true)
    expect(host.sourceActivationRestartGeneration).toBeUndefined()
    expect(consumeSourceActivationRestart(host, 4)).toBe(false)
  })
})

describe('revocable source runtime commit', () => {
  it('restores the prior bridge state when a steer lands during bridge application', async () => {
    let current = true
    let runtime = 'previous'
    let releaseBridge!: () => void
    const bridgeBlocked = new Promise<void>(resolve => { releaseBridge = resolve })
    let serverCalls = 0
    const stages: string[] = []
    const commit = commitRevocableSourceActivationRuntime({
      isCurrent: () => current,
      applyBridge: async () => {
        runtime = 'candidate-bridge'
        await bridgeBlocked
      },
      applyServers: async () => {
        serverCalls += 1
        runtime = 'candidate-servers'
      },
      restorePrevious: async stage => {
        stages.push(stage)
        runtime = 'previous'
      },
      quarantine: async () => { runtime = 'quarantined' },
    })

    await Promise.resolve()
    expect(runtime).toBe('candidate-bridge')
    current = false
    releaseBridge()
    expect(await commit).toBe('superseded')
    expect(runtime).toBe('previous')
    expect(serverCalls).toBe(0)
    expect(stages).toEqual(['bridge-superseded'])
  })

  it('restores both source-server and bridge state when a steer lands during server application', async () => {
    let current = true
    let runtime = 'previous'
    let releaseServers!: () => void
    const serversBlocked = new Promise<void>(resolve => { releaseServers = resolve })
    const stages: string[] = []
    const commit = commitRevocableSourceActivationRuntime({
      isCurrent: () => current,
      applyBridge: async () => { runtime = 'candidate-bridge' },
      applyServers: async () => {
        runtime = 'candidate-servers'
        await serversBlocked
      },
      restorePrevious: async stage => {
        stages.push(stage)
        runtime = 'previous'
      },
      quarantine: async () => { runtime = 'quarantined' },
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(runtime).toBe('candidate-servers')
    current = false
    releaseServers()
    expect(await commit).toBe('superseded')
    expect(runtime).toBe('previous')
    expect(stages).toEqual(['servers-superseded'])
  })

  it('quarantines a candidate runtime when restoring its prior state fails', async () => {
    let current = true
    let runtime = 'previous'
    let quarantines = 0
    const commit = commitRevocableSourceActivationRuntime({
      isCurrent: () => current,
      applyBridge: async () => {
        runtime = 'candidate-bridge'
        current = false
      },
      applyServers: async () => { runtime = 'candidate-servers' },
      restorePrevious: async () => {
        throw new Error('rollback transport unavailable')
      },
      quarantine: async () => {
        quarantines += 1
        runtime = 'quarantined'
      },
    })

    expect(await commit).toBe('quarantined')
    expect(runtime).toBe('quarantined')
    expect(quarantines).toBe(1)
  })
})

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
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
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
    const managed = (sm as unknown as { sessions: Map<string, { messages: unknown[] }> }).sessions.get(sessionId)!
    ;(sm as unknown as { sendMessage: (id: string, msg: string, ...args: unknown[]) => Promise<void> }).sendMessage = async (id, msg, ...args) => {
      const m = (sm as unknown as { sessions: Map<string, AutoRetryPendingHost & {
        messages: unknown[]
      }> }).sessions.get(id)!
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
    const managed = (sm as unknown as { sessions: Map<string, ReturnType<typeof buildSession>> }).sessions.get(sessionId)!
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
    expect(captured!.effectiveMessage).toContain(`objective_user_message_id="${humanMessageId}"`)
    expect(captured!.effectiveMessage).toContain('contrat 3602')
    expect(captured!.effectiveMessage).not.toContain(`objective_user_message_id="${captured!.durableMessage!.id}"`)
  })

  it('restores a queued source-activation continuation with durable provenance and the original objective budget', () => {
    const managed = buildSession('cold-source-activation')
    const humanMessageId = 'msg-1789638600000-coldhuman'
    const objective: NonNullable<typeof managed.activeObjective> = {
      schemaVersion: 1 as const,
      originalText: 'Corrige et vérifie le contrat 3602 via le serveur.',
      objectiveId: humanMessageId,
      userMessageId: humanMessageId,
      lastUserMessageId: humanMessageId,
      startedAt: 1789638600000,
      budgetBaselineUsd: 31.67,
      tokenBaseline: 1_183_646,
      continuationCount: 9,
      orchestrationMode: 'direct' as const,
      risk: 'standard' as const,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      terminalState: 'active' as const,
      acceptanceCriteria: [{
        id: 'contract-3602', description: 'Contrat corrigé', toolName: 'mcp__rbw-servers__ssh_execute',
        input: { server: 'pns' }, checks: [{ path: '$.contractId', equals: 3602 }],
      }],
    }
    const recovery = {
      ...createPendingTurnRecovery(humanMessageId, 1789638600000),
      attempts: 8,
      continuationRequired: true,
      continuationOrigin: 'objective_continue' as const,
      continuationWork: ['Corriger le traitement 3602'],
    }
    managed.messages.push(
      { id: humanMessageId, role: 'user', content: objective.originalText!, timestamp: objective.startedAt },
      {
        id: 'msg-source-retry', role: 'user', timestamp: objective.startedAt + 1,
        content: `${buildAutonomyBrowserFallbackPrompt('WebFetch')}\n\n[rbw-servers activated]`,
        hidden: true, isQueued: true, internalOrigin: {
          kind: 'source-activation', objectiveId: humanMessageId, objectiveRevision: humanMessageId,
          sourceSlug: 'rbw-servers', sourceActivationId: 'cold-source-activation-id',
        },
      },
    )
    managed.activeObjective = objective
    managed.pendingTurnRecovery = recovery
    ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}

    ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
      .restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toEqual(objective)
    expect(managed.pendingTurnRecovery).toEqual(recovery)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      messageId: 'msg-source-retry',
      options: { hidden: true, internalOrigin: {
        kind: 'source-activation', objectiveId: humanMessageId, objectiveRevision: humanMessageId,
        sourceSlug: 'rbw-servers', sourceActivationId: 'cold-source-activation-id',
      } },
    })
    expect(managed.messageQueue[0]!.options?.automaticRecovery).toBeUndefined()
  })

  it('drops cold source-activation rows whose durable root or revision binding is absent or stale', () => {
    for (const variant of ['missing', 'root', 'revision'] as const) {
      const managed = buildSession(`cold-source-mismatch-${variant}`)
      const binding = {
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      }
      const internalOrigin = variant === 'missing'
        ? { kind: 'source-activation' as const }
        : {
            kind: 'source-activation' as const,
            objectiveId: variant === 'root' ? 'another-objective' : binding.objectiveId,
            objectiveRevision: variant === 'revision' ? 'another-revision' : binding.objectiveRevision,
          }
      managed.messages.push({
        id: `stale-source-${variant}`,
        role: 'user',
        timestamp: 101,
        content: `inspect\n\n[github activated]`,
        hidden: true,
        isQueued: true,
        internalOrigin,
      })
      ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}

      ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
        .restoreDurableRuntimeState(managed)

      expect(managed.messageQueue).toEqual([])
      expect(managed.messages.some(message => message.id === `stale-source-${variant}`)).toBe(false)
    }
  })

  it('queues and flushes the durable cleanup of a stale restored source row', async () => {
    const managed = buildSession('cold-source-cleanup-flush')
    managed.messages.push({
      id: 'stale-source-row',
      role: 'user',
      timestamp: Date.now(),
      content: 'inspect\n\n[github activated]',
      hidden: true,
      isQueued: true,
      internalOrigin: {
        kind: 'source-activation',
        objectiveId: 'obsolete-root',
        objectiveRevision: 'obsolete-revision',
        sourceSlug: 'github',
        sourceActivationId: 'obsolete-activation',
      },
    })
    let enqueued = 0
    let flushed = 0
    ;(sm as unknown as { enqueuePersist: () => boolean; flushSession: () => Promise<void> }).enqueuePersist = () => { enqueued++; return true }
    ;(sm as unknown as { flushSession: () => Promise<void> }).flushSession = async () => { flushed++ }

    ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
      .restoreDurableRuntimeState(managed)
    await new Promise(resolve => setImmediate(resolve))

    expect(managed.messages.some(message => message.id === 'stale-source-row')).toBe(false)
    expect(enqueued).toBe(1)
    expect(flushed).toBe(1)
  })

  it('lets a later durable human instruction supersede a matching source continuation during cold restore', () => {
    const managed = buildSession('cold-human-supersession')
    const origin = {
      kind: 'source-activation' as const,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      sourceSlug: 'github',
      sourceActivationId: 'cold-human-supersession-id',
    }
    managed.messages.push(
      {
        id: 'cold-deferred-source', role: 'user', timestamp: 101,
        content: 'inspect\n\n[github activated]', hidden: true, isQueued: true,
        internalOrigin: origin,
      },
      {
        id: 'cold-new-human', role: 'user', timestamp: 102,
        content: 'Nouvelle instruction humaine durable', isQueued: true,
      },
    )
    ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}

    ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
      .restoreDurableRuntimeState(managed)

    expect(managed.messages.some(message => message.id === 'cold-deferred-source')).toBe(false)
    expect(managed.messages.some(message => message.id === 'cold-new-human')).toBe(true)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      messageId: 'cold-new-human',
      message: 'Nouvelle instruction humaine durable',
    })
    expect(managed.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
  })

  it('revalidates the objective binding at dequeue and removes a stale queued row', async () => {
    const sessionId = 'dequeue-source-mismatch'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    const origin = {
      kind: 'source-activation' as const,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      sourceSlug: 'github',
      sourceActivationId: 'dequeue-source-activation-id',
    }
    const content = 'inspect\n\n[github activated]'
    managed.messages.push({
      id: 'deferred-source-row', role: 'user', content, timestamp: 101,
      hidden: true, isQueued: true, internalOrigin: origin,
    })
    managed.messageQueue.push({
      messageId: 'deferred-source-row', message: content,
      options: { hidden: true, internalOrigin: origin },
    })
    managed.activeObjective = {
      ...managed.activeObjective!,
      lastUserMessageId: 'newer-human-revision',
    }
    delete (sm as unknown as { processNextQueuedMessage?: unknown }).processNextQueuedMessage

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void }).processNextQueuedMessage(sessionId)
    await new Promise(r => setTimeout(r, 20))

    expect(chats).toBe(0)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.some(message => message.id === 'deferred-source-row')).toBe(false)
  })

  it('a new human instruction removes an already durable deferred source row before it can run', async () => {
    const sessionId = 'human-supersedes-deferred-source'
    const managed = buildSession(sessionId)
    stubRuntimeForRealSend(managed, () => {})
    managed.isProcessing = true

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await new Promise(r => setTimeout(r, 150))
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.options?.internalOrigin?.kind).toBe('source-activation')
    expect(managed.messages.some(message => message.isQueued
      && message.internalOrigin?.kind === 'source-activation')).toBe(true)

    await sm.sendMessage(sessionId, 'Nouvelle instruction humaine : traite plutôt les issues.')
    await new Promise(r => setTimeout(r, 20))

    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
    expect(managed.autoRetryTimer).toBeUndefined()
    expect(managed.messages.some(message => message.internalOrigin?.kind === 'source-activation')).toBe(false)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      message: 'Nouvelle instruction humaine : traite plutôt les issues.',
    })
    expect(managed.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
    await sm.sendMessage(sessionId, 'inspect the repository\n\n[github activated]')
    expect(managed.messageQueue).toHaveLength(1)
  })

  it('a human instruction accepted during source preparation prevents provider start', async () => {
    const sessionId = 'human-during-source-preparation'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    let releasePreparation!: () => void
    let preparationEntered!: () => void
    const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve })
    const entered = new Promise<void>(resolve => { preparationEntered = resolve })
    const agent = managed.agent!
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown>; processNextQueuedMessage: () => void }).getOrCreateAgent = async () => {
      preparationEntered()
      await preparationGate
      return agent
    }

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('source preparation did not start')), 1_000)),
    ])
    await sm.sendMessage(sessionId, 'Traite plutôt les issues ouvertes.')
    releasePreparation()
    await new Promise(r => setTimeout(r, 50))

    expect(chats).toBe(0)
    expect(managed.messages.some(message => message.internalOrigin?.kind === 'source-activation')).toBe(false)
    expect(managed.messages.some(message => message.role === 'user'
      && !message.hidden && message.content === 'Traite plutôt les issues ouvertes.')).toBe(true)
    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
  })

  it('a human instruction accepted during the source durability flush wins before provider start', async () => {
    const sessionId = 'human-during-source-flush'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    let releaseFirstFlush!: () => void
    let firstFlushEntered!: () => void
    const firstFlushGate = new Promise<void>(resolve => { releaseFirstFlush = resolve })
    const entered = new Promise<void>(resolve => { firstFlushEntered = resolve })
    let firstFlush = true
    ;(sm as unknown as { flushSession: () => Promise<void> }).flushSession = async () => {
      if (!firstFlush) return
      firstFlush = false
      firstFlushEntered()
      await firstFlushGate
    }

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('source flush did not start')), 1_000)),
    ])
    await sm.sendMessage(sessionId, 'Traite plutôt les pull requests.')
    releaseFirstFlush()
    await new Promise(r => setTimeout(r, 50))

    expect(chats).toBe(0)
    expect(managed.messages.some(message => message.internalOrigin?.kind === 'source-activation')).toBe(false)
    expect(managed.messages.some(message => message.role === 'user'
      && !message.hidden && message.content === 'Traite plutôt les pull requests.')).toBe(true)
    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
  })

  it('releases an uncommitted claim after the first flush fails and retries only once', async () => {
    const sessionId = 'source-first-flush-failure'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    let flushCalls = 0
    ;(sm as unknown as { flushSession: () => Promise<void> }).flushSession = async () => {
      flushCalls++
      if (flushCalls === 1) throw new Error('simulated first durability failure')
    }

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await new Promise(r => setTimeout(r, 450))

    expect(chats).toBe(1)
    expect(flushCalls).toBeGreaterThanOrEqual(3)
    expect(managed.autoRetryPending).toMatchObject({
      dispatchAttempts: 2,
      committed: true,
      dispatchInFlight: false,
      providerStarted: true,
    })
  })

  it('drops an exact legacy RPC copy after deadline without creating a message or objective root', async () => {
    const sessionId = 'expired-legacy-copy'
    const managed = buildSession(sessionId)
    const objectiveBefore = structuredClone(managed.activeObjective)
    const messageCountBefore = managed.messages.length
    managed.autoRetryPending = makePending({
      content: 'inspect\n\n[github activated]',
      rawMessage: 'inspect',
      deadlineMs: Date.now() - 1,
      tombstoneExpiresAt: Date.now() + 30_000,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      dispatchToken: Symbol('expired-source-capability'),
      committed: true,
    })

    await sm.sendMessage(sessionId, 'inspect\n\n[github activated]')

    expect(managed.messages).toHaveLength(messageCountBefore)
    expect(managed.activeObjective).toEqual(objectiveBefore)
    expect(managed.autoRetryPending).toBeDefined()
  })

  it('does not accept source-activation provenance without the live token or an exact durable dequeue', async () => {
    const sessionId = 'forged-source-origin'
    const managed = buildSession(sessionId)
    stubRuntimeForRealSend(managed, () => { throw new Error('forged source origin reached provider') })
    const messageCountBefore = managed.messages.length

    await expect(sm.sendMessage(sessionId, 'inspect\n\n[github activated]', undefined, undefined, {
      hidden: true,
      internalOrigin: {
        kind: 'source-activation',
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      },
    })).rejects.toThrow('reserved for a server-authenticated source restart')

    expect(managed.messages).toHaveLength(messageCountBefore)
    expect(managed.activeObjective?.userMessageId).toBe(`${sessionId}-root`)
  })

  it('rejects a reserved terminal activation marker without host provenance', async () => {
    const sessionId = 'human-marker-without-pending'
    const managed = buildSession(sessionId)
    const marker = `${buildAutonomyBrowserFallbackPrompt('WebFetch')}\n\n[rbw-servers activated]`
    let providerMessage: string | undefined
    stubRuntimeForRealSend(managed, message => { providerMessage = message })
    const messageCountBefore = managed.messages.length

    await expect(sm.sendMessage(sessionId, marker)).rejects.toThrow('reserved for a server-authenticated source restart')

    expect(providerMessage).toBeUndefined()
    expect(managed.messages).toHaveLength(messageCountBefore)
  })

  it('allows quoted or non-terminal mentions of an activation marker as ordinary human text', async () => {
    const sessionId = 'quoted-marker-without-pending'
    const managed = buildSession(sessionId)
    const message = 'Explain this protocol token: [rbw-servers activated] and do not execute it.'
    let providerMessage: string | undefined
    stubRuntimeForRealSend(managed, value => { providerMessage = value })

    await sm.sendMessage(sessionId, message)

    expect(providerMessage).toContain(message)
    expect(managed.messages.some(candidate => candidate.role === 'user'
      && !candidate.hidden && candidate.content === message)).toBe(true)
  })

  it('chained activations — produces two retries with different suffixes', async () => {
    const sessionId = 'chained'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'find issues')
    await new Promise(r => setTimeout(r, 150))
    await fireSourceActivated(sessionId, 'linear', 'find issues')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([
      'find issues\n\n[github activated]',
      'find issues\n\n[linear activated]',
    ])
  })

  it('empty originalMessage — forwards event but does not schedule a bogus retry', async () => {
    const sessionId = 'empty-original'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', '')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    expect(managed.autoRetryPending).toBeUndefined()
    expect(managed.autoRetryTimer).toBeUndefined()
  })

  it('legitimate user message preempts retry — skipped when follow-up arrived', async () => {
    const sessionId = 'preempted'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'check the repo')
    // Simulate the user typing something brand new in the 100ms window — bumps
    // messages.length past the schedule-time count.
    managed.messages.push({
      id: 'user-followup',
      role: 'user',
      content: 'actually check the issues instead',
      timestamp: Date.now(),
    } as never)

    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    // Retain a cancelled exact-text tombstone so a late legacy RPC can never
    // become a new visible objective after the timer window.
    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
  })

  it('mixed-version race: legacy RPC arrives BEFORE timer fires — exactly one message committed', async () => {
    const sessionId = 'race-rpc-first'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Legacy renderer's RPC arrives ~5ms after schedule, BEFORE the 100ms timer.
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'do the thing\n\n[github activated]',
    )
    // Wait past the timer.
    await new Promise(r => setTimeout(r, 200))

    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('do the thing\n\n[github activated]')
  })

  it('mixed-version race: timer fires BEFORE legacy RPC arrives — exactly one message committed', async () => {
    const sessionId = 'race-timer-first'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Wait for the timer to fire and commit.
    await new Promise(r => setTimeout(r, 150))
    // Now the late legacy RPC arrives (≤2s window).
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'do the thing\n\n[github activated]',
    )

    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('do the thing\n\n[github activated]')
  })

  it('user message with different content still goes through — pending slot does not over-dedup', async () => {
    const sessionId = 'unrelated-message'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'list repos')
    // User types something completely different in the dedup window — pending
    // content does not match, so the dedup gate falls through and the message
    // goes through normally. (It also bumps messages.length, which causes the
    // timer to skip the auto-retry as preempted — covered by the 'preempted'
    // test. The unique guarantee here is: the unrelated message itself is
    // never silently dropped by the dedup gate.)
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'never mind, what time is it',
    )
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['never mind, what time is it'])
  })

  it('timer cancelled on session delete — no auto-retry fires after deletion', async () => {
    const sessionId = 'deleted-mid-window'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Confirm the timer is armed before we delete.
    expect(managed.autoRetryTimer).toBeDefined()

    // Synchronously rip the session out of the map (mimic the deletion path's
    // cleanup without going through the full deleteSession flow, which would
    // also try to dispose agents and tear down pool servers we never created).
    if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
    managed.autoRetryTimer = undefined
    managed.autoRetryPending = undefined
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.delete(sessionId)

    await new Promise(r => setTimeout(r, 200))

    expect(calls).toEqual([])
  })
})
