import { type SessionSendArguments } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupRestartRecovery, type Managed, bindDelegation, deferred, harness, queueTypedUpwardDelivery, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('bounded automatic admission', () => {
  it.each([
    ['parent-to-child', 'result'],
    ['parent-to-child', 'decision'],
    ['sibling-to-sibling', 'result'],
    ['sibling-to-sibling', 'decision'],
  ] as const)('keeps a typed %s %s relay on normal admission', async (topology, messageType) => {
    const h = harness(); const root = h.make(`typed-normal-${topology}-${messageType}-root`)
    let sender: Managed; let target: Managed
    if (topology === 'parent-to-child') {
      sender = root
      target = h.make(`typed-normal-child-${messageType}`, root.id)
      bindDelegation(root, root, target)
    } else {
      sender = h.make(`typed-normal-sender-${messageType}`, root.id)
      target = h.make(`typed-normal-target-${messageType}`, root.id)
      bindDelegation(root, root, sender); bindDelegation(root, root, target)
    }
    sender.isProcessing = true
    const item = queueTypedUpwardDelivery(target, sender, messageType)
    const dispatches: SessionSendArguments[] = []
    h.manager.sendMessage = async (...args) => { dispatches.push(args) }

    h.runtime.processNextQueuedMessage(target.id)
    await tick(); await tick()

    expect(dispatches.map(args => args[5])).toEqual([item.messageId])
    expect(target.messageQueue).toEqual([])
  })

  it('preserves FIFO while releasing progress ahead of an actionable result on the same branch', async () => {
    const h = harness(); const root = h.make('typed-progress-result-root')
    const child = h.make('typed-progress-result-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const progress = queueTypedUpwardDelivery(root, child, 'progress', 'typed-progress-before-result')
    const result = queueTypedUpwardDelivery(root, child, 'result', 'typed-result-after-progress')
    const dispatches: string[] = []
    h.manager.sendMessage = async (...args) => { dispatches.push(requiredTestValue(args[5])) }

    h.runtime.processNextQueuedMessage(root.id)
    await tick(); await tick()
    expect(dispatches).toEqual([progress.messageId])
    expect(root.messageQueue).toEqual([result])

    sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.clear()
    sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.clear()
    sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.clear()
    const progressReceipt = root.messages.find(message => message.id === progress.messageId)!
    progressReceipt.isQueued = false
    progressReceipt.agentDelivery!.status = 'processed'
    h.runtime.processNextQueuedMessage(root.id)
    await tick(); await tick()
    expect(dispatches).toEqual([progress.messageId, result.messageId])
    expect(root.messageQueue).toEqual([])
  })

  it('carries progress-before-result through the real sendMessage boundary', async () => {
    const h = harness(); const root = h.make('typed-real-progress-root')
    const child = h.make('typed-real-progress-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const progress = queueTypedUpwardDelivery(root, child, 'progress', 'typed-real-progress')
    const result = queueTypedUpwardDelivery(root, child, 'result', 'typed-real-result-after-progress')
    const entered = deferred(); const release = deferred(); let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      entered.resolve()
      await release.promise
      throw new Error('Synthetic progress-before-result provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(root.id)
    await entered.promise

    expect(root.messages.find(message => message.id === progress.messageId)?.agentDelivery)
      .toMatchObject({ status: 'processing', attempts: 1 })
    expect(root.messageQueue).toEqual([result])
    release.resolve(); await dispatch; await h.manager.cleanup()
  })

  it('releases only the exact depth-two sender path and keeps another active branch blocking', async () => {
    const h = harness(); const root = h.make('typed-depth-root')
    const middle = h.make('typed-depth-middle', root.id)
    const sender = h.make('typed-depth-sender', middle.id)
    bindDelegation(root, root, middle); bindDelegation(root, middle, sender)
    middle.isProcessing = true; sender.isProcessing = true
    const item = queueTypedUpwardDelivery(root, sender, 'result')
    const dispatches: SessionSendArguments[] = []
    h.manager.sendMessage = async (...args) => { dispatches.push(args); args[7]?.(requiredTestValue(args[5])) }

    h.runtime.processNextQueuedMessage(root.id)
    await tick(); await tick()
    expect(dispatches.map(args => args[5])).toEqual([item.messageId])
    sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.clear()
    sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.clear()
    sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.clear()
    const firstReceipt = root.messages.find(message => message.id === item.messageId)!
    firstReceipt.isQueued = false
    firstReceipt.agentDelivery!.status = 'processed'

    const sibling = h.make('typed-depth-sibling', root.id)
    bindDelegation(root, root, sibling); sibling.isProcessing = true
    const second = queueTypedUpwardDelivery(root, sender, 'decision', 'second-depth-result')
    h.runtime.processNextQueuedMessage(root.id)
    await tick(); await tick()
    expect(dispatches.map(args => args[5])).toEqual([item.messageId])
    expect(root.messageQueue).toEqual([second])
  })

  it('does not let a lone typed upward progress bypass an active descendant', async () => {
    const h = harness(); const root = h.make('typed-held-progress-root')
    const child = h.make('typed-held-progress-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'progress')
    let dispatches = 0
    h.manager.sendMessage = async () => { dispatches++ }

    h.runtime.processNextQueuedMessage(root.id)
    await tick()
    expect(dispatches).toBe(0)
    expect(root.messageQueue).toEqual([item])
  })

  it('does not release progress for an actionable receipt on another descendant branch', async () => {
    const h = harness(); const root = h.make('typed-cross-branch-root')
    const progressSender = h.make('typed-cross-branch-progress', root.id)
    const resultSender = h.make('typed-cross-branch-result', root.id)
    bindDelegation(root, root, progressSender); bindDelegation(root, root, resultSender)
    progressSender.isProcessing = true; resultSender.isProcessing = true
    const progress = queueTypedUpwardDelivery(root, progressSender, 'progress')
    const result = queueTypedUpwardDelivery(root, resultSender, 'result')
    let dispatches = 0
    h.manager.sendMessage = async () => { dispatches++ }

    h.runtime.processNextQueuedMessage(root.id)
    await tick()

    expect(dispatches).toBe(0)
    expect(root.messageQueue).toEqual([progress, result])
  })

  it.each(['progress', 'result', 'question', 'decision'] as const)(
    'quarantines a stale upward %s instead of injecting it into a newer objective', async messageType => {
      const h = harness(); const root = h.make(`typed-stale-${messageType}-root`)
      const child = h.make(`typed-stale-${messageType}-child`, root.id)
      bindDelegation(root, root, child)
      const item = queueTypedUpwardDelivery(root, child, messageType)
      child.delegation!.parentObjectiveId = 'superseded-objective'
      let dispatches = 0
      h.manager.sendMessage = async () => { dispatches++ }

      h.runtime.processNextQueuedMessage(root.id)
      await h.manager.flushSession(root.id)
      for (let index = 0; index < 3; index++) await tick()

      expect(dispatches).toBe(0)
      expect(root.messageQueue).toEqual([])
      expect(root.messages.find(message => message.id === item.messageId)).toMatchObject({
        isQueued: false,
        agentDelivery: { status: 'failed', attempts: 1 },
      })
    },
  )

  it('rejects a fresh typed message from a stale structural descendant before persistence', async () => {
    const h = harness(); const root = h.make('typed-fresh-stale-root')
    const child = h.make('typed-fresh-stale-child', root.id)
    bindDelegation(root, root, child)
    child.delegation!.parentObjectiveId = 'superseded-before-fresh-send'
    const deliveryId = 'typed-fresh-stale-result'
    let acknowledgements = 0; let preparations = 0
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare') }

    await expect(h.manager.sendMessage(
      root.id,
      'stale result',
      undefined,
      undefined,
      { hidden: true, internalOrigin: {
        kind: 'agent-message', senderSessionId: child.id, deliveryId, agentMessageType: 'result',
      } },
      undefined,
      undefined,
      () => { acknowledgements++ },
    )).rejects.toThrow('superseded delegated objective')

    expect(acknowledgements).toBe(0)
    expect(preparations).toBe(0)
    expect(root.messageQueue).toEqual([])
    expect(root.messages.some(message => message.agentDelivery?.id === deliveryId)).toBe(false)
  })

  it('rejects a fresh typed handoff retargeted during hydration', async () => {
    const h = harness(); const root = h.make('typed-fresh-race-root')
    const child = h.make('typed-fresh-race-child', root.id)
    bindDelegation(root, root, child)
    const deliveryId = 'typed-fresh-race-decision'
    const entered = deferred(); const release = deferred()
    h.runtime.ensureMessagesLoaded = async () => { entered.resolve(); await release.promise }
    let acknowledgements = 0; let preparations = 0
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare') }
    const sending = h.manager.sendMessage(
      root.id,
      'stale decision',
      undefined,
      undefined,
      { hidden: true, internalOrigin: {
        kind: 'agent-message', senderSessionId: child.id, deliveryId, agentMessageType: 'decision',
      } },
      undefined,
      undefined,
      () => { acknowledgements++ },
    ).then(() => undefined, error => error)

    await entered.promise
    child.delegation!.parentObjectiveId = 'superseded-during-fresh-hydration'
    release.resolve()
    expect(await sending).toBeInstanceOf(Error)
    expect(acknowledgements).toBe(0)
    expect(preparations).toBe(0)
    expect(root.messageQueue).toEqual([])
    expect(root.messages.some(message => message.agentDelivery?.id === deliveryId)).toBe(false)
  })

  it('cold-restores and dispatches the same typed upward result exactly once', async () => {
    const h = harness(); const root = h.make('typed-cold-root')
    const child = h.make('typed-cold-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-cold-receipt')
    await h.save(root); await h.save(child)

    const cold = h.cold()
    const restoredRoot = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(root.id))
    const restoredChild = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(child.id))
    await cold.runtime.ensureMessagesLoaded(restoredRoot)
    await cold.runtime.ensureMessagesLoaded(restoredChild)
    restoredChild.isProcessing = true
    const dispatches: SessionSendArguments[] = []
    cold.manager.sendMessage = async (...args) => { dispatches.push(args); args[7]?.(requiredTestValue(args[5])) }

    cold.runtime.processNextQueuedMessage(restoredRoot.id)
    await tick(); await tick()
    cold.runtime.processNextQueuedMessage(restoredRoot.id)
    await tick()

    expect(dispatches.map(args => args[5])).toEqual([item.messageId])
    expect(restoredRoot.messageQueue).toEqual([])
    expect(restoredRoot.messages.filter((message: Managed['messages'][number]) => (
      message.agentDelivery?.id === 'typed-cold-receipt'
    ))).toHaveLength(1)
  })

  it('does not bypass a local question or Stop, then quarantines a stale head and drains the next relay', async () => {
    const h = harness(); const root = h.make('typed-guard-root')
    const child = h.make('typed-guard-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result')
    const dispatches: string[] = []
    h.manager.sendMessage = async (...args) => { dispatches.push(requiredTestValue(args[5])) }
    root.userInputRequests = [{ status: 'pending', sessionId: root.id }] as never
    h.runtime.processNextQueuedMessage(root.id); await tick()
    expect(dispatches).toEqual([]); expect(root.messageQueue).toEqual([item])

    root.userInputRequests = []
    root.stopRequested = true
    h.runtime.processNextQueuedMessage(root.id); await tick()
    expect(dispatches).toEqual([]); expect(root.messageQueue).toEqual([item])

    root.stopRequested = false
    child.delegation!.parentObjectiveId = 'stale-objective'
    const relay = h.make('typed-guard-unrelated-relay')
    const next = queueTypedUpwardDelivery(root, relay, 'result', 'typed-after-stale-relay')
    h.runtime.processNextQueuedMessage(root.id)
    await h.manager.flushSession(root.id)
    for (let index = 0; index < 6; index++) await tick()

    expect(dispatches).toEqual([next.messageId])
    expect(root.messageQueue).toEqual([])
    expect(root.messages.find(message => message.id === item.messageId)).toMatchObject({
      isQueued: false,
      agentDelivery: { status: 'failed', attempts: 1 },
    })
  })

  it('quarantines a delivery that becomes stale after dequeue but before dispatch', async () => {
    const h = harness(); const root = h.make('typed-stale-dequeue-root')
    const child = h.make('typed-stale-dequeue-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result')
    let preparations = 0
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare') }

    h.runtime.processNextQueuedMessage(root.id)
    child.delegation!.parentObjectiveId = 'superseded-after-dequeue'
    await tick()
    await h.manager.flushSession(root.id)
    for (let index = 0; index < 5; index++) await tick()

    expect(preparations).toBe(0)
    expect(root.messageQueue).toEqual([])
    expect(root.messages.find(message => message.id === item.messageId)).toMatchObject({
      isQueued: false,
      agentDelivery: { status: 'failed', attempts: 1 },
    })
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.size).toBe(0)
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.size).toBe(0)
  })

  it('rechecks stale ancestry after sendMessage hydration and never prepares the provider', async () => {
    const h = harness(); const root = h.make('typed-stale-hydration-root')
    const child = h.make('typed-stale-hydration-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'decision')
    const entered = deferred(); const release = deferred(); let dispatch: Promise<void> | undefined
    h.runtime.ensureMessagesLoaded = async () => { entered.resolve(); await release.promise }
    let preparations = 0
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare') }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(root.id)
    await entered.promise
    child.delegation!.parentObjectiveId = 'superseded-during-hydration'
    release.resolve(); await dispatch

    expect(preparations).toBe(0)
    expect(root.messageQueue).toEqual([])
    expect(root.messages.find(message => message.id === item.messageId)).toMatchObject({
      isQueued: false,
      agentDelivery: { status: 'failed', attempts: 1 },
    })
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.size).toBe(0)
  })

  it('cold-restores, quarantines and drains a stale typed head exactly once', async () => {
    const h = harness(); const root = h.make('typed-stale-cold-root')
    const child = h.make('typed-stale-cold-child', root.id)
    const relay = h.make('typed-stale-cold-relay')
    bindDelegation(root, root, child)
    const stale = queueTypedUpwardDelivery(root, child, 'progress', 'typed-stale-cold-progress')
    const next = queueTypedUpwardDelivery(root, relay, 'result', 'typed-stale-cold-next')
    child.delegation!.parentObjectiveId = 'superseded-before-restart'
    await h.save(root); await h.save(child); await h.save(relay)

    const cold = h.cold()
    const restoredRoot = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(root.id))
    await Promise.all([
      cold.runtime.ensureMessagesLoaded(restoredRoot),
      cold.runtime.ensureMessagesLoaded(requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(child.id))),
      cold.runtime.ensureMessagesLoaded(requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(relay.id))),
    ])
    const dispatches: string[] = []
    cold.manager.sendMessage = async (...args) => { dispatches.push(requiredTestValue(args[5])) }

    cold.runtime.processNextQueuedMessage(root.id)
    await cold.manager.flushSession(root.id)
    for (let index = 0; index < 6; index++) await tick()

    expect(dispatches).toEqual([next.messageId])
    expect(restoredRoot.messageQueue).toEqual([])
    expect(restoredRoot.messages.find((message: Managed['messages'][number]) => (
      message.id === stale.messageId
    ))).toMatchObject({ isQueued: false, agentDelivery: { status: 'failed', attempts: 1 } })
  })
});
