import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { getDefaultStatusConfig, saveStatusConfig } from "@craft-agent/shared/statuses";
import { createPendingTurnRecovery, buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { createAutonomyFallbackIntent } from "./autonomy-browser-fallback";
import { cleanupRestartRecovery, deferred, enableAutomaticToolFallback, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('discards a stale recovery FIFO after objective retargeting and publishes completion', async () => {
    const h = harness(); const managed = h.make('stale-recovery-after-retarget')
    enableAutomaticToolFallback(h)
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed,
      'runtime_error',
      undefined,
      undefined,
      undefined,
      createAutonomyFallbackIntent('browser_fallback', 'mcp__crm__lookup'),
    )).toBe(true)
    managed.messages.push({ id: 'retargeted-root', role: 'user', timestamp: 3, content: 'Nouvel objectif déjà accepté.' })
    managed.activeObjective = {
      ...managed.activeObjective!, objectiveId: 'retargeted-root', userMessageId: 'retargeted-root',
      lastUserMessageId: 'retargeted-root', originalText: 'Nouvel objectif déjà accepté.',
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery('retargeted-root', 3)
    let modelDispatches = 0
    h.runtime.sendMessage = async () => { modelDispatches++ }
    const completed = deferred()
    h.manager.onSessionComplete(() => completed.resolve())

    h.runtime.processNextQueuedMessage(managed.id)
    await completed.promise

    expect(modelDispatches).toBe(0)
    expect(managed.messageQueue).toEqual([])
    expect(managed.pendingTurnRecovery).toMatchObject({ userMessageId: 'retargeted-root', attempts: 0 })
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'complete', sessionId: managed.id }))
  })

  it('keeps a reserved ID-less restart paused if a human decision appears during hydration', async () => {
    const h = harness(); const managed = h.make('restart-decision')
    managed.messageQueue.push({ message: buildAutomaticTurnRecoveryPrompt(managed.pendingTurnRecovery!, 'app_restart'),
      options: { hidden: true, automaticRecovery: { originalUserMessageId: 'restart-decision-user', cause: 'app_restart' } } })
    h.runtime.ensureMessagesLoaded = async () => { managed.pendingAuthRequestId = 'auth-required' }
    let starts = 0
    h.runtime.getOrCreateAgent = async () => { starts++; throw new Error('Must not start') }
    h.runtime.processNextQueuedMessage(managed.id)
    for (let index = 0; index < 5; index++) await tick()
    expect(starts).toBe(0)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messages).toHaveLength(1)
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.has(managed.id)).toBe(false)
  })

  it('does not clear or complete a replacement reservation when an old dispatch rejects after Stop', async () => {
    const h = harness(); const managed = h.make('late-queue-error')
    managed.messageQueue.push({ message: 'Old internal continuation' })
    let rejectOld!: (error: Error) => void
    const old = new Promise<void>((_resolve, reject) => { rejectOld = reject })
    let sends = 0
    h.manager.sendMessage = async () => { if (++sends === 1) await old }
    h.runtime.processNextQueuedMessage(managed.id)
    await tick()
    await h.manager.cancelProcessing(managed.id)
    managed.messageQueue.push({ message: 'New internal continuation' })
    h.runtime.processNextQueuedMessage(managed.id)
    const replacement = sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.get(managed.id)
    const eventsBeforeError = h.events.length
    rejectOld(new Error('Old hydration failed'))
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.get(managed.id)).toBe(replacement)
    expect(h.events).toHaveLength(eventsBeforeError)
    await tick()
    expect(sends).toBe(2)
  })

  it('cold-loads the exact c3 queued hidden restart record without deriving authority from its text or duplicating it', async () => {
    const h = harness(); const managed = h.make('persisted-c3-recovery')
    const originalObjective = structuredClone(managed.activeObjective)
    const originalRecovery = structuredClone(managed.pendingTurnRecovery)
    managed.messages.push({ id: 'already-persisted-recovery', role: 'user', hidden: true, isQueued: true, timestamp: Date.now(),
      content: buildAutomaticTurnRecoveryPrompt(managed.pendingTurnRecovery!, 'app_restart') })
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const preparing = deferred(); const releaseAgent = deferred()
    cold.runtime.startGenerationTelemetry = () => {}; cold.runtime.finishGenerationTelemetry = () => {}
    let preparations = 0
    cold.runtime.getOrCreateAgent = async () => { preparations++; preparing.resolve(); await releaseAgent.promise; throw new Error('Synthetic provider boundary') }
    let dispatch: Promise<void> | undefined
    let receivedOptions: unknown
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => { receivedOptions = args[4]; dispatch = send(...args); return dispatch }
    await cold.runtime.resumePendingTurnAfterRestart(managed.id)
    await preparing.promise
    expect(preparations).toBe(1)
    expect(receivedOptions).toEqual({ hidden: true })
    expect(restored.pendingTurnRecovery).toEqual(originalRecovery)
    expect(restored.activeObjective).toEqual(originalObjective)
    expect(restored.messageQueue).toHaveLength(0)
    expect(restored.messages.filter((message) => message.role === 'user' && !message.hidden)).toHaveLength(1)
    expect(restored.messages.filter((message) => message.id === 'already-persisted-recovery')).toHaveLength(1)
    expect(requiredTestValue(restored.messages.find((message) => message.id === 'already-persisted-recovery')).isQueued).toBe(false)
    releaseAgent.resolve(); await dispatch; await cold.manager.cleanup()
  })

  it.each(['done', 'cancelled'])(
    'retains a queued human turn without auto-resuming a closed %s session after cold start', async sessionStatus => {
      const h = harness(); const managed = h.make(`terminal-status-${sessionStatus}`)
      managed.sessionStatus = sessionStatus
      managed.pendingTurnRecovery = undefined
      managed.messages.push({
        id: 'queued-human', role: 'user', content: 'Continue the superseded task.',
        timestamp: 2, isQueued: true,
      })
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      const dequeues: string[] = []
      cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
      await cold.runtime.ensureMessagesLoaded(restored)
      await tick(); await tick()

      expect(dequeues).toEqual([])
      expect(restored.messageQueue.map((item: { messageId?: string }) => item.messageId)).toEqual(['queued-human'])
      expect(restored.messages.find((message: { id: string; isQueued?: boolean }) => message.id === 'queued-human')?.isQueued).toBe(true)
    },
  )

  it.each(['complete', 'completed', 'interrupted'])(
    'retains a queued human turn for an unconfigured legacy terminal status %s', async sessionStatus => {
      const h = harness(); const managed = h.make(`legacy-terminal-status-${sessionStatus}`)
      managed.sessionStatus = sessionStatus
      managed.pendingTurnRecovery = undefined
      managed.messages.push({
        id: 'queued-human', role: 'user', content: 'Continue only after an explicit reopen.',
        timestamp: 2, isQueued: true,
      })
      const dequeues: string[] = []
      h.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
      h.runtime.restoreDurableRuntimeState(managed)
      await tick(); await tick()

      expect(dequeues).toEqual([])
      expect(managed.messageQueue.map((item: { messageId?: string }) => item.messageId)).toEqual(['queued-human'])
    },
  )

  it.each(['completed', 'interrupted'])(
    'respects a configured open %s status and resumes its queued human turn', async sessionStatus => {
      const h = harness(); const managed = h.make(`custom-open-status-${sessionStatus}`)
      const statusConfig = getDefaultStatusConfig()
      statusConfig.statuses.push({
        id: sessionStatus, label: sessionStatus, category: 'open',
        isFixed: false, isDefault: false, order: statusConfig.statuses.length,
      })
      saveStatusConfig(h.rootPath, statusConfig)
      managed.sessionStatus = sessionStatus
      managed.pendingTurnRecovery = undefined
      managed.messages.push({
        id: 'queued-human', role: 'user', content: 'Continue the custom open task.',
        timestamp: 2, isQueued: true,
      })
      await h.save(managed)

      const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
      const dequeues: string[] = []
      cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
      await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
      await tick(); await tick()

      expect(dequeues).toEqual([managed.id])
    },
  )

  it('resumes a queued human turn from needs-review when its objective is active', async () => {
    const h = harness(); const managed = h.make('needs-review-human-continuation')
    managed.sessionStatus = 'needs-review'
    managed.pendingTurnRecovery = undefined
    managed.messages.push({ id: 'queued-human', role: 'user', content: 'Apply my review.', timestamp: 2, isQueued: true })
    await h.save(managed)

    const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
    const dequeues: string[] = []
    cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
    await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
    await tick(); await tick()

    expect(dequeues).toEqual([managed.id])
  })

  it.each(['complete_verified', 'blocked_human', 'blocked_policy', 'exhausted'] as const)(
    'lets a queued direct human turn replace a %s objective in an open session', async terminalState => {
      const h = harness(); const managed = h.make(`terminal-objective-human-${terminalState}`)
      managed.sessionStatus = 'todo'
      managed.activeObjective!.terminalState = terminalState
      managed.pendingTurnRecovery = undefined
      managed.messages.push({
        id: 'queued-human', role: 'user', content: 'Continue the old objective.',
        timestamp: 2, isQueued: true,
      })
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      const dequeues: string[] = []
      cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
      await cold.runtime.ensureMessagesLoaded(restored)
      await tick(); await tick()

      expect(dequeues).toEqual([managed.id])
      expect(restored.messageQueue.map((item: { messageId?: string }) => item.messageId)).toEqual(['queued-human'])
      expect(restored.messages.find((message: { id: string; isQueued?: boolean }) => message.id === 'queued-human')?.isQueued).toBe(true)
    },
  )

  it('retains a machine-only inbox for a terminal objective', async () => {
    const h = harness(); const managed = h.make('terminal-machine-inbox')
    managed.sessionStatus = 'todo'
    managed.activeObjective!.terminalState = 'complete_verified'
    managed.pendingTurnRecovery = undefined
    managed.messages.push({
      id: 'queued-machine', role: 'user', content: 'Internal continuation.',
      timestamp: 2, hidden: true, isQueued: true,
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const dequeues: string[] = []
    cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
    cold.runtime.reconcileRetainedTerminalMachineInbox = async () => {}
    await cold.runtime.ensureMessagesLoaded(restored)
    await tick(); await tick()

    expect(dequeues).toEqual([])
    expect(restored.messageQueue.map((item: { messageId?: string }) => item.messageId)).toEqual(['queued-machine'])
  })

  it.each([undefined, null])('does not treat legacy terminalState=%s as terminal', async terminalState => {
    const h = harness(); const managed = h.make(`legacy-objective-state-${String(terminalState)}`)
    managed.sessionStatus = 'todo'
    ;(managed.activeObjective as { terminalState?: unknown }).terminalState = terminalState
    managed.pendingTurnRecovery = undefined
    managed.messages.push({ id: 'queued-human', role: 'user', content: 'Continue the legacy task.', timestamp: 2, isQueued: true })
    await h.save(managed)

    const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
    const dequeues: string[] = []
    cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
    await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
    await tick(); await tick()

    expect(dequeues).toEqual([managed.id])
  })
});
