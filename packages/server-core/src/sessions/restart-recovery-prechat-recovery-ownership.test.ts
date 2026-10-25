import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createAutonomyFallbackIntent } from "./autonomy-browser-fallback";
import { cleanupRestartRecovery, deferred, enableAutomaticToolFallback, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('lets a human continuation supersede a dequeued fallback during hydration without resetting its budget', async () => {
    const h = harness(); const managed = h.make('restart-owner')
    enableAutomaticToolFallback(h)
    const originalObjective = structuredClone(managed.activeObjective)
    const hydrationEntered = deferred(); const releaseHydration = deferred(); const preparing = deferred(); const releaseAgent = deferred()
    let hydrations = 0, automaticPreparations = 0, humanPreparations = 0
    h.runtime.ensureMessagesLoaded = async () => { if (++hydrations === 1) { hydrationEntered.resolve(); await releaseHydration.promise } }
    h.runtime.getOrCreateAgent = async (_session, request) => {
      if (requiredTestValue(request).message.includes('<automatic_turn_recovery')) automaticPreparations++
      else humanPreparations++
      preparing.resolve(); await releaseAgent.promise
      throw new Error('Synthetic provider boundary')
    }
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 1, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      validationGaps: ['Verify the preserved result'],
      continuationWork: ['Finish the same objective'],
      continuationOrigin: 'objective_continue',
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed,
      'runtime_error',
      undefined,
      undefined,
      undefined,
      createAutonomyFallbackIntent('browser_fallback', 'mcp__crm__lookup'),
    )).toBe(true)
    const dispatches: Promise<void>[] = []
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      const promise = send(...args)
      dispatches.push(promise)
      return promise
    }
    h.runtime.processNextQueuedMessage(managed.id)
    await hydrationEntered.promise
    let queuedId = ''
    await h.manager.sendMessage(managed.id, 'Continue l’objectif en cours avec la même cible.', undefined, undefined, undefined, undefined, false, id => { queuedId = id })
    expect(automaticPreparations).toBe(0)
    releaseHydration.resolve(); await preparing.promise
    expect(automaticPreparations).toBe(0)
    expect(humanPreparations).toBe(1)
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.has(managed.id)).toBe(false)
    expect(managed.messageQueue).toEqual([])
    expect(managed.pendingTurnRecovery).toMatchObject({
      userMessageId: queuedId,
      attempts: 2,
      validationGaps: ['Verify the preserved result'],
      continuationWork: ['Finish the same objective'],
    })
    expect(managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
    expect(managed.activeObjective?.userMessageId).toBe(originalObjective?.userMessageId)
    expect(managed.messages.filter(message => message.hidden && message.content.includes('<automatic_turn_recovery '))).toHaveLength(0)
    expect(managed.messages.filter(message => message.hidden && message.isQueued)).toHaveLength(0)
    releaseAgent.resolve()
    await Promise.allSettled(dispatches)
  })

  it('removes an already-persisted synthetic fallback when a human arrives during dispatch durability', async () => {
    const h = harness(); const managed = h.make('persisted-fallback-human-race')
    enableAutomaticToolFallback(h)
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 1, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      validationGaps: ['Preserve this gap'],
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed,
      'runtime_error',
      undefined,
      undefined,
      undefined,
      createAutonomyFallbackIntent('structured_fallback', 'mcp__session__browser_tool'),
    )).toBe(true)

    const originalFlush = h.manager.flushSession.bind(h.manager)
    const persistedSynthetic = deferred(); const releaseDispatchFlush = deferred()
    let held = false
    h.manager.flushSession = async id => {
      await originalFlush(id)
      if (!held && managed.messages.some(message => message.hidden
        && message.content.includes('<automatic_turn_recovery '))) {
        held = true
        persistedSynthetic.resolve()
        await releaseDispatchFlush.promise
      }
    }
    const preparing = deferred(); const releaseAgent = deferred()
    let automaticPreparations = 0; let humanPreparations = 0
    h.runtime.getOrCreateAgent = async (_session, request) => {
      if (requiredTestValue(request).message.includes('<automatic_turn_recovery')) automaticPreparations++
      else humanPreparations++
      preparing.resolve(); await releaseAgent.promise
      throw new Error('Synthetic provider boundary')
    }
    const dispatches: Promise<void>[] = []
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      const promise = send(...args)
      dispatches.push(promise)
      return promise
    }

    h.runtime.processNextQueuedMessage(managed.id)
    await persistedSynthetic.promise
    const beforeRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(beforeRows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(true)
    let humanId = ''
    await h.manager.sendMessage(
      managed.id,
      'Continue l’objectif en cours avec la même cible.',
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      id => { humanId = id },
    )
    // The human acknowledgement owns the cleanup durability; the older
    // automatic flush remains blocked and may never resume before a crash.
    const acceptedRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(acceptedRows.some(row => row.id === humanId && !row.hidden)).toBe(true)
    expect(acceptedRows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)
    expect(acceptedRows[0].pendingTurnRecovery.recoveryDispatch).toBeUndefined()
    const coldBeforeRelease = h.cold()
    coldBeforeRelease.runtime.processNextQueuedMessage = () => {}
    const restoredBeforeRelease = requiredTestValue(sessionRuntimeStateForTest(coldBeforeRelease.runtime).sessions.get(managed.id))
    await coldBeforeRelease.runtime.ensureMessagesLoaded(restoredBeforeRelease)
    expect(restoredBeforeRelease.messages.some((row) => row.role === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)
    expect(restoredBeforeRelease.messageQueue.some((item) => item.messageId === humanId)).toBe(true)
    expect(requiredTestValue(restoredBeforeRelease.pendingTurnRecovery).recoveryDispatch).toBeUndefined()

    releaseDispatchFlush.resolve()
    await preparing.promise

    expect(automaticPreparations).toBe(0)
    expect(humanPreparations).toBe(1)
    expect(managed.messages.some(message => message.hidden
      && message.content.includes('<automatic_turn_recovery '))).toBe(false)
    expect(managed.pendingTurnRecovery).toMatchObject({
      userMessageId: humanId, attempts: 2, validationGaps: ['Preserve this gap'],
    })
    expect(managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
    await originalFlush(managed.id)
    const afterRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(afterRows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)
    releaseAgent.resolve()
    await Promise.allSettled(dispatches)
  })

  it('durably removes only the persisted synthetic recovery when Stop wins its first flush', async () => {
    const h = harness(); const managed = h.make('persisted-recovery-stop-race')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    managed.messages.push(
      { id: 'real-human-context', role: 'user', content: 'Keep this accepted instruction.', timestamp: 2 },
      { id: 'real-agent-context', role: 'user', hidden: true, content: 'Keep this processed agent report.', timestamp: 3,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'fixture-child', deliveryId: 'fixture-delivery' },
        agentDelivery: { id: 'fixture-delivery', status: 'processed', attempts: 1 } },
    )
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'runtime_error')).toBe(true)

    const originalFlush = h.manager.flushSession.bind(h.manager)
    const persistedSynthetic = deferred(); const releaseDispatchFlush = deferred()
    let held = false
    h.manager.flushSession = async id => {
      await originalFlush(id)
      if (!held && managed.messages.some(message => message.hidden
        && message.content.includes('<automatic_turn_recovery '))) {
        held = true
        persistedSynthetic.resolve()
        await releaseDispatchFlush.promise
      }
    }
    let preparations = 0
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Model preparation must not start') }
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(managed.id)
    await persistedSynthetic.promise
    const beforeRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(beforeRows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(true)

    await h.manager.cancelProcessing(managed.id)
    // Stop itself owns the deletion durability. The older send is still held
    // here; a crash now must not be able to resurrect its hidden instruction.
    expect(preparations).toBe(0)
    expect(managed.messageQueue).toEqual([])
    expect(managed.pendingTurnRecovery).toBeUndefined()
    expect(managed.messages.map(message => message.id)).toContain('real-human-context')
    expect(managed.messages.map(message => message.id)).toContain('real-agent-context')
    expect(managed.messages.some(message => message.hidden
      && message.content.includes('<automatic_turn_recovery '))).toBe(false)
    const stoppedRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(stoppedRows.some(row => row.id === 'real-human-context')).toBe(true)
    expect(stoppedRows.some(row => row.id === 'real-agent-context')).toBe(true)
    expect(stoppedRows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)

    const cold = h.cold(); let restartPreparations = 0
    cold.runtime.getOrCreateAgent = async () => { restartPreparations++; throw new Error('Stopped recovery must not restart') }
    await cold.runtime.resumePendingTurnAfterRestart(managed.id)
    await tick(); await tick()
    expect(restartPreparations).toBe(0)
    expect(requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)).messageQueue).toEqual([])

    releaseDispatchFlush.resolve()
    await dispatch
    await originalFlush(managed.id)
    const afterRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(afterRows.some(row => row.id === 'real-human-context')).toBe(true)
    expect(afterRows.some(row => row.id === 'real-agent-context')).toBe(true)
    expect(afterRows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)
    expect(afterRows.filter(row => row.type === 'info' && row.content === 'Response interrupted')).toHaveLength(1)
  })

  it('makes a pre-chat recovery replayable before orderly shutdown returns', async () => {
    const h = harness(); const managed = h.make('persisted-recovery-shutdown-race')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'runtime_error')).toBe(true)
    const dispatchId = managed.pendingTurnRecovery!.recoveryDispatch!.id

    const originalFlush = h.manager.flushSession.bind(h.manager)
    const persistedSynthetic = deferred(); const releaseDispatchFlush = deferred()
    let held = false
    h.manager.flushSession = async id => {
      await originalFlush(id)
      if (!held && managed.messages.some(message => message.hidden
        && message.content.includes('<automatic_turn_recovery '))) {
        held = true
        persistedSynthetic.resolve()
        await releaseDispatchFlush.promise
      }
    }
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(managed.id)
    await persistedSynthetic.promise
    let cleanupSettled = false
    const cleanup = h.manager.cleanup().then(() => { cleanupSettled = true })
    await tick()
    expect(cleanupSettled).toBe(false)
    releaseDispatchFlush.resolve()
    await dispatch
    await cleanup

    const stoppedRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(stoppedRows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)
    expect(stoppedRows[0].pendingTurnRecovery.recoveryDispatch).toMatchObject({
      id: dispatchId, phase: 'allocated',
    })
    const cold = h.cold(); cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.resumePendingTurnAfterRestart(managed.id)
    const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    expect(restored.messageQueue[0]?.options?.automaticRecovery?.dispatchId).toBe(dispatchId)
    expect(restored.messages.some((message) => message.role === 'user' && message.hidden
      && message.content.includes('<automatic_turn_recovery '))).toBe(false)

  })

  it('does not retain an undelivered automatic recovery after runtime setup fails', async () => {
    const h = harness(); const managed = h.make('automatic-setup-failure')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'runtime_error')).toBe(true)
    const queued = managed.messageQueue.shift()!
    h.runtime.getOrCreateAgent = async () => { throw new Error('Fixture setup failure before chat') }

    await h.manager.sendMessage(
      managed.id,
      queued.message,
      queued.attachments,
      queued.storedAttachments,
      queued.options,
    )

    expect(managed.messages.some(message => message.hidden
      && message.content.includes('<automatic_turn_recovery '))).toBe(false)
    await h.manager.flushSession(managed.id)
    const rows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(rows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)
  })

  it('removes and untracks only the synthetic recovery when its first flush fails', async () => {
    const h = harness(); const managed = h.make('automatic-first-flush-failure')
    managed.messages.push({
      id: 'preserved-hidden-agent-message', role: 'user', hidden: true,
      content: 'Preserve this real processed delivery.', timestamp: 2,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'fixture-child' },
    })
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'runtime_error')).toBe(true)
    const queued = managed.messageQueue.shift()!
    const originalFlush = h.manager.flushSession.bind(h.manager)
    let failed = false
    h.manager.flushSession = async id => {
      if (!failed) { failed = true; throw new Error('Fixture first flush failure') }
      await originalFlush(id)
    }

    await expect(h.manager.sendMessage(
      managed.id,
      queued.message,
      queued.attachments,
      queued.storedAttachments,
      queued.options,
    )).rejects.toThrow('Fixture first flush failure')

    expect(managed.isProcessing).toBe(false)
    expect(managed.messages.some(message => message.hidden
      && message.content.includes('<automatic_turn_recovery '))).toBe(false)
    expect(managed.messages.find(message => message.id === 'preserved-hidden-agent-message')).toBeDefined()
    expect(sessionRuntimeStateForTest(h.runtime).syntheticAutomaticMessagesInFlight.get(managed)).toBeUndefined()
    expect(managed.pendingTurnRecovery?.recoveryDispatch?.phase).toBe('allocated')
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.options?.automaticRecovery?.dispatchId)
      .toBe(managed.pendingTurnRecovery?.recoveryDispatch?.id)
    await originalFlush(managed.id)
    const rows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(rows.some(row => row.type === 'user' && row.hidden
      && row.content.includes('<automatic_turn_recovery '))).toBe(false)
    expect(rows.some(row => row.id === 'preserved-hidden-agent-message')).toBe(true)
  })

  it('keeps a pre-chat deferred recovery replayable and tracked until agent.chat', async () => {
    const h = harness(); const parent = h.make('deferred-recovery-parent')
    const managed = h.make('deferred-recovery-child', parent.id)
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'runtime_error')).toBe(true)
    const preparationEntered = deferred(); const releasePreparation = deferred()
    const unusedAgent = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => false, dispose: () => {},
    })
    h.runtime.getOrCreateAgent = async () => {
      preparationEntered.resolve()
      await releasePreparation.promise
      return unusedAgent
    }
    const dispatches: Promise<void>[] = []
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      const dispatch = send(...args)
      dispatches.push(dispatch)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(managed.id)
    await preparationEntered.promise
    parent.pendingAuthRequestId = 'defer-before-chat'
    releasePreparation.resolve()
    await dispatches[0]

    const deferredMessage = managed.messages.find(message => message.hidden
      && message.content.includes('<automatic_turn_recovery '))
    expect(deferredMessage?.isQueued).toBe(true)
    expect(managed.messageQueue[0]?.messageId).toBe(deferredMessage?.id)
    expect(managed.pendingTurnRecovery?.recoveryDispatch?.phase).toBe('allocated')
    expect(sessionRuntimeStateForTest(h.runtime).syntheticAutomaticMessagesInFlight.get(managed)?.has(requiredTestValue(deferredMessage))).toBe(true)

    const chatEntered = deferred()
    const deliveredAgent = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => false, dispose: () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        chatEntered.resolve()
        yield { type: 'typed_error', error: {
          code: 'unknown_error', title: 'Fixture end', message: 'stop', actions: [], canRetry: false,
        } }
        yield { type: 'complete' }
      },
    })
    parent.pendingAuthRequestId = undefined
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = deliveredAgent
      return deliveredAgent
    }
    h.runtime.processNextQueuedMessage(managed.id)
    await chatEntered.promise
    await dispatches[1]

    expect(sessionRuntimeStateForTest(h.runtime).syntheticAutomaticMessagesInFlight.get(managed)).toBeUndefined()
    expect(managed.messages.some(message => message === deferredMessage)).toBe(true)
  })
});
