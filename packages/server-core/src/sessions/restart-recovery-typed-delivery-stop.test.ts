import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupRestartRecovery, type Managed, bindDelegation, deferred, harness, queueTypedUpwardDelivery, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('bounded automatic admission', () => {
  it('does not let a legacy first-event fallback cross a Stop cancellation epoch', async () => {
    const h = harness(); const root = h.make('typed-legacy-stop-before-event-root')
    const child = h.make('typed-legacy-stop-before-event-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-legacy-stop-before-event-result')
    const receipt = root.messages.find(message => message.id === item.messageId)!
    Object.assign(receipt.agentDelivery!, {
      setupFailureCount: 3,
      lastSetupFailureClass: 'timeout',
      setupRetryNotBefore: Date.now() - 1,
    })
    const entered = deferred(); const release = deferred()
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        entered.resolve()
        await release.promise
        yield { type: 'info' as const, message: 'Late legacy event after Stop' }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      root.agent = runtimeAgent
      return runtimeAgent
    }
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(root.id)
    await entered.promise
    await h.manager.cancelProcessing(root.id)
    release.resolve()
    await dispatch

    expect(receipt.agentDelivery?.setupFailureCount).toBe(3)
    expect(receipt.agentDelivery?.lastSetupFailureClass).toBe('timeout')
    expect(receipt.agentDelivery?.setupRetryNotBefore).toBeDefined()
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(item.messageId)).toBe(false)
  })

  it('does not replay a queued delivery when Stop wins after out-of-process dispatch but before handoff acknowledgement', async () => {
    const h = harness(); const root = h.make('typed-uncertain-dispatch-stop-root')
    const child = h.make('typed-uncertain-dispatch-stop-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(
      root,
      child,
      'result',
      'typed-uncertain-dispatch-stop-result',
    )
    const receipt = root.messages.find(message => message.id === item.messageId)!
    const entered = deferred(); const release = deferred()
    let lateProviderHandoff: (() => void) | undefined
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      onProviderHandoff: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        runtimeAgent.onProviderDispatchUncertain?.()
        lateProviderHandoff = runtimeAgent.onProviderHandoff ?? undefined
        entered.resolve()
        await release.promise
        lateProviderHandoff?.()
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      root.agent = runtimeAgent
      return runtimeAgent
    }
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      dispatch = send(...args)
      return dispatch
    }

    h.runtime.processNextQueuedMessage(root.id)
    await entered.promise
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.get(item.messageId))
      .toMatchObject({ providerDispatchUncertain: true, providerStarted: false })

    await h.manager.cancelProcessing(root.id)
    expect(receipt.isQueued).toBe(false)
    expect(receipt.agentDelivery?.status).toBe('processed')
    expect(receipt.agentDelivery?.attempts).toBe(1)
    expect(typeof receipt.agentDelivery?.providerDispatchUncertainAt).toBe('number')
    expect(root.messageQueue).toEqual([])

    release.resolve()
    await dispatch
    lateProviderHandoff?.()
    expect(receipt.isQueued).toBe(false)
    expect(root.messageQueue).toEqual([])
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(item.messageId)).toBe(false)

    await h.manager.flushSession(root.id)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(root.id))
    cold.runtime.processNextQueuedMessage = () => {
      throw new Error('Uncertain provider delivery must not replay after restart')
    }
    await cold.runtime.ensureMessagesLoaded(restored)
    expect(restored.messageQueue).toEqual([])
    const restoredReceipt = restored.messages.find(
      (message: Managed['messages'][number]) => message.id === item.messageId,
    )
    expect(restoredReceipt?.isQueued).toBe(false)
    expect(restoredReceipt?.agentDelivery?.status).toBe('processed')
    expect(restoredReceipt?.agentDelivery?.attempts).toBe(1)
    expect(typeof restoredReceipt?.agentDelivery?.providerDispatchUncertainAt).toBe('number')
  })

  it('keeps an agent delivery pre-provider when its async chat generator ends before the first event', async () => {
    const h = harness(); const root = h.make('typed-empty-chat-root')
    const child = h.make('typed-empty-chat-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-empty-chat-result')
    const receipt = root.messages.find(message => message.id === item.messageId)!
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
    expect<unknown>(receipt).toMatchObject({
      isQueued: true,
      agentDelivery: {
        id: item.messageId, status: 'queued', attempts: 0,
        setupFailureCount: 1, lastSetupFailureClass: 'unknown',
        setupRetryNotBefore: (expect.any(Number) as unknown),
      },
    })
    expect(root.messageQueue.map(entry => entry.messageId)).toEqual([item.messageId])
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(item.messageId)).toBe(false)
  })
});
