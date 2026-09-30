import { describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'
import { createPendingTurnRecovery } from './turn-recovery'
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from '@craft-agent/core'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

type Boundary = 'provider-fallback' | 'runtime-disposal' | 'browser-visuals' | 'delivery-flush'
  | 'read-marker' | 'mini-status' | 'terminal-status' | 'browser-release'

/** Exercise the real stop lifecycle, pausing only external cleanup/storage boundaries. */
function harness(boundary?: Boundary, rejectBoundary = false) {
  const reached = deferred(), release = deferred()
  const events: Array<{ type: string; reason?: string; changes?: { isProcessing?: boolean } }> = []
  const effects: string[] = []
  const terminalReasons: string[] = []
  const managed = createManagedSession({ id: 'stop-ownership' }, {
    id: 'workspace', rootPath: '/tmp/processing-stop-fixture', name: 'Fixture', createdAt: 1,
  } as never, { messagesLoaded: true })
  managed.isProcessing = true
  managed.processingGeneration = 1
  managed.messages = [{ id: 'human', role: 'user', content: 'Fixture request', timestamp: 1 }]
  const checkpoint = async (name: Boundary) => {
    effects.push(name)
    if (name === boundary) {
      reached.resolve()
      await release.promise
      if (rejectBoundary) throw new Error('Fixture cleanup failed')
    }
  }
  let browserCalls = 0
  const prototype = SessionManager.prototype as any
  const runtime: any = {
    hasConsumedCleanRecoveryDispatch: () => false,
    retryableContextLimitRequest: () => undefined,
    isManagedSessionYolo: () => false,
    shuttingDown: false, sessions: new Map([[managed.id, managed]]), retentionDeleting: new Set<string>(),
    retiringSessions: new WeakSet<object>(),
    sessionOperationsInFlight: new WeakMap<object, Set<Promise<unknown>>>(),
    deferredAutomaticSessions: new Set<string>(), automaticAdmissionReservations: new Set<string>(),
    queuedMessageDispatches: new Map<string, symbol>(),
    permissionExpiryStopGenerations: new WeakMap<object, number>(),
    finishGenerationTelemetry: () => effects.push('telemetry'),
    recordObjectiveRoutingEvaluation: () => undefined,
    hasAcceptedHumanContinuationQueued: () => false,
    hasTerminalObjectiveState: prototype.hasTerminalObjectiveState,
    hasPendingUserInput: () => false, hasQueuedUserInput: () => false, hasPendingDecision: () => false,
    hasExhaustedValidation: () => false, hasValidationExhaustionMarker: () => false,
    isCleanSetupRetryBlocked: prototype.isCleanSetupRetryBlocked,
    isCleanSetupPersistenceFenced: prototype.isCleanSetupPersistenceFenced,
    providerDispatchAcceptanceUnknown: prototype.providerDispatchAcceptanceUnknown,
    hasAnyRetainedStoppedAgentDelivery: prototype.hasAnyRetainedStoppedAgentDelivery,
    boundCleanUserInputRequest: prototype.boundCleanUserInputRequest,
    preserveInterruptedObjectiveContinuation: () => false,
    hasPreservedInterruptedObjectiveContinuation: () => false,
    hasBoundInterruptedTurnRecovery: prototype.hasBoundInterruptedTurnRecovery,
    pendingRecoveryBelongsToCurrentObjective: prototype.pendingRecoveryBelongsToCurrentObjective,
    clearPendingTurnRecovery: () => effects.push('clear-recovery'),
    cancelSupersededAutomaticRecoveries: prototype.cancelSupersededAutomaticRecoveries,
    ownsSessionOperation: prototype.ownsSessionOperation,
    assertSessionOperationOwner: prototype.assertSessionOperationOwner,
    trackSessionOperation: prototype.trackSessionOperation,
    setProcessing: prototype.setProcessing,
    markOrphanedBackgroundTasks: () => effects.push('orphan-backstop'),
    hasRunningBackgroundTasks: () => false,
    disposeManagedAgentRuntime: () => checkpoint('runtime-disposal'),
    getBrowserPaneManagerForSession: () => ({
      clearVisualsForSession: () => checkpoint(browserCalls++ === 0 ? 'browser-visuals' : 'browser-release'),
      unbindAllForSession: () => effects.push('unbind'),
    }),
    isSessionBeingViewed: () => true,
    getLastFinalAssistantMessageId: () => boundary === 'read-marker' ? 'final' : undefined,
    markSessionRead: () => checkpoint('read-marker'),
    flushSession: () => checkpoint('delivery-flush'),
    setSessionStatus: () => checkpoint('mini-status'),
    finishAutomaticSessionStatusLifecycle: (_session: unknown, reason: string) => {
      terminalReasons.push(reason)
      return checkpoint('terminal-status')
    },
    tryApplyRoutingFallbackAfterAgentFailure: async () => { await checkpoint('provider-fallback'); return true },
    monotonic: () => 10,
    emitObjectiveChanged: () => effects.push('objective'),
    sendEvent: (event: any) => events.push(event),
    executionProofCollector: { take: () => { effects.push('take-proof'); return undefined } },
    emitSessionComplete: () => effects.push('conductor'),
    persistSession: () => effects.push('persist'),
    processNextQueuedMessage: () => effects.push('dispatch-queue'),
    isAutonomousMessage: prototype.isAutonomousMessage,
    hasOnlyMachineInbox: prototype.hasOnlyMachineInbox,
  }
  if (boundary === 'delivery-flush') {
    managed.lastSentOptions = { internalOrigin: { kind: 'agent-message', deliveryId: 'delivery' } }
    managed.messages.push({ id: 'delivery', role: 'user', content: 'Internal report', timestamp: 2,
      agentDelivery: { id: 'delivery', status: 'processing', attempts: 1 } })
  }
  if (boundary === 'mini-status') managed.systemPromptPreset = 'mini'
  if (boundary === 'provider-fallback') {
    managed.pendingRuntimeProviderFallback = { generation: 1, error: new Error('Fixture provider stopped') } as never
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery('human'),
      attempts: 1,
      lastCause: 'tool_checkpoint',
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'checkpoint-dispatch',
        attempt: 1,
        cause: 'tool_checkpoint',
        origin: 'automatic',
        allocatedAt: 1,
        phase: 'allocated',
      },
    }
    managed.messageQueue.push({ message: 'Recovery', options: { automaticRecovery: {
      originalUserMessageId: 'human', cause: 'tool_checkpoint', dispatchId: 'checkpoint-dispatch',
      dispatchAttempt: 1, dispatchOrigin: 'automatic', dispatchAllocatedAt: 1,
    } } })
  }
  const stop = (generation = 1, reason?: 'complete' | 'interrupted' | 'error' | 'timeout') => (
    prototype.onProcessingStopped.call(runtime, managed.id,
      reason ?? (boundary === 'runtime-disposal' ? 'error' : 'complete'), generation) as Promise<void>
  )
  const startNext = () => {
    managed.processingGeneration = 2
    managed.turnStartFinalMessageId = 'new-turn-baseline'
    runtime.setProcessing(managed, true)
  }
  return { managed, runtime, events, effects, terminalReasons, reached, release, stop, startNext }
}

