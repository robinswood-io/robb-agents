import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupRestartRecovery, bindDelegation, harness, queueTypedUpwardDelivery, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('bounded automatic admission', () => {
  it('does not infer provider handoff from a local event when the backend exposes the explicit boundary', async () => {
    const h = harness(); const root = h.make('typed-explicit-local-event-root')
    const child = h.make('typed-explicit-local-event-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-explicit-local-event-result')
    const receipt = root.messages.find(message => message.id === item.messageId)!
    Object.assign(receipt.agentDelivery!, {
      setupFailureCount: 3,
      lastSetupFailureClass: 'timeout',
      setupRetryNotBefore: Date.now() - 1,
    })
    let chatCalls = 0
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      onProviderHandoff: null as (() => void) | null,
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        chatCalls++
        yield { type: 'info' as const, message: 'Preparing local provider context' }
        const error = new Error('Synthetic explicit-boundary preparation timeout') as Error & { code: string }
        error.code = 'ETIMEDOUT'
        throw error
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

  it('rolls back an explicit backend error and complete after child dispatch but before provider handoff', async () => {
    const h = harness(); const root = h.make('typed-explicit-local-terminal-root')
    const child = h.make('typed-explicit-local-terminal-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(
      root,
      child,
      'result',
      'typed-explicit-local-terminal-result',
    )
    const receipt = root.messages.find(message => message.id === item.messageId)!
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
        yield { type: 'error' as const, message: 'Synthetic local validation failure' }
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
    for (let index = 0; index < 4; index++) await tick()
    await dispatch

    expect(receipt).toMatchObject({
      isQueued: true,
      agentDelivery: {
        id: item.messageId,
        status: 'queued',
        attempts: 0,
        setupFailureCount: 1,
      },
    })
    expect(root.messages.some(message => (
      message.role === 'error' && message.content === 'Synthetic local validation failure'
    ))).toBe(false)
    expect(root.messageQueue.map(entry => entry.messageId)).toEqual([item.messageId])
    expect(root.activeAgentDelivery).toBeUndefined()
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(item.messageId)).toBe(false)
    expect(runtimeAgent.onProviderHandoff).toBeNull()
    expect(receipt.agentDelivery?.providerDispatchUncertainAt).toBeUndefined()
  })

  it('ignores an explicit provider acknowledgement captured before a pre-provider rollback', async () => {
    const h = harness(); const root = h.make('typed-explicit-late-ack-root')
    const child = h.make('typed-explicit-late-ack-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-explicit-late-ack-result')
    const receipt = root.messages.find(message => message.id === item.messageId)!
    Object.assign(receipt.agentDelivery!, {
      setupFailureCount: 3,
      lastSetupFailureClass: 'timeout',
      setupRetryNotBefore: Date.now() - 1,
    })
    let delayedAcknowledgement: (() => void) | undefined
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      onProviderHandoff: null as (() => void) | null,
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        delayedAcknowledgement = runtimeAgent.onProviderHandoff ?? undefined
        const error = new Error('Synthetic failure before delayed provider acknowledgement') as Error & { code: string }
        error.code = 'ETIMEDOUT'
        throw error
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
    for (let index = 0; index < 4; index++) await tick()
    await dispatch

    expect(delayedAcknowledgement).toBeDefined()
    expect(runtimeAgent.onProviderHandoff).toBeNull()
    const retainedSetupState = structuredClone(receipt.agentDelivery!)
    delayedAcknowledgement?.()
    expect(receipt.agentDelivery).toEqual(retainedSetupState)
    expect(receipt.agentDelivery?.setupFailureCount).toBe(4)
    expect(receipt.agentDelivery?.setupRetryBlockedAt).toEqual(expect.any(Number))
    expect(receipt.agentDelivery?.setupRetryNotBefore).toBeUndefined()
    expect(root.messageQueue.map(entry => entry.messageId)).toEqual([item.messageId])
  })

  it('commits provider handoff only when the explicit backend callback fires', async () => {
    const h = harness(); const root = h.make('typed-explicit-provider-root')
    const child = h.make('typed-explicit-provider-child', root.id)
    bindDelegation(root, root, child); child.isProcessing = true
    const item = queueTypedUpwardDelivery(root, child, 'result', 'typed-explicit-provider-result')
    const receipt = root.messages.find(message => message.id === item.messageId)!
    Object.assign(receipt.agentDelivery!, {
      setupFailureCount: 3,
      lastSetupFailureClass: 'timeout',
      setupRetryNotBefore: Date.now() - 1,
    })
    let chatCalls = 0
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      onProviderHandoff: null as (() => void) | null,
      getModel: () => 'fixture-model',
      getSessionId: () => null,
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        chatCalls++
        runtimeAgent.onProviderHandoff?.()
        const error = new Error('Synthetic post-provider timeout') as Error & { code: string }
        error.code = 'ETIMEDOUT'
        throw error
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
    for (let index = 0; index < 4; index++) await tick()
    await dispatch

    expect(chatCalls).toBe(1)
    expect(receipt.agentDelivery?.setupFailureCount).toBeUndefined()
    expect(receipt.agentDelivery?.lastSetupFailureClass).toBeUndefined()
    expect(receipt.agentDelivery?.setupRetryBlockedAt).toBeUndefined()
    expect(receipt.agentDelivery?.setupRetryNotBefore).toBeUndefined()
    expect(runtimeAgent.onProviderHandoff).toBeNull()
  })
});
