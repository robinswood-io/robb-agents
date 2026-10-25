import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { createPendingTurnRecovery, buildCleanRecoveryContinuationPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, deferred, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('automatic channel-fallback kill switch recovery boundaries', () => {
  it('autonomously continues at hard context limit with oversized objective, >16 amendments, and cleanContinuationCount >= 4 without asking context-limit questions', async () => {
    const h = harness(); const managed = h.make('autonomous-hard-limit-unbounded-handoff')
    const rootId = `${managed.id}-user`
    const dispatchId = 'autonomous-hard-limit-dispatch-5'
    const allocatedAt = Date.now() - 2_000
    const longObjective = `Complete the full multi-dossier audit and verification. ${'Dossier detail '.repeat(1_200)}`
    expect(longObjective.length).toBeGreaterThan(16_000)
    managed.messages[0]!.content = longObjective
    const amendments = Array.from({ length: 20 }, (_, index) => ({
      messageId: `amendment-${index + 1}`,
      text: `Amendment ${index + 1}: ${'preserve verified constraint '.repeat(160)}`,
      timestamp: index + 2,
    }))
    managed.activeObjective = {
      ...managed.activeObjective!,
      originalText: longObjective,
      amendments,
      lastOutcome: {
        state: 'continue',
        blocker: null,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
        remainingWork: ['Finish verifying the remaining accounting folders idempotently.'],
      },
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1),
      attempts: 1,
      cleanContinuationCount: 5,
      lastAttemptAt: allocatedAt,
      lastCause: 'objective_continue',
      continuationOrigin: 'objective_continue',
      continuationWork: ['Finish verifying the remaining accounting folders idempotently.'],
      recoveryDispatch: {
        schemaVersion: 1,
        id: dispatchId,
        attempt: 2,
        cause: 'objective_continue',
        origin: 'automatic',
        allocatedAt,
        phase: 'allocated',
      },
    }
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 500,
      contextTokensBefore: 140_000,
      outcome: 'succeeded',
      objectiveRootId: rootId,
      providerContextBaselineTokens: 125_000,
      hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
    }
    managed.tokenUsage = {
      inputTokens: 140_000,
      outputTokens: 2_000,
      totalTokens: 142_000,
      contextTokens: 125_000,
      contextWindow: 200_000,
      costUsd: 1,
    }
    managed.sdkSessionId = 'oversized-provider-session-5'

    const freshRuntimeEntered = deferred()
    const releaseFreshRuntime = deferred()
    let providerBuilds = 0
    const oversizedRuntime = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model',
      getSessionId: () => 'oversized-provider-session-5',
      setAllSources: () => {},
      isProcessing: () => false,
      forceAbort: () => {},
      dispose: () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        throw new Error('Oversized provider session must not be reused')
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      providerBuilds++
      if (providerBuilds === 1) {
        managed.agent = oversizedRuntime as never
        return oversizedRuntime
      }
      freshRuntimeEntered.resolve()
      await releaseFreshRuntime.promise
      throw new Error('Synthetic clean provider boundary reached')
    }

    const prompt = h.runtime.buildRecoveryDispatchMessage(
      managed,
      managed.pendingTurnRecovery,
      requiredTestValue(managed.pendingTurnRecovery.recoveryDispatch),
    )
    const queuedItem = {
      message: prompt,
      messageId: dispatchId,
      options: {
        hidden: true,
        automaticRecovery: {
          originalUserMessageId: rootId,
          cause: 'objective_continue' as const,
          dispatchId,
          dispatchAttempt: 2,
          dispatchOrigin: 'automatic' as const,
          dispatchAllocatedAt: allocatedAt,
        },
      },
    }
    const dispatchToken = Symbol('autonomous-hard-limit-dequeue')
    sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.set(managed.id, dispatchToken)
    const dispatchPromise = h.manager.sendMessage(
      managed.id,
      prompt,
      undefined,
      undefined,
      queuedItem.options,
      undefined,
      false,
      undefined,
      undefined,
      dispatchToken,
      queuedItem,
    )
    try {
      await freshRuntimeEntered.promise
      expect(providerBuilds).toBe(2)
      expect(managed.sdkSessionId).toBeUndefined()
      expect(managed.providerContextBoundaryMessageId).toBe(dispatchId)
      expect(managed.pendingTurnRecovery?.cleanContinuationCount).toBe(6)
      expect(managed.pendingTurnRecovery?.recoveryDispatch?.cleanContinuationId)
        .toMatch(/^clean-continuation-v1-/)
      expect(managed.userInputRequests ?? []).toEqual([])
    } finally {
      releaseFreshRuntime.resolve()
      await dispatchPromise.catch(() => {})
    }
  })

  it('resets the provider boundary autonomously on oversized direct user messages (>16k chars) at the hard context limit', async () => {
    const h = harness(); const managed = h.make('oversized-direct-message-20k')
    const rootId = `${managed.id}-user`
    managed.contextCompactionAttempt = {
      attemptedAt: Date.now() - 1_000,
      contextTokensBefore: 130_000,
      outcome: 'failed',
      objectiveRootId: rootId,
      hardLimitTokens: 100_000,
      issueCode: 'backend-error',
    }
    managed.tokenUsage = {
      inputTokens: 130_000,
      outputTokens: 1_000,
      totalTokens: 131_000,
      contextTokens: 130_000,
      contextWindow: 200_000,
      costUsd: 1,
    }
    managed.sdkSessionId = 'oversized-direct-sdk-session'

    const freshRuntimeEntered = deferred()
    const releaseFreshRuntime = deferred()
    let agentCallCount = 0
    h.runtime.getOrCreateAgent = async () => {
      agentCallCount++
      if (agentCallCount === 1) {
        return completeSessionAgentFixture(h.workspace, {
          sendMessage: async () => {},
          dispose: async () => {},
        })
      }
      freshRuntimeEntered.resolve()
      await releaseFreshRuntime.promise
      throw new Error('Synthetic fresh direct boundary')
    }

    const hugeUserMessage = `Voici le journal complet à analyser :\n${'Ligne de log détaillée '.repeat(800)}`
    expect(hugeUserMessage.length).toBeGreaterThan(16_000)
    const dispatchPromise = h.manager.sendMessage(managed.id, hugeUserMessage)
    try {
      await freshRuntimeEntered.promise
      expect(managed.sdkSessionId).toBeUndefined()
      expect(managed.userInputRequests ?? []).toEqual([])
    } finally {
      releaseFreshRuntime.resolve()
      await dispatchPromise.catch(() => {})
    }
  })

  it('projects subagent agent-message turns back to the visible objective root for clean context-limit handoffs', () => {
    const h = harness(); const managed = h.make('subagent-result-context-limit-handoff')
    const subagentDeliveryId = `${managed.id}-subagent-result`
    managed.messages.push({
      id: subagentDeliveryId,
      role: 'user',
      hidden: true,
      timestamp: Date.now(),
      content: 'Subagent verification complete.',
      internalOrigin: {
        kind: 'agent-message',
        senderSessionId: 'subagent-1',
        deliveryId: 'delivery-1',
        agentMessageType: 'result',
      },
    })
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(subagentDeliveryId),
      attempts: 1,
      lastCause: 'objective_continue',
      continuationWork: ['Integrate subagent findings and complete final verification'],
      continuationOrigin: 'objective_continue',
    }

    const handoff = h.runtime.createAutonomousContextLimitHandoff(managed, managed.pendingTurnRecovery)
    expect(handoff).toBeDefined()
    const prompt = handoff ? buildCleanRecoveryContinuationPrompt(handoff) : undefined
    expect(prompt).toContain('<host_clean_recovery_continuation')
    expect(prompt).toContain('Integrate subagent findings and complete final verification')
  })

  it('detaches the provider boundary and continues autonomously in enqueueAutomaticTurnRecovery even when structured handoff is unavailable', async () => {
    const h = harness(); const managed = h.make('enqueue-clean-boundary-fallback')
    h.runtime.processNextQueuedMessage = () => {}
    managed.sdkSessionId = 'stale-provider-session'
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(`${managed.id}-user`),
      attempts: 1,
      lastCause: 'objective_continue',
      continuationWork: ['Verify remaining objective steps'],
      continuationOrigin: 'objective_continue',
    }
    const originalCreateHandoff = h.runtime.createAutonomousContextLimitHandoff.bind(h.runtime)
    h.runtime.createAutonomousContextLimitHandoff = () => undefined
    try {
      const queued = await h.runtime.enqueueAutomaticTurnRecovery(
        managed,
        'objective_continue',
        [],
        ['Verify remaining objective steps'],
        undefined,
        undefined,
        true,
      )
      expect(queued).toBe(true)
      expect(managed.sdkSessionId).toBeUndefined()
      expect(managed.providerContextBoundaryMessageId).toBe(managed.pendingTurnRecovery?.recoveryDispatch?.id)
      expect(managed.pendingTurnRecovery?.cleanContextBoundaryMessageId)
        .toBe(managed.pendingTurnRecovery?.recoveryDispatch?.id)
      expect(managed.userInputRequests ?? []).toEqual([])
      expect(managed.messageQueue).toHaveLength(1)
    } finally {
      h.runtime.createAutonomousContextLimitHandoff = originalCreateHandoff
    }
  })
});
