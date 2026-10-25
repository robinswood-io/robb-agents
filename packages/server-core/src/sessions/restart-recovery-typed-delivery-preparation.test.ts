import { type SessionSendArguments } from "./testing/private-runtime-access.ts";
import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupRestartRecovery, type Managed, bindDelegation, deferred, harness, queueTypedUpwardDelivery, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('bounded automatic admission', () => {
  it.each(['result', 'decision', 'question'] as const)(
    'consumes one typed upward %s while its exact sender branch remains active', async messageType => {
      const h = harness(); const root = h.make(`typed-${messageType}-root`)
      const child = h.make(`typed-${messageType}-child`, root.id)
      bindDelegation(root, root, child)
      child.isProcessing = true
      const item = queueTypedUpwardDelivery(root, child, messageType)
      const dispatches: SessionSendArguments[] = []
      h.manager.sendMessage = async (...args) => { dispatches.push(args); args[7]?.(requiredTestValue(args[5])) }

      h.runtime.processNextQueuedMessage(root.id)
      await tick(); await tick()

      expect(dispatches).toHaveLength(1)
      expect(dispatches[0]?.[5]).toBe(item.messageId)
      expect(dispatches[0]?.[4]?.internalOrigin).toMatchObject({
        senderSessionId: child.id, agentMessageType: messageType,
      })
      expect(root.messageQueue).toEqual([])
    },
  )

  it('carries the typed-result admission through the real sendMessage boundary', async () => {
    const h = harness(); const root = h.make('typed-real-send-root')
    const child = h.make('typed-real-send-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-real-send-result')
    const entered = deferred(); const release = deferred()
    let preparations = 0; let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      preparations++
      entered.resolve()
      await release.promise
      throw new Error('Synthetic typed-result provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(root.id)
    await entered.promise

    expect(preparations).toBe(1)
    expect(root.messageQueue).toEqual([])
    expect(root.messages.find(message => message.id === item.messageId)?.agentDelivery)
      .toMatchObject({ id: 'typed-real-send-result', status: 'processing', attempts: 1 })
    expect(child.isProcessing).toBe(true)
    release.resolve(); await dispatch; await h.manager.cleanup()
    expect(root.messages.find(message => message.id === item.messageId)).toMatchObject({
      isQueued: true,
      agentDelivery: { id: 'typed-real-send-result', status: 'queued', attempts: 0 },
    })
    expect(root.messageQueue.map(entry => entry.messageId)).toEqual([item.messageId])
  })

  it('carries a parent-to-child typed result through normal real admission', async () => {
    const h = harness(); const parent = h.make('typed-real-parent')
    const child = h.make('typed-real-child', parent.id)
    bindDelegation(parent, parent, child); parent.isProcessing = true
    const item = queueTypedUpwardDelivery(child, parent, 'result', 'typed-real-parent-result')
    const entered = deferred(); const release = deferred()
    let preparations = 0; let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      preparations++
      entered.resolve()
      await release.promise
      throw new Error('Synthetic normal typed-result provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(child.id)
    await entered.promise

    expect(preparations).toBe(1)
    expect(child.messageQueue).toEqual([])
    expect(child.messages.find(message => message.id === item.messageId)?.agentDelivery)
      .toMatchObject({ id: 'typed-real-parent-result', status: 'processing', attempts: 1 })
    expect(parent.isProcessing).toBe(true)
    release.resolve(); await dispatch; await h.manager.cleanup()
    expect(child.messages.find(message => message.id === item.messageId)).toMatchObject({
      isQueued: true,
      agentDelivery: { id: 'typed-real-parent-result', status: 'queued', attempts: 0 },
    })
    expect(child.messageQueue.map(entry => entry.messageId)).toEqual([item.messageId])
  })

  it('restores a fresh idle agent delivery when runtime setup fails before provider handoff', async () => {
    const h = harness(); const root = h.make('typed-fresh-setup-root')
    const child = h.make('typed-fresh-setup-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const deliveryId = 'typed-fresh-setup-result'
    let providerChats = 0
    let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      throw new Error('Synthetic fresh delivery setup failure')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    let acknowledged: string | undefined
    await h.manager.sendMessage(
      root.id,
      'Fresh terminal result.',
      undefined,
      undefined,
      { hidden: true, internalOrigin: {
        kind: 'agent-message', senderSessionId: child.id, deliveryId, agentMessageType: 'result',
      } },
      undefined,
      undefined,
      messageId => { acknowledged = messageId },
    )
    for (let index = 0; index < 4; index++) await tick()
    await dispatch

    const receipt = root.messages.find(message => message.agentDelivery?.id === deliveryId)
    expect(acknowledged).toBe(receipt?.id)
    expect(providerChats).toBe(0)
    expect(receipt).toMatchObject({
      hidden: true, isQueued: true,
      agentDelivery: { id: deliveryId, status: 'queued', attempts: 0 },
    })
    expect(root.messageQueue.map(entry => entry.messageId)).toEqual([receipt?.id])
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(requiredTestValue(receipt).id)).toBe(false)
    await h.manager.flushSession(root.id)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(root.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.ensureMessagesLoaded(restored)
    expect(restored.messages.find((message: Managed['messages'][number]) => message.agentDelivery?.id === deliveryId))
      .toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 0 } })
    expect(restored.messageQueue.map((entry: Managed['messageQueue'][number]) => entry.messageId))
      .toEqual([receipt?.id])
  })

  it('restores an agent delivery when agent.chat throws synchronously before returning an iterator', async () => {
    const h = harness(); const root = h.make('typed-sync-chat-throw-root')
    const child = h.make('typed-sync-chat-throw-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-sync-chat-throw-result')
    let chatCalls = 0
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: async () => {},
      chat: () => {
        chatCalls++
        throw new Error('Synthetic synchronous chat construction failure')
      },
    })
    h.runtime.getOrCreateAgent = async () => runtimeAgent
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(root.id)
    for (let index = 0; index < 4; index++) await tick()
    await dispatch

    expect(chatCalls).toBe(1)
    expect(root.messages.find(message => message.id === item.messageId)).toMatchObject({
      isQueued: true,
      agentDelivery: {
        id: item.messageId, status: 'queued', attempts: 0,
        setupFailureCount: 1, lastSetupFailureClass: 'unknown',
      },
    })
    expect(root.messageQueue.map(entry => entry.messageId)).toEqual([item.messageId])
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(item.messageId)).toBe(false)
  })

  it('keeps an agent delivery pre-provider when its async chat generator rejects before the first event', async () => {
    const h = harness(); const root = h.make('typed-lazy-chat-throw-root')
    const child = h.make('typed-lazy-chat-throw-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-lazy-chat-throw-result')
    const receipt = root.messages.find(message => message.id === item.messageId)!
    Object.assign(receipt.agentDelivery!, {
      setupFailureCount: 3,
      lastSetupFailureClass: 'timeout',
      setupRetryNotBefore: Date.now() - 1,
    })
    let chatCalls = 0
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        chatCalls++
        const error = new Error('Synthetic lazy chat preparation timeout') as Error & { code: string }
        error.code = 'ETIMEDOUT'
        throw error
      },
    })
    h.runtime.getOrCreateAgent = async () => runtimeAgent
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(root.id)
    for (let index = 0; index < 4; index++) await tick()
    await dispatch

    expect(chatCalls).toBe(1)
    expect(receipt).toMatchObject({
      isQueued: true,
      agentDelivery: {
        id: item.messageId, status: 'queued', attempts: 0,
        setupFailureCount: 4, lastSetupFailureClass: 'timeout',
        setupRetryBlockedAt: expect.any(Number),
      },
    })
    expect(receipt.agentDelivery?.setupRetryNotBefore).toBeUndefined()
    expect(root.messageQueue.map(entry => entry.messageId)).toEqual([item.messageId])
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(item.messageId)).toBe(false)
  })
});
