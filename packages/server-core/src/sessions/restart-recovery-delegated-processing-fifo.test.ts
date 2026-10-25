import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { delegatedTerminalResultDeliveryId as policyDelegatedTerminalResultDeliveryId } from "./SessionManager/policy.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { createPendingTurnRecovery } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it.each([
    { label: 'live', cold: false },
    { label: 'after a cold restore', cold: true },
  ])('retains an exhausted child receipt behind another question and publishes its retry question $label', async ({ cold }) => {
    const h = harness(); let parent = h.make(`occupied-question-parent-${cold}`); let child = h.make(`occupied-question-child-${cold}`, parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    child.pendingTurnRecovery = undefined
    const deliveryId = policyDelegatedTerminalResultDeliveryId(parent, child)!
    parent.messages.push({
      id: 'occupied-failed-terminal-receipt', role: 'user',
      content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 4,
      hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: child.id, deliveryId },
      agentDelivery: { id: deliveryId, status: 'failed', attempts: 3 },
    })
    const unrelated = await h.manager.requestUserInput(parent.id, [{
      id: 'unrelated-parent-choice', question: 'Choose an unrelated presentation preference.',
      options: [{ id: 'compact', label: 'Compact' }],
    }])

    let manager = h.manager
    let runtime = h.runtime
    if (cold) {
      await h.save(parent); await h.save(child)
      const restored = h.cold()
      manager = restored.manager
      runtime = restored.runtime
      parent = requiredTestValue(sessionRuntimeStateForTest(runtime).sessions.get(parent.id))
      child = requiredTestValue(sessionRuntimeStateForTest(runtime).sessions.get(child.id))
      await runtime.ensureMessagesLoaded(parent)
      await runtime.ensureMessagesLoaded(child)
    }
    runtime.processNextQueuedMessage = () => { throw new Error('retry question must not replay child work') }
    runtime.scheduleDelegatedTerminalResultRetry(child.id)

    expect(await runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(false)
    expect(sessionRuntimeStateForTest(runtime).delegatedTerminalResultRetryTimers.has(child.id)).toBe(true)
    expect(parent.userInputRequests?.filter((request) => request.status === 'pending'))
      .toHaveLength(1)
    expect(parent.messages.filter((message: Managed['messages'][number]) => (
      message.content.startsWith('[host-delegated-terminal-result-v1]')
    ))).toHaveLength(1)

    await manager.respondToUserInput(parent.id, { requestId: unrelated.requestId, cancelled: true })
    await tick(); await tick(); await tick()

    const pending = parent.userInputRequests?.filter((request) => request.status === 'pending') ?? []
    expect(pending).toHaveLength(1)
    expect(pending[0]?.questions).toMatchObject([{
      id: `retry-child-result-${child.id}`.slice(0, 80),
    }])
    expect(sessionRuntimeStateForTest(runtime).delegatedTerminalResultRetryTimers.has(child.id)).toBe(false)
    expect(parent.messages.filter((message: Managed['messages'][number]) => (
      message.content.startsWith('[host-delegated-terminal-result-v1]')
    ))).toHaveLength(1)
    expect(parent.messages.find((message: Managed['messages'][number]) => (
      message.agentDelivery?.id === deliveryId
    ))).toMatchObject({ agentDelivery: { status: 'failed', attempts: 3 } })
  })

  it('does not replay a claimed child receipt ahead of a later accepted human row when the provider emitted nothing', async () => {
    const h = harness(); const parent = h.make('live-delivery-human-supersession'); const child = h.make('live-delivery-human-supersession-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    child.pendingTurnRecovery = undefined
    const deliveryId = policyDelegatedTerminalResultDeliveryId(parent, child)!
    const receipt: Managed['messages'][number] = {
      id: 'claimed-terminal-before-human', role: 'user' as const,
      content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 4,
      hidden: true, isQueued: false,
      internalOrigin: { kind: 'agent-message' as const, senderSessionId: child.id, deliveryId },
      agentDelivery: { id: deliveryId, status: 'processing', attempts: 1 },
    }
    const boundary = parent.messages.length
    parent.messages.push(receipt)
    const queuedHuman: Managed['messages'][number] = {
      id: 'newer-human-row', role: 'user', content: 'Use the newer target instead.', timestamp: 5,
      isQueued: true,
    }
    parent.messages.push(queuedHuman)
    parent.messageQueue.push({ messageId: 'newer-human-row', message: 'Use the newer target instead.' })
    parent.isProcessing = true
    parent.processingGeneration = 1
    parent.activeAgentDelivery = { deliveryId, generation: 1 }
    // An accepted direct-human steer replaces the mutable last-sent payload;
    // receipt classification must retain its independent generation claim.
    parent.lastSentMessage = queuedHuman.content
    parent.lastSentOptions = undefined
    parent.waitDiagnosticBoundary = {
      generation: 1,
      objectiveId: parentObjectiveId,
      fromMessageCount: boundary,
    }
    let nextDispatches = 0
    h.runtime.processNextQueuedMessage = () => { nextDispatches++ }

    await h.runtime.onProcessingStopped(parent.id, 'interrupted', 1)

    expect(receipt.agentDelivery!.status).toBe('processed')
    expect(receipt.isQueued).toBe(false)
    expect(parent.activeAgentDelivery).toBeUndefined()
    expect(sessionRuntimeStateForTest(h.runtime).delegatedTerminalResultRetryTimers.has(child.id)).toBe(false)
    expect(parent.messages.find(message => message.id === 'newer-human-row')?.isQueued).toBe(true)
    expect(nextDispatches).toBe(1)
  })

  it('does not let a claimed delivery count itself as consumption when a live turn stops without activity', async () => {
    const h = harness(); const managed = h.make('live-delivery-no-activity')
    const boundary = managed.messages.length
    const receipt: Managed['messages'][number] = {
      id: 'claimed-delivery-no-activity', role: 'user', content: 'Machine delivery A.', timestamp: 2,
      hidden: true, isQueued: false,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'missing-child', deliveryId: 'delivery-a' },
      agentDelivery: { id: 'delivery-a', status: 'processing', attempts: 1 },
    }
    managed.messages.push(receipt)
    managed.isProcessing = true
    managed.processingGeneration = 1
    managed.lastSentMessage = receipt.content
    managed.lastSentOptions = { hidden: true, internalOrigin: receipt.internalOrigin }
    managed.waitDiagnosticBoundary = {
      generation: 1,
      objectiveId: managed.activeObjective!.objectiveId ?? managed.activeObjective!.userMessageId,
      fromMessageCount: boundary,
    }
    h.runtime.processNextQueuedMessage = () => {}

    await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)

    expect(receipt).toMatchObject({ isQueued: false, agentDelivery: { status: 'failed', attempts: 1 } })
  })

  it('requeues failed delivery A ahead of later queued machine delivery B before draining the live FIFO', async () => {
    const h = harness(); const parent = h.make('live-delivery-a-before-b'); const child = h.make('live-delivery-a-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    child.pendingTurnRecovery = undefined
    child.messages.push({ id: 'live-a-child-final', role: 'assistant', content: 'Child A result.', timestamp: 3 })
    const deliveryId = policyDelegatedTerminalResultDeliveryId(parent, child)!
    const boundary = parent.messages.length
    const receiptA: Managed['messages'][number] = {
      id: 'live-processing-a', role: 'user',
      content: '[host-delegated-terminal-result-v1]\n{}\n\nChild A result.', timestamp: 4,
      hidden: true, isQueued: false,
      internalOrigin: { kind: 'agent-message', senderSessionId: child.id, deliveryId },
      agentDelivery: { id: deliveryId, status: 'processing', attempts: 1 },
    }
    const receiptB: Managed['messages'][number] = {
      id: 'live-queued-b', role: 'user', content: 'Later machine delivery B.', timestamp: 5,
      hidden: true, isQueued: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'later-child', deliveryId: 'delivery-b' },
      agentDelivery: { id: 'delivery-b', status: 'queued', attempts: 0 },
    }
    parent.messages.push(receiptA, receiptB)
    parent.messageQueue.push({
      messageId: receiptB.id, message: receiptB.content,
      options: { hidden: true, internalOrigin: receiptB.internalOrigin },
    })
    parent.isProcessing = true
    parent.processingGeneration = 1
    parent.lastSentMessage = receiptA.content
    parent.lastSentOptions = { hidden: true, internalOrigin: receiptA.internalOrigin }
    parent.waitDiagnosticBoundary = { generation: 1, objectiveId: parentObjectiveId, fromMessageCount: boundary }
    const observedFronts: Array<string | undefined> = []
    h.runtime.processNextQueuedMessage = () => { observedFronts.push(parent.messageQueue[0]?.messageId) }

    await h.runtime.onProcessingStopped(parent.id, 'interrupted', 1)

    expect(receiptA).toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 1 } })
    expect(receiptB).toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 0 } })
    expect(parent.messageQueue.map(item => item.messageId)).toEqual([receiptA.id, receiptB.id])
    expect(observedFronts).toEqual([receiptA.id])
    expect(sessionRuntimeStateForTest(h.runtime).delegatedTerminalResultRetryTimers.has(child.id)).toBe(false)
  })

  it('restores processing delivery A ahead of later queued machine delivery B without treating B as consumption', async () => {
    const h = harness(); const managed = h.make('cold-delivery-a-before-b')
    const receiptA: Managed['messages'][number] = {
      id: 'cold-processing-a', role: 'user', content: 'Machine delivery A.', timestamp: 2,
      hidden: true, isQueued: false,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child-a', deliveryId: 'cold-delivery-a' },
      agentDelivery: { id: 'cold-delivery-a', status: 'processing', attempts: 1 },
    }
    const receiptB: Managed['messages'][number] = {
      id: 'cold-queued-b', role: 'user', content: 'Machine delivery B.', timestamp: 3,
      hidden: true, isQueued: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child-b', deliveryId: 'cold-delivery-b' },
      agentDelivery: { id: 'cold-delivery-b', status: 'queued', attempts: 0 },
    }
    managed.messages.push(receiptA, receiptB)
    managed.messageQueue.push({
      messageId: receiptB.id, message: receiptB.content,
      options: { hidden: true, internalOrigin: receiptB.internalOrigin },
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.ensureMessagesLoaded(restored)

    expect(restored.messages.find((message) => message.id === receiptA.id))
      .toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 1 } })
    expect(restored.messages.find((message) => message.id === receiptB.id))
      .toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 0 } })
    expect(restored.messageQueue.map((item) => item.messageId)).toEqual([receiptA.id, receiptB.id])
    expect(restored.messageQueue.filter((item) => item.messageId === receiptA.id)).toHaveLength(1)
    expect(restored.messageQueue.filter((item) => item.messageId === receiptB.id)).toHaveLength(1)
  })

  it.each([
    {
      label: 'an intermediate assistant fragment',
      activity: { id: 'partial', role: 'assistant', content: 'Work is still in progress.', timestamp: 3, isIntermediate: true },
    },
    {
      label: 'a provider error',
      activity: { id: 'provider-error', role: 'error', content: 'Transient provider failure.', timestamp: 3 },
    },
    {
      label: 'a completed mutation receipt',
      activity: { id: 'completed-mutation', role: 'tool', content: '', timestamp: 3, toolName: 'Write',
        toolUseId: 'completed-mutation-use', toolInput: { file_path: '/fixture/state.json', content: 'done' },
        toolStatus: 'completed', toolExecuted: true, toolResult: 'written' },
    },
    {
      label: 'an unverified final answer',
      activity: { id: 'unverified-final', role: 'assistant', content: 'This may be complete.', timestamp: 3, isIntermediate: false },
    },
  ])('never raw-replays a processing delivery after $label', async ({ activity }) => {
    const h = harness(); const managed = h.make(`consumed-delivery-${activity.id}`)
    managed.messages.push({
      id: 'processing-delivery', role: 'user', content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 2,
      hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: 'fixture-child', deliveryId: 'delivery-1' },
      agentDelivery: { id: 'delivery-1', status: 'processing', attempts: 1 },
    }, activity as never)
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let rawDispatches = 0; let schedulerWakes = 0
    cold.runtime.processNextQueuedMessage = () => { rawDispatches++ }
    cold.runtime.scheduleDeferredAutomaticSessions = () => { schedulerWakes++ }
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id)
    await tick()

    expect(restored.messages.find((message) => message.id === 'processing-delivery'))
      .toMatchObject({ isQueued: false, agentDelivery: { status: 'processed', attempts: 1 } })
    expect(restored.messageQueue.some((item) => item.messageId === 'processing-delivery')).toBe(false)
    expect(restored.pendingTurnRecovery).toMatchObject({
      userMessageId: managed.activeObjective!.userMessageId,
      lastCause: 'app_restart',
      continuationRequired: true,
    })
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(restored.id)).toBe(true)
    expect(rawDispatches).toBe(0)
    expect(schedulerWakes).toBe(1)
  })

  it('uses a newer accepted human objective instead of replaying an older processing delivery', async () => {
    const h = harness(); const managed = h.make('consumed-delivery-human-supersession')
    managed.messages.push({
      id: 'processing-delivery', role: 'user', content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 2,
      hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: 'fixture-child', deliveryId: 'delivery-human' },
      agentDelivery: { id: 'delivery-human', status: 'processing', attempts: 1 },
    }, {
      id: 'new-human-objective', role: 'user', content: 'Inspect only the current saved state.', timestamp: 3,
    })
    managed.activeObjective = {
      ...managed.activeObjective!,
      objectiveId: 'new-human-objective',
      userMessageId: 'new-human-objective',
      lastUserMessageId: 'new-human-objective',
      originalText: 'Inspect only the current saved state.',
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery('new-human-objective')
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let rawDispatches = 0
    cold.runtime.processNextQueuedMessage = () => { rawDispatches++ }
    cold.runtime.scheduleDeferredAutomaticSessions = () => {}
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id)
    await tick()

    expect(restored.messages.find((message) => message.id === 'processing-delivery'))
      .toMatchObject({ isQueued: false, agentDelivery: { status: 'processed' } })
    expect(restored.pendingTurnRecovery).toMatchObject({
      userMessageId: 'new-human-objective', lastCause: 'app_restart', continuationRequired: true,
    })
    expect(restored.messageQueue.some((item) => item.messageId === 'processing-delivery')).toBe(false)
    expect(rawDispatches).toBe(0)
  })
});
