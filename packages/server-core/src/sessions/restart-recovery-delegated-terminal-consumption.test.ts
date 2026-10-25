import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { delegatedTerminalResultContent as policyDelegatedTerminalResultContent, delegatedTerminalResultDeliveryId as policyDelegatedTerminalResultDeliveryId } from "./SessionManager/policy.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath, listSessions } from "@craft-agent/shared/sessions/storage";
import { cleanupRestartRecovery, type Managed, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('replays one delegated terminal receipt after a processing crash and consumes it exactly once', async () => {
    const h = harness(); const parent = h.make('terminal-parent'); const child = h.make('terminal-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id,
      rootObjectiveId: parentObjectiveId,
      parentObjectiveId,
      depth: 1,
      role: 'worker',
      finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    child.pendingTurnRecovery = undefined
    child.messages.push({ id: 'child-final', role: 'assistant', content: 'Verified child result.', timestamp: 3 })
    parent.isProcessing = true

    expect(await h.runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(true)
    expect(await h.runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(true)
    const receipts = parent.messages.filter(message => (
      message.content.startsWith('[host-delegated-terminal-result-v1]')
    ))
    expect(receipts).toHaveLength(1)
    expect(receipts[0]?.agentDelivery).toMatchObject({ status: 'queued', attempts: 0 })
    expect(h.runtime.activeRelevantDelegatedDescendants(parent).map((session: Managed) => session.id)).toContain(child.id)

    receipts[0]!.agentDelivery!.status = 'processing'
    receipts[0]!.agentDelivery!.attempts = 1
    receipts[0]!.isQueued = false
    parent.messageQueue = []
    parent.isProcessing = false
    await h.save(parent); await h.save(child)
    expect(listSessions(h.rootPath).find(meta => meta.id === parent.id)?.pendingAgentDeliveryIds)
      .toEqual([receipts[0]!.id])

    const cold = h.cold()
    cold.runtime.processNextQueuedMessage = () => {}
    const restoredParent = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(parent.id))
    const restoredChild = sessionRuntimeStateForTest(cold.runtime).sessions.get(child.id)
    await cold.runtime.ensureMessagesLoaded(restoredParent)
    await cold.runtime.ensureMessagesLoaded(requiredTestValue(restoredChild))
    const restoredReceipts = restoredParent.messages.filter((message: Managed['messages'][number]) => (
      message.content.startsWith('[host-delegated-terminal-result-v1]')
    ))
    expect(restoredReceipts).toHaveLength(1)
    expect(restoredReceipts[0]).toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 1 } })
    expect(restoredParent.messageQueue.map((item: Managed['messageQueue'][number]) => item.messageId))
      .toEqual([restoredReceipts[0]!.id])

    expect(await cold.runtime.ensureDelegatedTerminalResultDelivery(requiredTestValue(restoredChild))).toBe(true)
    expect(await cold.runtime.ensureDelegatedTerminalResultDelivery(requiredTestValue(restoredChild))).toBe(true)
    expect(restoredParent.messages.filter((message: Managed['messages'][number]) => (
      message.content.startsWith('[host-delegated-terminal-result-v1]')
    ))).toHaveLength(1)
    restoredReceipts[0]!.agentDelivery!.status = 'processed'
    restoredReceipts[0]!.isQueued = false
    expect(cold.runtime.activeRelevantDelegatedDescendants(restoredParent)).toEqual([])
  })

  it('delivers the latest terminal error instead of an obsolete successful-looking child final', () => {
    const h = harness(); const parent = h.make('terminal-error-parent'); const child = h.make('terminal-error-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 4,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'exhausted', completedAt: 4 }
    child.messages.push(
      { id: 'obsolete-child-final', role: 'assistant', content: 'Everything succeeded.', timestamp: 2 },
      { id: 'latest-child-error', role: 'error', content: 'Verification failed after the draft final.', timestamp: 3 },
    )

    const envelope = policyDelegatedTerminalResultContent(child)

    expect(envelope).toContain('"state":"exhausted"')
    expect(envelope).toContain('Verification failed after the draft final.')
    expect(envelope).not.toContain('Everything succeeded.')
  })

  it('consumes an exact queued child receipt in the durable wait_sessions result transaction', async () => {
    const h = harness(); const parent = h.make('wait-consumes-parent'); const child = h.make('wait-consumes-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    child.pendingTurnRecovery = undefined
    child.messages.push({ id: 'wait-child-final', role: 'assistant', content: 'Exact terminal child result.', timestamp: 3 })
    parent.isProcessing = true
    parent.processingGeneration = 1
    h.runtime.processNextQueuedMessage = () => { throw new Error('processed wait receipt must not start a second provider turn') }

    expect(await h.runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(true)
    const receipt = parent.messages.find(message => message.content.startsWith('[host-delegated-terminal-result-v1]'))!
    expect(receipt).toMatchObject({ isQueued: true, agentDelivery: { status: 'queued' } })
    expect(parent.messageQueue.map(item => item.messageId)).toEqual([receipt.id])

    await h.runtime.processEvent(parent, {
      type: 'tool_start', toolName: 'mcp__session__wait_sessions', toolUseId: 'wait-child-tool',
      input: { sessionIds: [child.id], timeoutMs: 60_000 },
    }, 1)
    const waitResult = JSON.stringify({
      outcome: 'completed',
      sessions: [{
        sessionId: child.id, state: 'idle', reason: 'complete', objectiveState: 'complete_verified',
        finalMessageId: 'wait-child-final', finalText: 'Exact terminal child result.',
      }],
    })
    await h.runtime.processEvent(parent, { isError: false,
      type: 'tool_result', toolName: 'mcp__session__wait_sessions', toolUseId: 'wait-child-tool',
      result: waitResult, executed: true,
    }, 1)

    expect(receipt).toMatchObject({ isQueued: false, agentDelivery: { status: 'processed' } })
    expect(parent.messageQueue).toEqual([])
    expect(h.runtime.activeRelevantDelegatedDescendants(parent)).toEqual([])
    const stored = readFileSync(getSessionFilePath(h.rootPath, parent.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(stored.find(message => message.id === receipt.id))
      .toMatchObject({ isQueued: false, agentDelivery: { status: 'processed' } })
    expect(stored.find(message => message.toolUseId === 'wait-child-tool'))
      .toMatchObject({ toolStatus: 'completed', toolResult: waitResult })
  })

  it('cancels a stale terminal-delivery retry answer without reviving its receipt or objective', async () => {
    const h = harness(); const parent = h.make('stale-terminal-retry-parent'); const child = h.make('stale-terminal-retry-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    const deliveryId = policyDelegatedTerminalResultDeliveryId(parent, child)!
    parent.messages.push({
      id: 'failed-terminal-receipt', role: 'user', content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 4,
      hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: child.id, deliveryId },
      agentDelivery: { id: deliveryId, status: 'failed', attempts: 3 },
    })
    h.runtime.processNextQueuedMessage = () => { throw new Error('stale receipt must not dispatch') }

    expect(await h.runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(true)
    expect(await h.runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(true)
    const pending = parent.userInputRequests?.filter((request) => request.status === 'pending') ?? []
    expect(pending).toHaveLength(1)
    parent.activeObjective = { ...parent.activeObjective!, terminalState: 'complete_verified', completedAt: 5 }

    await expect(h.manager.respondToUserInput(parent.id, {
      requestId: pending[0]!.id,
      answers: [{ questionId: pending[0]!.questions[0]!.id, optionIds: ['retry-delivery'] }],
    })).rejects.toThrow('no longer active')
    expect(pending[0]!.status).toBe('cancelled')
    const failedReceipt = parent.messages.find(message => message.id === 'failed-terminal-receipt')
    expect(failedReceipt).toMatchObject({ agentDelivery: { status: 'failed', attempts: 3 } })
    expect(failedReceipt?.isQueued).toBeUndefined()
    expect(parent.messageQueue).toEqual([])
  })

  it('persists cancellation of an exhausted child-result retry without recreating the same question', async () => {
    const h = harness(); const parent = h.make('cancel-terminal-retry-parent'); const child = h.make('cancel-terminal-retry-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    child.pendingTurnRecovery = undefined
    const deliveryId = policyDelegatedTerminalResultDeliveryId(parent, child)!
    const receipt: Managed['messages'][number] = {
      id: 'cancel-failed-terminal-receipt', role: 'user',
      content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 4,
      hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: child.id, deliveryId },
      agentDelivery: { id: deliveryId, status: 'failed', attempts: 3 },
    }
    parent.messages.push(receipt)
    let providerDispatches = 0
    h.runtime.processNextQueuedMessage = () => { providerDispatches++ }

    expect(await h.runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(true)
    const question = parent.userInputRequests?.find((request) => request.status === 'pending')
    expect(question?.questions[0]?.id).toBe(`retry-child-result-${child.id}`.slice(0, 80))

    await expect(h.manager.respondToUserInput(parent.id, {
      requestId: question!.id,
      cancelled: true,
    })).resolves.toEqual({ status: 'cancelled' })
    await tick(); await tick()

    expect(question!.status).toBe('cancelled')
    expect(receipt).toMatchObject({ isQueued: false, agentDelivery: { status: 'processed', attempts: 3 } })
    expect(parent.activeObjective).toMatchObject({ terminalState: 'exhausted', completedAt: expect.any(Number) })
    expect(parent.pendingTurnRecovery).toBeUndefined()
    expect(parent.userInputRequests?.filter((request) => request.status === 'pending')).toEqual([])
    expect(parent.messageQueue).toEqual([])
    expect(providerDispatches).toBe(0)
    expect(sessionRuntimeStateForTest(h.runtime).delegatedTerminalResultRetryTimers.has(child.id)).toBe(false)
    expect(await h.runtime.ensureDelegatedTerminalResultDelivery(child)).toBe(false)
    expect(parent.userInputRequests?.filter((request) => request.status === 'pending')).toEqual([])
  })
});
