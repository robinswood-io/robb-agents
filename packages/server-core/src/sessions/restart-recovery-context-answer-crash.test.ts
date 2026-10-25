import type { SessionHeader } from "@craft-agent/shared/sessions";
import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createPendingTurnRecovery, buildAutomaticTurnRecoveryPrompt, createCleanRecoveryContinuationHandoff } from "./turn-recovery";
import { cleanupRestartRecovery, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('bounds a context-limit answer when the first runtime setup fails before provider handoff', async () => {
    const h = harness(); const managed = h.make('context-guidance-first-setup-failure')
    const rootId = `${managed.id}-user`
    const oldDispatchId = 'context-guidance-first-setup-old-dispatch'
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
    managed.messages[0]!.content = 'Complete and verify the existing target without restarting the mission.'
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      requiresAcceptanceCriteria: true, acceptanceRegisteredRevision: rootId,
      acceptanceRegisteredAt: 2,
      acceptanceCriteria: [{
        id: 'target-verified', description: 'The existing target is complete and verified.',
        toolName: 'Read', input: { file_path: '/fixture/state.json' },
        checks: [{ path: '$.healthy', equals: true }],
      }],
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1), attempts: 2,
      lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete',
      validationExhausted: true, validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: oldDispatchId, attempt: 3,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
    managed.messages.push({
      id: oldDispatchId, role: 'user', hidden: true, timestamp: startedAt + 1,
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
    managed.sdkSessionId = 'oversized-answer-provider-context'
    const request = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, oldDispatchId,
    )

    let providerBuilds = 0; let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      providerBuilds++
      const error = new Error('Synthetic first answer runtime timeout') as Error & { code: string }
      error.code = 'ETIMEDOUT'
      throw error
    }
    h.runtime.scheduleDeferredAutomaticRetry = () => {}
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

    const accepted = await h.manager.respondToUserInput(managed.id, {
      requestId: request.requestId,
      answers: [{
        questionId: 'context-limit-next-step', optionIds: ['provide-guidance'],
        text: 'Resume the preserved target and verify the exact current state.',
      }],
    })
    await dispatch

    expect(accepted).toMatchObject({ status: 'accepted', delivery: 'started' })
    expect(providerBuilds).toBe(1)
    expect(managed.userInputRequests).toHaveLength(1)
    expect(managed.userInputRequests![0]).toMatchObject({
      id: request.requestId, status: 'answered', responseMessageId: accepted.responseMessageId,
    })
    expect(managed.messages.some(message => message.id === accepted.responseMessageId)).toBe(false)
    expect(managed.pendingTurnRecovery).toMatchObject({
      userMessageId: accepted.responseMessageId,
      recoveryDispatch: {
        id: accepted.responseMessageId, attempt: 4, cause: 'user_retry', origin: 'retry',
        phase: 'allocated', cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
        setupFailureCount: 1, lastSetupFailureClass: 'timeout',
        setupRetryNotBefore: expect.any(Number),
      },
    })
    expect(managed.pendingTurnRecovery?.recoveryDispatch?.setupRetryBlockedAt).toBeUndefined()
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      options: { automaticRecovery: { dispatchId: accepted.responseMessageId } },
    })

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let coldProviderBuilds = 0
    cold.runtime.getOrCreateAgent = async () => {
      coldProviderBuilds++
      throw new Error('Provider must remain behind the durable setup deadline')
    }
    cold.runtime.scheduleDeferredAutomaticRetry = () => {}
    await cold.runtime.ensureMessagesLoaded(restored)
    await tick()
    expect(restored.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
      id: accepted.responseMessageId, phase: 'allocated', setupFailureCount: 1,
    })
    expect(coldProviderBuilds).toBe(0)
    await h.manager.cleanup(); await cold.manager.cleanup()
  })

  it('keeps a future-dated context-limit answer dispatch ordered and resumes it after a crash', async () => {
    const h = harness(); const managed = h.make('future-dated-context-answer')
    const rootId = `${managed.id}-user`
    const oldDispatchId = 'future-context-old-dispatch'
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
    managed.messages[0]!.content = 'Complete and verify the preserved target from a fresh provider context.'
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      requiresAcceptanceCriteria: true, acceptanceRegisteredRevision: rootId,
      acceptanceRegisteredAt: 2,
      acceptanceCriteria: [{
        id: 'target-verified', description: 'The preserved target is complete and verified.',
        toolName: 'Read', input: { file_path: '/fixture/state.json' },
        checks: [{ path: '$.healthy', equals: true }],
      }],
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1), attempts: 0, stagnantAttempts: 0,
      lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete',
      validationExhausted: true, validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: oldDispatchId, attempt: 1,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
    managed.messages.push({
      id: oldDispatchId, role: 'user', hidden: true, timestamp: startedAt + 1,
      content: buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery, 'objective_incomplete', undefined, 1, managed.activeObjective,
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
    managed.sdkSessionId = 'future-answer-oversized-provider-context'
    const request = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, oldDispatchId,
    )

    const futureAnswerTimestamp = Date.now() + 5 * 60_000
    sessionRuntimeStateForTest(h.runtime).lastTimestamp = futureAnswerTimestamp
    const liveFreshRuntimeEntered = deferred(); const releaseLiveFreshRuntime = deferred()
    let liveProviderBuilds = 0; let liveDispatch: Promise<void> | undefined
    const oversizedRuntime = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model', getSessionId: () => 'future-answer-oversized-provider-context',
      setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> { throw new Error('The oversized provider context must not receive the future answer') },
    })
    h.runtime.getOrCreateAgent = async () => {
      liveProviderBuilds++
      if (liveProviderBuilds === 1) {
        managed.agent = oversizedRuntime as never
        return oversizedRuntime
      }
      liveFreshRuntimeEntered.resolve()
      await releaseLiveFreshRuntime.promise
      throw new Error('Synthetic future-answer fresh-context provider boundary')
    }
    const liveSend = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { liveDispatch = liveSend(...args); return liveDispatch }

    let coldDispatch: Promise<void> | undefined
    const releaseColdRuntime = deferred()
    try {
      const accepted = await h.manager.respondToUserInput(managed.id, {
        requestId: request.requestId,
        answers: [{
          questionId: 'context-limit-next-step', optionIds: ['provide-guidance'],
          text: 'Resume the preserved target and complete its remaining verified work.',
        }],
      })
      expect(accepted).toMatchObject({ status: 'accepted', delivery: 'started' })
      await liveFreshRuntimeEntered.promise

      const responseMessage = managed.messages.find(message => message.id === accepted.responseMessageId)!
      expect(responseMessage.timestamp).toBeGreaterThan(Date.now())
      const liveRecoveryDispatch = managed.pendingTurnRecovery!.recoveryDispatch!
      expect(liveRecoveryDispatch).toMatchObject({
        id: responseMessage.id, cause: 'user_retry', origin: 'retry', phase: 'started',
        cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
      })
      expect(liveRecoveryDispatch.allocatedAt).toBe(responseMessage.timestamp)
      expect(liveRecoveryDispatch.startedAt).toBeGreaterThanOrEqual(liveRecoveryDispatch.allocatedAt)
      const liveHeader = JSON.parse(
        readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8').split('\n')[0]!,
      )
      expect(liveHeader.pendingTurnRecovery.recoveryDispatch).toEqual(liveRecoveryDispatch)
      expect(liveHeader.providerContextBoundaryMessageId).toBe(responseMessage.id)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      const coldRuntimeEntered = deferred()
      cold.runtime.getOrCreateAgent = async () => {
        coldRuntimeEntered.resolve()
        await releaseColdRuntime.promise
        throw new Error('Synthetic crash-resume provider boundary')
      }
      const coldSend = cold.manager.sendMessage.bind(cold.manager)
      cold.manager.sendMessage = (...args) => {
        coldDispatch = coldSend(...args)
        return coldDispatch
      }
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      await coldRuntimeEntered.promise

      expect(restored.userInputRequests).toEqual([expect.objectContaining({
        id: request.requestId, status: 'answered', responseMessageId: responseMessage.id,
      })])
      expect(requiredTestValue(restored.userInputRequests).some((candidate) => candidate.status === 'pending')).toBe(false)
      expect(restored.providerContextBoundaryMessageId).toBe(responseMessage.id)
      expect(restored.sdkSessionId).toBeUndefined()
      const resumedDispatch = requiredTestValue(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch)
      expect(resumedDispatch).toMatchObject({
        id: responseMessage.id, cause: 'user_retry', origin: 'retry', phase: 'started',
      })
      expect(resumedDispatch.startedAt).toBeGreaterThanOrEqual(resumedDispatch.allocatedAt)
      const coldHeader: SessionHeader = JSON.parse(
        readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!,
      )
      expect(requiredTestValue(coldHeader.pendingTurnRecovery).recoveryDispatch).toEqual(resumedDispatch)
      expect(requiredTestValue(coldHeader.userInputRequests).some((candidate) => candidate.status === 'pending')).toBe(false)
    } finally {
      releaseColdRuntime.resolve()
      await coldDispatch?.catch(() => {})
      releaseLiveFreshRuntime.resolve()
      await liveDispatch?.catch(() => {})
    }
  })

  it('cold-restores the shutdown-rolled-back strong-spruce context stop into one clean Retry boundary', async () => {
    const h = harness(); const managed = h.make('strong-spruce-context-retry')
    const originalId = `${managed.id}-user`
    const implementationId = 'strong-implementation-request'
    const originalRequest = 'Audit and implement the requested Zero corrections so the deployment is solid and reproducible.'
    const implementationRequest = 'Procède à leur implantaiotn totale et méthodique selon le plan'
    managed.messages[0]!.content = originalRequest
    managed.messages.push({
      id: 'old-plan-final', role: 'assistant', content: 'OLD_ASSISTANT_PLAN_MUST_NOT_CROSS', timestamp: 2,
      objectiveOutcome: { state: 'complete_verified', remainingWork: [], blocker: null,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: true, evidence: [] }] },
    }, {
      id: implementationId, role: 'user', content: implementationRequest, timestamp: 3,
    })
    managed.activeObjective = {
      schemaVersion: 1, objectiveId: implementationId, userMessageId: implementationId,
      lastUserMessageId: implementationId, originalText: implementationRequest,
      startedAt: 3, budgetBaselineUsd: 4, tokenBaseline: 1_500_000, continuationCount: 0,
      orchestrationMode: 'direct', risk: 'standard', requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      terminalState: 'active', acceptanceRegisteredRevision: implementationId,
      acceptanceRegisteredAt: 4, acceptanceRegisteredAtById: { deployed: 4 },
      acceptanceCriteria: [{
        id: 'deployed', description: 'Zero is healthy at the deployed revision.',
        toolName: 'mcp__fixture__verify', input: { target: 'zero', environment: 'dev' },
        checks: [{ path: '$.healthy', equals: true }],
      }],
    }
    const allocatedAt = Date.now() - 2_000
    const oldDispatchId = 'strong-context-dispatch'
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(implementationId, 3), attempts: 3,
      lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete', validationExhausted: true,
      validationGaps: ['required execution evidence is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: oldDispatchId, attempt: 4, cause: 'objective_incomplete',
        origin: 'automatic', allocatedAt, phase: 'allocated',
        preToolExecutionReceiptVersion: 1,
      },
    }
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1, contextTokensBefore: 147_223, outcome: 'succeeded',
      objectiveRootId: implementationId, providerContextBaselineTokens: 133_667,
      hardLimitTokens: 100_000, hardLimitFollowUpAttempted: true,
    }
    managed.tokenUsage = {
      inputTokens: 537_197, outputTokens: 45_160, totalTokens: 582_357,
      contextTokens: 134_945, costUsd: 6.55,
    }
    managed.sdkSessionId = 'old-provider-session'
    managed.userInputRequests = [{
      id: 'strong-context-question', sessionId: managed.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: implementationId, status: 'pending', createdAt: allocatedAt + 266,
      questions: [{
        id: 'context-limit-next-step',
        question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
        options: [{
          id: 'provide-guidance', label: 'Préciser la reprise',
          description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.', recommended: true,
        }, {
          id: 'stop-objective', label: 'Arrêter cette mission',
          description: 'Conserver les résultats actuels sans nouvel appel fournisseur.',
        }],
      }],
    }]
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id)
    expect(restored.activeObjective).toMatchObject({
      userMessageId: originalId, lastUserMessageId: implementationId,
      originalText: originalRequest,
    })
    expect(requiredTestValue(restored.activeObjective).amendments).toEqual([
      { messageId: implementationId, text: implementationRequest, timestamp: 3 },
    ])
    expect(requiredTestValue(restored.activeObjective).acceptanceCriteria).toHaveLength(1)
    expect(requiredTestValue(requiredTestValue(restored.activeObjective).acceptanceCriteria)[0]).toMatchObject({ id: 'deployed' })
    expect(requiredTestValue(restored.userInputRequests)[0].status).toBe('pending')
    expect(cold.runtime.retryableContextLimitRequest(restored)).toMatchObject({ id: 'strong-context-question' })
    const debugRemaining = [
      'Resolve host validation gap: required execution evidence is missing',
      'Reconcile the current target state against registered acceptance criterion deployed; only if it is unmet, complete it idempotently, then verify it: Zero is healthy at the deployed revision.',
    ]
    expect(createCleanRecoveryContinuationHandoff({
      objective: { ...requiredTestValue(restored.activeObjective), lastOutcome: { state: 'continue', blocker: null,
        criteria: [{ id: 'deployed', satisfied: false, evidence: [] }], remainingWork: debugRemaining } },
      pending: { ...requiredTestValue(restored.pendingTurnRecovery), lastCause: 'user_retry' },
      objectiveText: originalRequest, evidence: [], remainingWork: debugRemaining,
    })).toBeDefined()
    expect(cold.runtime.createContextLimitRetryHandoff(restored, requiredTestValue(restored.pendingTurnRecovery))).toBeDefined()

    let disposed = 0
    cold.runtime.disposeManagedAgentRuntime = async () => { disposed++; restored.agent = null }
    const preparing = deferred(); const release = deferred(); let dispatch: Promise<void> | undefined
    cold.runtime.getOrCreateAgent = async () => {
      preparing.resolve(); await release.promise
      throw new Error('Synthetic clean Retry provider boundary')
    }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    try {
      expect(await cold.manager.retryTurn(restored.id, implementationId)).toEqual({ status: 'started' })
      await Promise.race([
        preparing.promise,
        dispatch!.then(() => { throw new Error(`Clean Retry ended before fresh runtime preparation: processing=${restored.isProcessing}; stop=${restored.stopRequested}; generation=${restored.processingGeneration}; pending=${JSON.stringify(restored.pendingTurnRecovery?.recoveryDispatch)}`) }),
      ])
      expect(disposed).toBe(1)
      expect(restored.sdkSessionId).toBeUndefined()
      expect(restored.providerContextBoundaryMessageId).toBe(requiredTestValue(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).id)
      expect(requiredTestValue(restored.tokenUsage).contextTokens).toBeLessThan(100_000)
      expect(requiredTestValue(restored.userInputRequests)[0]).toMatchObject({ status: 'cancelled' })
      const boundaries = restored.messages.filter((message) => (
        message.id === requiredTestValue(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).id
      ))
      expect(boundaries).toHaveLength(1)
      expect(boundaries[0]).toMatchObject({ role: 'user', hidden: true })
      expect(boundaries[0].content).toContain(originalRequest)
      expect(boundaries[0].content).toContain(implementationRequest)
      expect(boundaries[0].content).toContain('registered acceptance criterion deployed')
      expect(boundaries[0].content).not.toContain('OLD_ASSISTANT_PLAN_MUST_NOT_CROSS')
      const header = JSON.parse(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!)
      expect(header.userInputRequests[0].status).toBe('cancelled')
      expect(header.sdkSessionId).toBeUndefined()
      expect(header.providerContextBoundaryMessageId).toBe(boundaries[0].id)
    } finally {
      release.resolve()
      await dispatch?.catch(() => {})
    }
  })
});
