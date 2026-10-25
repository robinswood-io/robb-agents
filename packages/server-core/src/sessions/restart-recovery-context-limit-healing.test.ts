import { completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createPendingTurnRecovery, buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('allows direct user follow-up turn when oversized context has reached hard limit and cancels pending context-limit question', async () => {
    const h = harness(); const managed = h.make('oversized-direct-user-turn')
    const rootId = `${managed.id}-user`
    const dispatchId = 'oversized-dispatch'
    const allocatedAt = Date.now() - 2_000
    const startedAt = allocatedAt + 500
    const questions = [{
      id: 'context-limit-next-step',
      question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
      options: [{
        id: 'provide-guidance', label: 'Préciser la reprise',
        description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.',
        recommended: true,
      }, {
        id: 'stop-objective', label: 'Arrêter cette mission',
        description: 'Conserver les résultats actuels sans nouvel appel fournisseur.',
      }],
    }]
    managed.messages[0]!.content = 'Complete the preserved objective and verify the exact target state.'
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'],
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1), attempts: 2, stagnantAttempts: 0,
      lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete',
      validationExhausted: true, validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 3,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
    managed.messages.push({
      id: dispatchId, role: 'user', hidden: true, timestamp: startedAt + 1,
      content: buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery, 'objective_incomplete', undefined, 3, managed.activeObjective,
      ),
    })
    managed.tokenUsage = {
      inputTokens: 120_000, outputTokens: 1_000, totalTokens: 121_000,
      contextTokens: 120_000, contextWindow: 200_000, costUsd: 2,
    }
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000, contextTokensBefore: 120_000,
      outcome: 'failed', objectiveRootId: rootId,
      hardLimitTokens: 100_000, issueCode: 'backend-error',
    }
    const created = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
    )
    expect(managed.userInputRequests?.some(r => r.status === 'pending')).toBe(true)

    const freshRuntimeEntered = deferred(); const releaseFreshRuntime = deferred()
    let dispatch: Promise<void> | undefined
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
      throw new Error('Synthetic fresh-context provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

    try {
      void h.manager.sendMessage(managed.id, "Normalement c'est résolu")
      await freshRuntimeEntered.promise
      expect(managed.userInputRequests?.find(r => r.id === created.requestId)?.status).toBe('cancelled')
      expect(managed.tokenUsage?.contextTokens).toBeLessThan(100_000)
    } finally {
      releaseFreshRuntime.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('auto-heals a persisted host context-limit question into the same clean attempt after restart', async () => {
    const h = harness(); const managed = h.make('cold-context-question-auto-heal')
    const rootId = `${managed.id}-user`
    const dispatchId = 'cold-context-question-dispatch'
    const allocatedAt = Date.now() - 2_000
    const startedAt = allocatedAt + 500
    const questions = [{
      id: 'context-limit-next-step',
      question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
      options: [{
        id: 'provide-guidance', label: 'Préciser la reprise',
        description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.',
        recommended: true,
      }, {
        id: 'stop-objective', label: 'Arrêter cette mission',
        description: 'Conserver les résultats actuels sans nouvel appel fournisseur.',
      }],
    }]
    managed.messages[0]!.content = 'Complete the preserved objective and verify the exact target state.'
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'],
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1), attempts: 2, stagnantAttempts: 0,
      lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete',
      validationExhausted: true, validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 3,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
    managed.messages.push({
      id: dispatchId, role: 'user', hidden: true, timestamp: startedAt + 1,
      content: buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery, 'objective_incomplete', undefined, 3, managed.activeObjective,
      ),
    })
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000, contextTokensBefore: 130_000,
      outcome: 'succeeded', objectiveRootId: rootId,
      providerContextBaselineTokens: 120_000, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
    }
    managed.tokenUsage = {
      inputTokens: 120_000, outputTokens: 1_000, totalTokens: 121_000,
      contextTokens: 120_000, contextWindow: 200_000, costUsd: 2,
    }
    managed.sdkSessionId = 'legacy-oversized-provider-session'
    managed.branchFromSdkSessionId = 'legacy-branch-session'
    managed.branchFromSessionPath = '/tmp/legacy-session.jsonl'
    managed.branchFromSdkCwd = '/tmp/legacy-cwd'
    managed.branchFromSdkTurnId = 'legacy-turn'
    managed.branchContextStrategy = 'seeded-fresh-session'
    managed.transferredSessionSummary = 'stale provider summary'
    managed.transferredSessionSummaryApplied = false
    const request = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
    )

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(restored.userInputRequests).toEqual([expect.objectContaining({
      id: request.requestId, status: 'cancelled',
    })])
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      recoveryDispatch: {
        id: dispatchId, attempt: 3, phase: 'allocated',
        cause: 'objective_incomplete', origin: 'automatic',
        cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
      },
      cleanContextBoundaryMessageId: dispatchId,
    })
    expect(restored.messageQueue).toHaveLength(1)
    expect(restored.messageQueue[0]?.message).toContain('<host_clean_recovery_continuation')
    expect(restored.messageQueue[0]?.message).toContain(managed.messages[0]!.content)
    expect(restored.messages.some((message: { id: string }) => message.id === dispatchId)).toBe(false)
    expect(restored.sdkSessionId).toBeUndefined()
    expect(restored.branchFromSdkSessionId).toBeUndefined()
    expect(restored.branchFromSessionPath).toBeUndefined()
    expect(restored.branchFromSdkCwd).toBeUndefined()
    expect(restored.branchFromSdkTurnId).toBeUndefined()
    expect(restored.transferredSessionSummary).toBeUndefined()
    expect(restored.providerContextBoundaryMessageId).toBe(dispatchId)
    const header = JSON.parse(
      readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!,
    )
    expect(header.userInputRequests).toEqual([expect.objectContaining({
      id: request.requestId, status: 'cancelled',
    })])
    expect(header.pendingTurnRecovery.recoveryDispatch).toMatchObject({
      id: dispatchId, phase: 'allocated',
      cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
    })
    expect(header.sdkSessionId).toBeUndefined()
    expect(header.branchFromSdkSessionId).toBeUndefined()
    expect(header.providerContextBoundaryMessageId).toBe(dispatchId)
  })

  it('continues a host context-limit question after observed provider work without replaying that dispatch', async () => {
    const h = harness(); const managed = h.make('observed-context-question')
    const rootId = `${managed.id}-user`
    const dispatchId = 'observed-context-dispatch-2'
    const visibleRevisionId = 'observed-context-follow-up'
    const allocatedAt = Date.now() - 3_000
    const startedAt = allocatedAt + 500
    const questions = [{ id: 'context-limit-next-step',
      question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
      options: [{ id: 'provide-guidance', label: 'Préciser la reprise',
        description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.', recommended: true },
      { id: 'stop-objective', label: 'Arrêter cette mission',
        description: 'Conserver les résultats actuels sans nouvel appel fournisseur.' }],
    }]
    managed.messages[0]!.content = 'Complete the current target and verify the result.'
    managed.messages.push({ id: visibleRevisionId, role: 'user',
      timestamp: allocatedAt - 1_000, content: 'Continue the same objective.' })
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      lastUserMessageId: visibleRevisionId,
      lastOutcome: { state: 'continue', blocker: null,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
        remainingWork: ['Inspect the current target and complete its remaining work.'] },
    }
    const retainedDelivery: Managed['messages'][number] = {
      id: 'retained-child-result', role: 'user', content: 'Queued child result.',
      timestamp: allocatedAt - 400, hidden: true, isQueued: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child',
        deliveryId: 'retained-delivery' },
      agentDelivery: { id: 'retained-delivery', status: 'queued', attempts: 0 },
    }
    managed.messages.push(retainedDelivery)
    managed.messageQueue.push({ messageId: retainedDelivery.id,
      message: retainedDelivery.content,
      options: { hidden: true, internalOrigin: retainedDelivery.internalOrigin } })
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(visibleRevisionId, 1), attempts: 2, stagnantAttempts: 0,
      recoveryStrategy: { schemaVersion: 1, phase: 'replan', attemptBaseline: 1,
        transitionCount: 1, transitionedAt: allocatedAt - 100, reason: 'stagnation' },
      lastCause: 'objective_continue', continuationOrigin: 'objective_continue',
      continuationWork: managed.activeObjective.lastOutcome!.remainingWork,
      lastAttemptAt: allocatedAt,
      recoveryDispatch: { schemaVersion: 1, id: dispatchId, attempt: 2,
        cause: 'objective_continue', origin: 'automatic', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1 },
    }
    managed.messages.push({ id: dispatchId, role: 'user', hidden: true,
      timestamp: startedAt, content: buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery, 'objective_continue', undefined, 2, managed.activeObjective,
      ) })
    managed.messages.push({ id: 'observed-tool-result', role: 'tool',
      timestamp: startedAt + 100, content: 'Observed prior tool result',
      toolName: 'Read', toolUseId: 'observed-tool-call', toolStatus: 'completed', toolExecuted: true })
    managed.contextCompactionAttempt = { attemptedAt: startedAt + 200,
      contextTokensBefore: 130_000, outcome: 'succeeded', objectiveRootId: rootId,
      providerContextBaselineTokens: 120_000, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true }
    managed.tokenUsage = { inputTokens: 120_000, outputTokens: 1_000,
      totalTokens: 121_000, contextTokens: 120_000, contextWindow: 200_000, costUsd: 2 }
    managed.sdkSessionId = 'consumed-provider-context'
    const request = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
    )
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.add(restored.id)
    await cold.runtime.drainDeferredAutomaticSessions()

    expect(restored.userInputRequests).toEqual([expect.objectContaining({
      id: request.requestId, status: 'cancelled',
    })])
    expect(restored.pendingTurnRecovery?.attempts).toBe(3)
    expect(restored.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
      attempt: 3, phase: 'allocated', cause: 'objective_continue',
      cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
    })
    expect(restored.pendingTurnRecovery?.recoveryDispatch?.id).not.toBe(dispatchId)
    expect(restored.messages.some((message: { id: string }) => message.id === dispatchId)).toBe(true)
    expect(restored.messages.some((message: { id: string }) => message.id === 'observed-tool-result')).toBe(true)
    expect(restored.messageQueue).toHaveLength(2)
    expect(restored.messageQueue[1]?.messageId).toBe(retainedDelivery.id)
    expect(restored.messages.find((message: { id: string }) => message.id === retainedDelivery.id))
      .toMatchObject({ isQueued: true, agentDelivery: { status: 'queued' } })
    expect(restored.messageQueue[0]?.message).toContain('<host_clean_recovery_continuation')
    expect(restored.messageQueue[0]?.message).not.toContain('Observed prior tool result')
    expect(restored.sdkSessionId).toBeUndefined()
    expect(restored.tokenUsage?.contextTokens).toBeLessThan(100_000)
    const successorId = restored.pendingTurnRecovery?.recoveryDispatch?.id
    const second = h.cold(); const again = requiredTestValue(sessionRuntimeStateForTest(second.runtime).sessions.get(managed.id))
    second.runtime.processNextQueuedMessage = () => {}
    await second.runtime.resumePendingTurnAfterRestart(again.id)
    expect(again.pendingTurnRecovery?.recoveryDispatch?.id).toBe(successorId)
    expect(again.pendingTurnRecovery?.attempts).toBe(3)
  })

  it('opens a clean hard-limit Retry after an authenticated source activation', async () => {
    const h = harness(); const managed = h.make('source-activation-hard-limit-retry')
    const rootId = `${managed.id}-user`
    const activationId = 'current-atria-source-activation'
    const objectiveText = 'Check the Atria billing migration and report the verified next steps.'
    managed.messages[0]!.content = objectiveText
    managed.activeObjective = { ...managed.activeObjective!, originalText: objectiveText }
    managed.messages.push({
      id: activationId, role: 'user', hidden: true, timestamp: 2,
      content: `${objectiveText}\n\n[atria activated]`,
      internalOrigin: {
        kind: 'source-activation', objectiveId: rootId, objectiveRevision: rootId,
        sourceSlug: 'atria', sourceActivationId: 'activation-1',
      },
    })
    managed.pendingTurnRecovery = createPendingTurnRecovery(activationId)
    const activation = managed.messages[1]!
    const authenticatedOrigin = activation.internalOrigin
    activation.internalOrigin = {
      kind: 'source-activation', objectiveId: rootId, objectiveRevision: 'other-revision',
      sourceSlug: 'atria', sourceActivationId: 'activation-1',
    }
    expect(h.runtime.createAutonomousContextLimitHandoff(
      managed, managed.pendingTurnRecovery,
    )).toBeUndefined()
    activation.internalOrigin = authenticatedOrigin
    managed.tokenUsage = {
      inputTokens: 105_857, outputTokens: 0, totalTokens: 0,
      contextTokens: 105_857, contextWindow: 200_000, costUsd: 0,
    }
    managed.sdkSessionId = 'oversized-source-activation-context'

    const entered = deferred(); const release = deferred()
    let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      expect(managed.sdkSessionId).toBeUndefined()
      entered.resolve()
      await release.promise
      throw new Error('Synthetic clean source-activation provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

    try {
      expect(await h.manager.retryTurn(managed.id, rootId)).toEqual({ status: 'started' })
      await entered.promise
      expect(managed.messages[0]!.content).toBe(objectiveText)
      expect(managed.userInputRequests?.filter(request => request.status === 'pending') ?? []).toEqual([])
      expect(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        cause: 'user_retry', origin: 'retry', phase: 'started',
        cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
      })
      const boundaryId = managed.pendingTurnRecovery!.recoveryDispatch!.id
      expect(managed.messages.find(message => message.id === boundaryId)?.content)
        .toContain('<host_clean_recovery_continuation')
      expect(managed.providerContextBoundaryMessageId).toBe(boundaryId)
    } finally {
      release.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('auto-heals an exact hard-limit question after SDK compaction was not needed', async () => {
    const h = harness(); const managed = h.make('skipped-compaction-context-question')
    const rootId = `${managed.id}-user`
    const allocatedAt = Date.now() - 2_000
    const dispatchId = 'skipped-compaction-retry-dispatch'
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId),
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 1, cause: 'user_retry',
        origin: 'retry', allocatedAt, phase: 'allocated',
        preToolExecutionReceiptVersion: 1,
      },
    }
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000, contextTokensBefore: 105_857,
      outcome: 'skipped-not-needed', issueCode: 'not-needed',
      objectiveRootId: rootId, hardLimitTokens: 100_000,
    }
    managed.tokenUsage = {
      inputTokens: 105_857, outputTokens: 0, totalTokens: 0,
      contextTokens: 105_857, costUsd: 0,
    }
    const questions = [{
      id: 'context-limit-next-step',
      question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
      options: [{
        id: 'provide-guidance', label: 'Préciser la reprise',
        description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.',
        recommended: true,
      }, {
        id: 'stop-objective', label: 'Arrêter cette mission',
        description: 'Conserver les résultats actuels sans nouvel appel fournisseur.',
      }],
    }]
    const request = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
    )
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const entered = deferred(); const release = deferred()
    cold.runtime.getOrCreateAgent = async () => {
      entered.resolve()
      await release.promise
      throw new Error('Synthetic skipped-compaction fresh provider boundary')
    }
    try {
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      await entered.promise
      expect(restored.userInputRequests).toEqual([expect.objectContaining({
        id: request.requestId, status: 'cancelled',
      })])
      expect(restored.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        id: dispatchId, phase: 'started',
        cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
      })
      expect(restored.messages.find((message: Managed['messages'][number]) => message.id === dispatchId)?.content)
        .toContain('<host_clean_recovery_continuation')
      expect(restored.messages[0]!.content).toBe('Explain the existing result.')
    } finally {
      release.resolve()
    }
  })
});