describe('processing stop ownership', () => {
  it.each<Boundary>(['runtime-disposal', 'browser-visuals', 'delivery-flush',
    'read-marker', 'mini-status', 'terminal-status', 'browser-release'])(
    'does not finish the next generation after waiting for %s', async boundary => {
      const h = harness(boundary)
      const stopping = h.stop()
      await h.reached.promise
      h.startNext()
      const effectsBeforeRelease = [...h.effects]
      h.release.resolve()
      await stopping
      expect(h.managed.isProcessing).toBe(true)
      expect(h.managed.processingGeneration).toBe(2)
      expect(h.managed.turnStartFinalMessageId).toBe('new-turn-baseline')
      expect(h.events.some(event => event.type === 'complete')).toBe(false)
      expect(h.events.some(event => event.type === 'info')).toBe(false)
      expect(h.effects).toEqual(effectsBeforeRelease)
    },
  )

  it('ignores a stale generation before clearing runtime state or emitting lifecycle events', async () => {
    const h = harness()
    h.startNext()
    h.events.length = 0
    await h.stop(1)
    expect(h.managed.isProcessing).toBe(true)
    expect(h.events).toEqual([])
    expect(h.effects).toEqual([])
  })

  it('keeps an expired permission blocked when the provider reports a later stop for the same generation', async () => {
    const h = harness()
    h.managed.isProcessing = false
    h.managed.sessionStatus = 'blocked'
    h.managed.activeObjective = {
      schemaVersion: 1, objectiveId: 'human', userMessageId: 'human', startedAt: 1,
      budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'mission', risk: 'high-stakes', completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'blocked_human', completedAt: 2,
    }
    h.runtime.permissionExpiryStopGenerations.set(h.managed, 1)

    await h.stop(1, 'complete')

    expect(h.managed.sessionStatus).toBe('blocked')
    expect(h.managed.activeObjective.terminalState).toBe('blocked_human')
    expect(h.events).toEqual([])
    expect(h.effects).toEqual([])
  })

  it('does not unbind the replacement runtime after a browser cleanup rejection', async () => {
    const h = harness('browser-release', true)
    const stopping = h.stop()
    await h.reached.promise
    h.startNext()
    h.release.resolve()
    await stopping
    expect(h.managed.isProcessing).toBe(true)
    expect(h.events.some(event => event.type === 'complete')).toBe(false)
    expect(h.effects).not.toContain('unbind')
    expect(h.effects).not.toContain('conductor')
  })

  it('prevents the real status setter from publishing an old done status after its flush', async () => {
    const h = harness('mini-status')
    h.runtime.setSessionStatus = (SessionManager.prototype as any).setSessionStatus
    h.runtime.setMetadataWriteGuard = () => {}
    h.runtime.configWatchers = new Map()
    h.runtime.flushSession = async () => { h.reached.resolve(); await h.release.promise }
    const stopping = h.stop()
    await h.reached.promise
    h.startNext()
    h.managed.sessionStatus = 'in-progress'
    h.release.resolve()
    await stopping
    expect(h.managed.sessionStatus).toBe('in-progress')
    expect(h.managed.isProcessing).toBe(true)
    expect(h.events.some(event => event.type === 'session_status_changed' || event.type === 'complete')).toBe(false)
  })

  it('still completes and persists the owning generation without changing queued flags', async () => {
    const h = harness()
    h.managed.messages.push({ id: 'queued', role: 'user', content: 'Next', timestamp: 2, isQueued: true })
    await h.stop()
    expect(h.managed.isProcessing).toBe(false)
    expect(h.events.map(event => event.type)).toEqual(['session_metadata_changed', 'complete'])
    expect(h.effects).toContain('conductor')
    expect(h.effects.at(-1)).toBe('persist')
    expect(h.managed.messages.find(message => message.id === 'queued')?.isQueued).toBe(true)
  })

  it.each([
    { terminalState: 'complete_verified' as const, reason: 'complete' as const },
    { terminalState: 'exhausted' as const, reason: 'error' as const },
  ])('retains a $terminalState machine inbox as Retry context while publishing the terminal lifecycle', async fixture => {
    const h = harness()
    h.managed.activeObjective = {
      schemaVersion: 1, objectiveId: 'human', userMessageId: 'human', startedAt: 1,
      budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'direct', risk: 'standard', completionCriteria: ['requested-outcome-delivered'],
      terminalState: fixture.terminalState,
    }
    h.managed.sessionStatus = 'in-progress'
    h.managed.turnLifecycleManagedStatus = 'in-progress'
    for (const index of fixture.terminalState === 'exhausted' ? [1, 2] : [1]) {
      const id = `delivery-${index}`
      h.managed.messages.push({
        id, role: 'user', content: `Child result ${index}`, timestamp: index + 1, hidden: true, isQueued: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: `child-${index}`, deliveryId: id },
        agentDelivery: { id, status: 'queued', attempts: 0 },
      })
      h.managed.messageQueue.push({
        messageId: id, message: `Child result ${index}`, options: {
          hidden: true,
          internalOrigin: { kind: 'agent-message', senderSessionId: `child-${index}`, deliveryId: id },
        },
      })
    }

    await h.stop(1, fixture.reason)

    expect(h.managed.messageQueue).toHaveLength(fixture.terminalState === 'exhausted' ? 2 : 1)
    expect(h.managed.messages.filter(message => message.isQueued)).toHaveLength(h.managed.messageQueue.length)
    expect(h.effects).not.toContain('dispatch-queue')
    expect(h.terminalReasons).toEqual([fixture.reason])
    expect(h.events.filter(event => event.type === 'complete')).toHaveLength(1)
    expect(h.events.find(event => event.type === 'complete')?.reason).toBe(fixture.reason)
    expect(h.effects.filter(effect => effect === 'conductor')).toHaveLength(1)
    expect(h.runtime.deferredAutomaticSessions.has(h.managed.id)).toBe(false)
  })

  it('keeps an explicit user Stop interrupted when a blocked objective races with cleanup', async () => {
    const h = harness()
    h.managed.activeObjective = {
      schemaVersion: 1, objectiveId: 'human', userMessageId: 'human', startedAt: 1,
      budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'direct', risk: 'standard', completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'blocked_policy',
    }
    h.managed.stopRequested = true

    await h.stop(1, 'interrupted')

    expect(h.terminalReasons).toEqual(['interrupted'])
    expect(h.events.find(event => event.type === 'complete')?.reason).toBe('interrupted')
  })

  it.each(['blocked_policy', 'exhausted'] as const)(
    'clears a current pending recovery instead of retaining it behind an older $terminalState snapshot', async terminalState => {
      const h = harness()
      h.managed.messages.push({
        id: 'latest-human', role: 'user', content: 'Continue the current objective.', timestamp: 2,
      })
      h.managed.activeObjective = {
        schemaVersion: 1, objectiveId: 'human', userMessageId: 'human', lastUserMessageId: 'latest-human', startedAt: 1,
        budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
        orchestrationMode: 'direct', risk: 'standard', completionCriteria: ['requested-outcome-delivered'],
        terminalState,
        interruptedTurnRecovery: {
          objectiveId: 'human', userMessageId: 'latest-human',
          recovery: terminalState === 'exhausted' ? {
            ...createPendingTurnRecovery('human'), exhaustedAt: 2, lastCause: 'stream_ended',
            continuationOrigin: 'objective_continue', continuationWork: ['Previously preserved work'],
          } : createPendingTurnRecovery('human'),
        },
      }
      h.managed.pendingTurnRecovery = createPendingTurnRecovery('latest-human')

      await h.stop(1, 'error')

      expect(h.effects).toContain('clear-recovery')
    },
  )

  it('retains a bound visible snapshot whose exact recovery points at a hidden answer', async () => {
    const h = harness()
    const questions = [{ id: 'scope', question: 'Which scope?' }]
    const answers = [{ questionId: 'scope', optionIds: [], text: 'Saved answer.' }]
    h.managed.messages.push(
      { id: 'latest-human', role: 'user', content: 'Use the saved scope.', timestamp: 2 },
      { id: 'hidden-user-input-answer', role: 'user',
        content: USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({ requestId: 'saved-request', questions, answers }), timestamp: 3,
        hidden: true, internalOrigin: { kind: 'user-input' } },
    )
    h.managed.userInputRequests = [{
      id: 'saved-request', sessionId: h.managed.id, originWorkspaceId: h.managed.workspace.id,
      questions, status: 'answered', createdAt: 2, answeredAt: 3,
      objectiveUserMessageId: 'human', responseMessageId: 'hidden-user-input-answer',
      answers,
    }]
    h.managed.activeObjective = {
      schemaVersion: 1, objectiveId: 'human', userMessageId: 'human', lastUserMessageId: 'latest-human', startedAt: 1,
      budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'direct', risk: 'standard', completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'blocked_policy',
      interruptedTurnRecovery: {
        objectiveId: 'human', userMessageId: 'latest-human',
        recovery: createPendingTurnRecovery('hidden-user-input-answer'),
      },
    }
    h.managed.pendingTurnRecovery = undefined

    await h.stop(1, 'error')

    expect(h.effects).not.toContain('clear-recovery')
  })

  it('keeps a genuine queued human turn on the normal FIFO path', async () => {
    const h = harness()
    h.managed.activeObjective = {
      schemaVersion: 1, objectiveId: 'human', userMessageId: 'human', startedAt: 1,
      budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 0,
      orchestrationMode: 'direct', risk: 'standard', completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'complete_verified',
    }
    h.managed.messages.push({ id: 'next-human', role: 'user', content: 'Nouvel objectif.', timestamp: 2, isQueued: true })
    h.managed.messageQueue.push({ messageId: 'next-human', message: 'Nouvel objectif.' })

    await h.stop()

    expect(h.effects).toContain('dispatch-queue')
    expect(h.terminalReasons).toEqual([])
    expect(h.events.some(event => event.type === 'complete')).toBe(false)
    expect(h.effects).not.toContain('conductor')
  })
})
