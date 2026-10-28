import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath, listSessions } from "@craft-agent/shared/sessions/storage";
import { createPendingTurnRecovery, buildCleanRecoveryContinuationPrompt, createCleanRecoveryContinuationHandoff } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('host-validates a durable final after a processing delivery crash without another provider generation', async () => {
    const h = harness(); const managed = h.make('consumed-delivery-valid-final')
    managed.messages.push({
      id: 'processing-delivery', role: 'user', content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 2,
      hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: 'fixture-child', deliveryId: 'delivery-final' },
      agentDelivery: { id: 'delivery-final', status: 'processing', attempts: 1 },
    }, {
      id: 'verified-observation', role: 'tool', content: '', timestamp: 2.5,
      toolName: 'Read', toolUseId: 'verified-observation-use', toolInput: { file_path: '/fixture/result.json' },
      toolStatus: 'completed', toolExecuted: true, toolResult: '{"delivered":true}',
    }, {
      id: 'verified-final', role: 'assistant', content: 'The requested result is delivered.', timestamp: 3,
      isIntermediate: false,
      objectiveOutcome: {
        state: 'complete_verified', blocker: null, remainingWork: [],
        criteria: [{ id: 'requested-outcome-delivered', satisfied: true, evidence: ['verified-observation-use'] }],
      },
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let providerPreparations = 0
    cold.runtime.processNextQueuedMessage = () => {}
    cold.runtime.scheduleDeferredAutomaticSessions = () => {}
    cold.runtime.getOrCreateAgent = async () => { providerPreparations++; throw new Error('provider must not run') }
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id)
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(restored.messages.find((message) => message.id === 'processing-delivery'))
      .toMatchObject({ isQueued: false, agentDelivery: { status: 'processed' } })
    expect(restored.activeObjective?.terminalState).toBe('complete_verified')
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(providerPreparations).toBe(0)
  })

  it('consumes a processing delivery without recovery when the host objective was already terminal', async () => {
    const h = harness(); const managed = h.make('consumed-delivery-terminal-objective')
    managed.activeObjective = { ...managed.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    managed.pendingTurnRecovery = undefined
    managed.messages.push({
      id: 'processing-delivery', role: 'user', content: '[host-delegated-terminal-result-v1]\n{}\n\nChild result.', timestamp: 2,
      hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: 'fixture-child', deliveryId: 'delivery-terminal' },
      agentDelivery: { id: 'delivery-terminal', status: 'processing', attempts: 1 },
    }, { id: 'terminal-final', role: 'assistant', content: 'Already complete.', timestamp: 3, isIntermediate: false })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let providerPreparations = 0; let rawDispatches = 0
    cold.runtime.processNextQueuedMessage = () => { rawDispatches++ }
    cold.runtime.getOrCreateAgent = async () => { providerPreparations++; throw new Error('provider must not run') }
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id)
    await tick()

    expect(restored.messages.find((message) => message.id === 'processing-delivery'))
      .toMatchObject({ isQueued: false, agentDelivery: { status: 'processed' } })
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.messageQueue).toEqual([])
    expect(providerPreparations).toBe(0)
    expect(rawDispatches).toBe(0)
  })

  it('requeues the same clean-continuation allocation when fresh runtime setup fails and preserves its durable boundary', async () => {
    const h = harness(); const managed = h.make('clean-continuation-setup-failure')
    const remainingWork = ['Verify the bounded final state and report it.']
    managed.messages.push({ id: 'discarded-history-sentinel', role: 'assistant', content: 'OLD_HISTORY_MUST_NOT_RETURN', timestamp: 2 })
    managed.activeObjective = {
      ...managed.activeObjective!,
      lastOutcome: {
        state: 'continue', blocker: null, remainingWork,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
      },
    }
    const allocatedAt = Date.now()
    const dispatchId = 'clean-continuation-dispatch'
    const pending = {
      ...createPendingTurnRecovery(managed.activeObjective.userMessageId, allocatedAt - 1_000),
      attempts: 1,
      cleanContinuationCount: 1,
      lastCause: 'objective_continue' as const,
      continuationOrigin: 'objective_continue' as const,
      continuationWork: remainingWork,
    }
    const handoff = createCleanRecoveryContinuationHandoff({
      objective: managed.activeObjective,
      pending,
      objectiveText: managed.activeObjective.originalText,
      evidence: [],
      remainingWork,
    })!
    const prompt = buildCleanRecoveryContinuationPrompt(handoff)!
    managed.pendingTurnRecovery = {
      ...pending,
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 1, cause: 'objective_continue', origin: 'automatic',
        allocatedAt, phase: 'allocated', cleanContinuationId: handoff.id,
      },
      cleanContextBoundaryMessageId: dispatchId,
    }
    managed.tokenUsage = {
      inputTokens: 120_000, outputTokens: 1_000, totalTokens: 121_000, contextTokens: 120_000, costUsd: 2,
    }
    managed.sdkSessionId = 'discarded-provider-session'
    managed.branchFromSdkSessionId = 'discarded-provider-parent'
    managed.branchFromSessionPath = '/fixture/discarded-provider-session'
    managed.branchFromSdkCwd = '/fixture/discarded-provider-cwd'
    managed.branchFromSdkTurnId = 'discarded-provider-turn'
    managed.branchContextStrategy = 'sdk-fork'
    managed.branchSeedApplied = false
    managed.providerContextBoundaryMessageId = managed.activeObjective.userMessageId
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 2_000,
      contextTokensBefore: 120_000,
      outcome: 'succeeded',
      objectiveRootId: managed.activeObjective.userMessageId,
      providerContextBaselineTokens: 120_000,
    }
    const originalFlush = h.manager.flushSession.bind(h.manager)
    let firstStartedSnapshot: ReturnType<typeof parseRecoveryJournalObservation> | undefined
    h.manager.flushSession = async id => {
      await originalFlush(id)
      if (!firstStartedSnapshot
        && managed.pendingTurnRecovery?.recoveryDispatch?.phase === 'started'
        && managed.messages.some(candidate => candidate.id === dispatchId)) {
        firstStartedSnapshot = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
          .trim().split('\n').map(parseRecoveryJournalObservation)[0]
      }
    }
    let contextAtFreshRuntime: number | undefined
    h.runtime.getOrCreateAgent = async () => {
      contextAtFreshRuntime = managed.tokenUsage?.contextTokens
      throw new Error('Synthetic clean runtime setup failure')
    }
    h.runtime.processNextQueuedMessage = () => {}
    h.runtime.scheduleDeferredAutomaticSessions = () => {}

    await h.manager.sendMessage(managed.id, prompt, undefined, undefined, {
      hidden: true,
      automaticRecovery: {
        originalUserMessageId: pending.userMessageId,
        cause: 'objective_continue',
        dispatchId,
        dispatchAttempt: 1,
        dispatchOrigin: 'automatic',
        dispatchAllocatedAt: allocatedAt,
      },
    })

    expect(contextAtFreshRuntime).toBe(Math.max(1, Math.ceil(prompt.length / 4)))
    expect<unknown>(firstStartedSnapshot).toMatchObject({
      providerContextBoundaryMessageId: dispatchId,
      tokenUsage: (expect.objectContaining({
        contextTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      }) as unknown),
      pendingTurnRecovery: (expect.objectContaining({
        recoveryDispatch: (expect.objectContaining({ id: dispatchId, phase: 'started' }) as unknown),
      }) as unknown),
    })
    expect(requiredTestValue(firstStartedSnapshot).sdkSessionId).toBeUndefined()
    expect(requiredTestValue(firstStartedSnapshot)).not.toHaveProperty('branchFromSdkSessionId')
    expect(requiredTestValue(firstStartedSnapshot)).not.toHaveProperty('branchFromSessionPath')
    expect(requiredTestValue(firstStartedSnapshot)).not.toHaveProperty('branchFromSdkCwd')
    expect(requiredTestValue(firstStartedSnapshot)).not.toHaveProperty('branchFromSdkTurnId')
    expect(requiredTestValue(firstStartedSnapshot)).not.toHaveProperty('branchContextStrategy')
    expect(requiredTestValue(firstStartedSnapshot).contextCompactionAttempt).toBeUndefined()
    expect(managed.branchSeedApplied).toBe(true)
    expect(managed.providerContextBoundaryMessageId).toBe(dispatchId)
    expect(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
      id: dispatchId, phase: 'allocated', cleanContinuationId: handoff.id,
    })
    // The provider never existed, so its transient hidden boundary must not be
    // retained as transcript history. The same durable allocation is rebuilt
    // from host-owned objective state instead.
    expect(managed.messages.find(message => message.id === dispatchId)).toBeUndefined()
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.messageId).toBeUndefined()
    expect(managed.messageQueue[0]).toMatchObject({
      message: prompt,
      options: {
        hidden: true,
        automaticRecovery: {
          dispatchId,
          cleanContinuationId: handoff.id,
        },
      },
    })

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id)
    expect(restored.providerContextBoundaryMessageId).toBe(dispatchId)
    expect(restored.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
      id: dispatchId, phase: 'allocated', cleanContinuationId: handoff.id,
    })
    expect(restored.messages.find((message: { id: string }) => message.id === dispatchId)).toBeUndefined()
    // FIFO rows without a transcript id are intentionally transient. Cold
    // hydration retains the absolute setup deadline and reconstructs the exact
    // allocation only when that deadline becomes eligible.
    expect(restored.messageQueue).toEqual([])
    expect(restored.pendingTurnRecovery?.recoveryDispatch?.setupRetryNotBefore)
      .toBeGreaterThan(Date.now())
    expect(restored.messages.find((message) => message.id === 'discarded-history-sentinel')?.content)
      .toBe('OLD_HISTORY_MUST_NOT_RETURN')
  })

  it('keeps a parent open for child auth and retains restart authority when auth continuation preparation fails', async () => {
    const h = harness(); const parent = h.make('auth-parent'); const child = h.make('auth-delegated-child', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id,
      rootObjectiveId: parentObjectiveId,
      parentObjectiveId,
      depth: 1,
      role: 'worker',
    }
    child.pendingAuthRequestId = 'child-auth'
    child.pendingAuthRequest = {
      type: 'oauth', requestId: 'child-auth', sessionId: child.id,
      sourceSlug: 'fixture', sourceName: 'Fixture',
    }
    child.messages.push({
      id: 'child-auth-message', role: 'auth-request', content: 'Authenticate Fixture', timestamp: 2,
      authRequestId: 'child-auth', authRequestType: 'oauth', authSourceSlug: 'fixture',
      authSourceName: 'Fixture', authStatus: 'pending',
    })
    expect(h.runtime.activeRelevantDelegatedDescendants(parent).map((session: Managed) => session.id))
      .toEqual([child.id])
    expect(await h.runtime.deferTerminalOutcomeForActiveDelegations(parent)).toBe(true)
    expect(parent.activeObjective?.terminalState).toBe('active')

    h.runtime.scheduleDeferredAutomaticSessions = () => {}
    h.runtime.sendAuthenticatedInternalContinuation = async () => {
      throw new Error('transient auth continuation preparation failure')
    }
    await expect(h.manager.completeAuthRequest(child.id, {
      requestId: 'child-auth', sourceSlug: 'fixture', success: false, cancelled: true,
    } as never)).rejects.toThrow('transient auth continuation preparation failure')
    expect(child.pendingAuthRequestId).toBeUndefined()
    expect(child.pendingTurnRecovery).toBeDefined()
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.has(child.id)).toBe(true)
    expect(h.runtime.activeRelevantDelegatedDescendants(parent).map((session: Managed) => session.id))
      .toEqual([child.id])
    expect(listSessions(h.rootPath).find(meta => meta.id === child.id)?.pendingTurnRecovery).toBeDefined()
  })
});
