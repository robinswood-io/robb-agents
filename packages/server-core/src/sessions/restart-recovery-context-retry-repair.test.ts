import { omitUndefined } from '@craft-agent/shared/utils/json';
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { createPendingTurnRecovery, buildCleanRecoveryContinuationPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('repairs a fenced pre-provider clean Retry whose cause was omitted from its hash', async () => {
    const h = harness(); const managed = h.make('fenced-clean-retry-cause')
    const rootId = `${managed.id}-user`
    const dispatchId = 'fenced-clean-retry-dispatch'
    const allocatedAt = Date.now() - 2_000
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId),
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 1, cause: 'user_retry',
        origin: 'retry', allocatedAt, phase: 'allocated',
        preToolExecutionReceiptVersion: 1,
      },
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
    const savedQuestion = managed.userInputRequests!.find(item => item.id === request.requestId)!
    savedQuestion.status = 'cancelled'
    savedQuestion.answeredAt = Date.now()
    const oldHandoff = h.runtime.createAutonomousContextLimitHandoff(
      managed, managed.pendingTurnRecovery,
    )
    const oldPrompt = buildCleanRecoveryContinuationPrompt(requiredTestValue(oldHandoff))!
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      cleanContextBoundaryMessageId: dispatchId,
      recoveryDispatch: {
        ...managed.pendingTurnRecovery!.recoveryDispatch!,
        cleanContinuationId: requiredTestValue(oldHandoff).id,
        setupPersistenceFencedAt: Date.now(),
      },
    }
    managed.messages.push({
      id: dispatchId, role: 'user', hidden: true, timestamp: Date.now(), content: oldPrompt,
    })
    managed.providerContextBoundaryMessageId = dispatchId
    managed.tokenUsage = {
      inputTokens: 105_857, outputTokens: 0, totalTokens: 0,
      contextTokens: Math.ceil(oldPrompt.length / 4), costUsd: 0,
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const entered = deferred(); const release = deferred()
    cold.runtime.getOrCreateAgent = async () => {
      entered.resolve()
      await release.promise
      throw new Error('Synthetic repaired clean Retry provider boundary')
    }
    try {
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      await entered.promise
      const repaired = restored.pendingTurnRecovery!.recoveryDispatch!
      expect(repaired.cleanContinuationId).toMatch(/^clean-continuation-v1-/)
      expect(repaired.cleanContinuationId).not.toBe(requiredTestValue(oldHandoff).id)
      expect(repaired.setupPersistenceFencedAt).toBeUndefined()
      expect(restored.pendingTurnRecovery?.lastCause).toBe('user_retry')
      expect(restored.messages.filter((message: Managed['messages'][number]) => (
        message.id === dispatchId
      ))).toHaveLength(1)
      expect(restored.messages.find((message: Managed['messages'][number]) => (
        message.id === dispatchId
      ))?.content).toContain(repaired.cleanContinuationId)
      expect<unknown>(restored.userInputRequests).toEqual([(expect.objectContaining({
        id: request.requestId, status: 'cancelled',
      }) as unknown)])
    } finally {
      release.resolve()
    }
  })

  it('auto-heals the persisted hard-limit question created by an explicit Retry', async () => {
    const h = harness(); const managed = h.make('cold-retry-context-question-auto-heal')
    const rootId = `${managed.id}-user`
    const dispatchId = 'cold-retry-context-dispatch'
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
    managed.messages[0]!.content = 'Resume the original mission, complete it, and verify the final target.'
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'],
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1), attempts: 2, stagnantAttempts: 0,
      lastAttemptAt: allocatedAt, lastCause: 'user_retry',
      validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 3,
        cause: 'user_retry', origin: 'retry', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
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
    managed.sdkSessionId = 'legacy-retry-provider-session'
    const request = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
    )

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const providerEntered = deferred(); const releaseProvider = deferred(); const sendInvoked = deferred()
    let dispatch: Promise<void> | undefined
    let admission: {
      existingMessageId?: string
      automaticRecovery?: Record<string, unknown>
      retryInFlight: boolean
      allowanceToken?: symbol
      allowanceIntent?: Record<string, unknown>
    } | undefined
    cold.runtime.getOrCreateAgent = async () => {
      providerEntered.resolve()
      await releaseProvider.promise
      throw new Error('Synthetic auto-healed clean Retry provider boundary')
    }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => {
      const allowanceToken = args[12]
      admission = omitUndefined({
        existingMessageId: args[5],
        automaticRecovery: args[4]?.automaticRecovery as Record<string, unknown> | undefined,
        retryInFlight: sessionRuntimeStateForTest(cold.runtime).retryTurnsInFlight.has(restored.id),
        allowanceToken,
        allowanceIntent: allowanceToken
          ? sessionRuntimeStateForTest(cold.runtime).explicitRetryAllowanceTokens.get(allowanceToken)
          : undefined,
      })
      dispatch = send(...args)
      sendInvoked.resolve()
      return dispatch
    }

    try {
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      await sendInvoked.promise
      expect<unknown>(admission).toMatchObject({
        automaticRecovery: {
          originalUserMessageId: rootId,
          cause: 'user_retry',
          dispatchId,
          dispatchAttempt: 3,
          dispatchOrigin: 'retry',
          dispatchAllocatedAt: allocatedAt,
          cleanContinuationId: (expect.stringMatching(/^clean-continuation-v1-/) as unknown),
        },
        retryInFlight: true,
        allowanceToken: (expect.any(Symbol) as unknown),
        allowanceIntent: {
          sessionId: restored.id,
          userMessageId: rootId,
          objectiveId: rootId,
          cleanBoundaryMessageId: dispatchId,
          cleanContinuationId: (expect.stringMatching(/^clean-continuation-v1-/) as unknown),
        },
      })
      expect(Object.hasOwn(requiredTestValue(admission), 'existingMessageId')).toBe(false)
      await Promise.race([
        providerEntered.promise,
        dispatch!.then(
          () => { throw new Error('The recovered clean Retry ended before provider admission') },
          (error: unknown) => { throw error },
        ),
      ])

      expect<unknown>(restored.userInputRequests).toEqual([(expect.objectContaining({
        id: request.requestId, status: 'cancelled',
      }) as unknown)])
      expect(restored.pendingTurnRecovery).toMatchObject({
        attempts: 2, lastCause: 'user_retry',
        recoveryDispatch: {
          id: dispatchId, attempt: 3, phase: 'started',
          cause: 'user_retry', origin: 'retry', allocatedAt,
          cleanContinuationId: admission!.automaticRecovery!["cleanContinuationId"],
        },
      })
      expect(restored.messageQueue).toEqual([])
      const cleanBoundaries = restored.messages.filter((message: Managed['messages'][number]) => (
        message.id === dispatchId
      ))
      expect(cleanBoundaries).toHaveLength(1)
      expect(cleanBoundaries[0]).toMatchObject({ role: 'user', hidden: true })
      expect(cleanBoundaries[0]?.content).toContain('<host_clean_recovery_continuation')
      expect(restored.sdkSessionId).toBeUndefined()
      expect(restored.providerContextBoundaryMessageId).toBe(dispatchId)
      expect(h.events.filter(event => (
        event.type === 'typed_error' && event.error?.code === 'queued_message_replay_failed'
      ))).toEqual([])
    } finally {
      releaseProvider.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('heals an exact pre-provider context question after the live turn stops', async () => {
    const h = harness(); const managed = h.make('live-retry-context-question-auto-heal')
    const rootId = `${managed.id}-user`
    const dispatchId = 'live-retry-context-dispatch'
    const allocatedAt = Date.now() - 2_000
    const startedAt = allocatedAt + 500
    managed.messages[0]!.content = 'Resume the original mission and verify the final target.'
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'],
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1), attempts: 2,
      lastCause: 'user_retry', validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 3,
        cause: 'user_retry', origin: 'retry', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
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
    managed.sdkSessionId = 'oversized-live-retry-provider-session'
    const request = await h.runtime.requestUserInput(managed.id, [{
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
    }], sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId)

    managed.isProcessing = true
    managed.processingGeneration = 1
    const entered = deferred(); const release = deferred()
    let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      expect(managed.sdkSessionId).toBeUndefined()
      entered.resolve()
      await release.promise
      throw new Error('Synthetic live clean Retry provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

    try {
      await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)
      await entered.promise
      expect(managed.userInputRequests?.find(candidate => candidate.id === request.requestId)?.status)
        .toBe('cancelled')
      expect<unknown>(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        id: dispatchId, cause: 'user_retry', origin: 'retry', phase: 'started',
        cleanContinuationId: (expect.stringMatching(/^clean-continuation-v1-/) as unknown),
      })
      expect(managed.messages.filter(message => message.id === dispatchId)).toHaveLength(1)
      expect(managed.messages[0]!.content).toBe('Resume the original mission and verify the final target.')
    } finally {
      release.resolve()
      await dispatch?.catch(() => {})
    }
  })
});
