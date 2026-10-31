import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createPendingTurnRecovery, buildCleanRecoveryContinuationPrompt, createCleanRecoveryContinuationHandoff } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('starts the clean Retry before retained child results and consumes only the answer already folded into its handoff', async () => {
    const h = harness(); const parent = h.make('cold-clean-retry-retained-machine-inbox')
    const child = h.make('cold-clean-retry-retained-machine-child', parent.id)
    const rootId = `${parent.id}-user`
    const answerRequestId = 'retained-machine-business-question'
    const answerId = 'retained-machine-business-answer'
    const deliveryId = 'retained-terminal-child-result'
    const dispatchId = 'retained-machine-clean-retry-dispatch'
    const allocatedAt = Date.now() - 2_000
    const startedAt = allocatedAt + 500
    const answerQuestions = [{
      id: 'scope', question: 'Which accepted target remains in scope?',
      options: [{ id: 'current', label: 'Current target' }],
    }]
    const answerSelections = [{ questionId: 'scope', optionIds: ['current'] }]
    const answerContent = USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({
      requestId: answerRequestId,
      questions: answerQuestions,
      answers: answerSelections,
    })
    parent.messages[0]!.content = 'Complete and verify the preserved parent objective.'
    parent.activeObjective = {
      ...parent.activeObjective!,
      originalText: parent.messages[0]!.content,
      requiresExecutionEvidence: true,
      requiresAcceptanceCriteria: true,
      acceptanceRegisteredRevision: rootId,
      acceptanceRegisteredAt: 1,
      acceptanceCriteria: [{
        id: 'verified-target', description: 'The preserved target is complete and verified.',
        toolName: 'Read', input: { file_path: '/fixture/state.json' },
        checks: [{ path: '$.healthy', equals: true }],
      }],
    }
    parent.messages.push({
      id: answerId, role: 'user', content: answerContent, timestamp: 2,
      hidden: true, isQueued: true, internalOrigin: { kind: 'user-input' },
    }, {
      id: deliveryId, role: 'user', content: 'Exact terminal child result.', timestamp: 3,
      hidden: true, isQueued: true,
      internalOrigin: {
        kind: 'agent-message', senderSessionId: child.id, deliveryId, agentMessageType: 'result',
      },
      agentDelivery: { id: deliveryId, status: 'queued', attempts: 1 },
    })
    parent.userInputRequests = [{
      id: answerRequestId, sessionId: parent.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: rootId, status: 'answered', createdAt: 1, answeredAt: 2,
      responseMessageId: answerId, questions: answerQuestions, answers: answerSelections,
    }]
    parent.messageQueue = [{
      message: answerContent, messageId: answerId,
      options: { hidden: true, internalOrigin: { kind: 'user-input' } },
    }, {
      message: 'Exact terminal child result.', messageId: deliveryId,
      options: { hidden: true, internalOrigin: {
        kind: 'agent-message', senderSessionId: child.id, deliveryId, agentMessageType: 'result',
      } },
    }]
    parent.pendingTurnRecovery = {
      ...createPendingTurnRecovery(answerId, 1), attempts: 2, stagnantAttempts: 0,
      lastAttemptAt: allocatedAt, lastCause: 'user_retry',
      validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 3,
        cause: 'user_retry', origin: 'retry', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
    parent.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000, contextTokensBefore: 130_000,
      outcome: 'succeeded', objectiveRootId: rootId,
      providerContextBaselineTokens: 120_000, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
    }
    parent.tokenUsage = {
      inputTokens: 120_000, outputTokens: 1_000, totalTokens: 121_000,
      contextTokens: 120_000, contextWindow: 200_000, costUsd: 2,
    }
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 3,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 3 }
    child.pendingTurnRecovery = undefined
    child.messages.push({ id: 'retained-child-final', role: 'assistant', content: 'Exact terminal child result.', timestamp: 3 })
    const contextRequest = await h.runtime.requestUserInput(
      parent.id,
      [{
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
      }],
      sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability,
      dispatchId,
    )
    await h.save(parent); await h.save(child)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(parent.id))
    await cold.runtime.ensureMessagesLoaded(restored)
    expect(cold.runtime.retryableContextLimitRequest(restored)).toMatchObject({
      id: contextRequest.requestId,
    })
    expect(cold.runtime.createContextLimitRetryHandoff(
      restored, requiredTestValue(restored.pendingTurnRecovery),
    )).toBeDefined()
    expect(restored.messageQueue.map((item: Managed['messageQueue'][number]) => item.messageId))
      .toEqual([answerId, deliveryId])
    const providerEntered = deferred(); const releaseProvider = deferred(); let send: Promise<void> | undefined
    cold.runtime.getOrCreateAgent = async () => {
      providerEntered.resolve()
      await releaseProvider.promise
      throw new Error('Synthetic retained-machine clean Retry provider boundary')
    }
    const realSend = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => { send = realSend(...args); return send }
    try {
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      await providerEntered.promise

      expect<unknown>(restored.userInputRequests).toEqual([
        (expect.objectContaining({ id: answerRequestId, status: 'answered', responseMessageId: answerId }) as unknown),
        (expect.objectContaining({ id: contextRequest.requestId, status: 'cancelled' }) as unknown),
      ])
      expect(restored.messages.find((message: Managed['messages'][number]) => message.id === answerId))
        .toMatchObject({ hidden: true, isQueued: false, internalOrigin: { kind: 'user-input' } })
      expect(restored.messageQueue.map((item: Managed['messageQueue'][number]) => item.messageId))
        .toEqual([deliveryId])
      expect(restored.messages.find((message: Managed['messages'][number]) => message.id === deliveryId))
        .toMatchObject({
          hidden: true, isQueued: true,
          agentDelivery: { id: deliveryId, status: 'queued', attempts: 1 },
        })
      expect(restored.pendingTurnRecovery).toMatchObject({
        attempts: 2,
        recoveryDispatch: { id: dispatchId, attempt: 3, phase: 'started' },
      })
      expect(restored.pendingTurnRecovery?.explicitRetryAllowances ?? []).toEqual([])
      const cleanBoundary = restored.messages.find(
        (message: Managed['messages'][number]) => message.id === dispatchId,
      )
      expect(restored.messages.filter((message: Managed['messages'][number]) => message.id === dispatchId))
        .toHaveLength(1)
      expect(cleanBoundary?.content).toContain('[host-authenticated-user-answer:v1]')
      expect(cleanBoundary?.content).toContain('Current target')
      expect(requiredTestValue(restored.userInputRequests).filter((request: { status: string }) => request.status === 'pending'))
        .toEqual([])
    } finally {
      releaseProvider.resolve()
      await send?.catch(() => {})
    }

    expect(restored.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
      id: dispatchId, attempt: 3, phase: 'allocated',
    })
    expect(restored.messageQueue.map((item: Managed['messageQueue'][number]) => item.messageId))
      .toEqual([undefined, deliveryId])
    expect<unknown>(restored.messageQueue[0]?.options?.automaticRecovery).toMatchObject({
      dispatchId, cleanContinuationId: (expect.stringMatching(/^clean-continuation-v1-/) as unknown),
    })
    expect(restored.messages.find((message: Managed['messages'][number]) => message.id === deliveryId))
      .toMatchObject({
        hidden: true, isQueued: true,
        agentDelivery: { id: deliveryId, status: 'queued', attempts: 1 },
      })
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticRetryTimers.has(restored.id)).toBe(true)
  })

  it('does not spend an agent-delivery attempt when a clean-boundary authentication fails before provider work', async () => {
    const h = harness(); const managed = h.make('clean-boundary-pre-provider-delivery-fence')
    const child = h.make('clean-boundary-pre-provider-delivery-child', managed.id)
    const deliveryId = 'pre-provider-terminal-delivery'
    const dispatchId = 'pending-clean-boundary'
    const remainingWork = ['Consume the authenticated terminal child result and finish the parent objective.']
    managed.activeObjective = {
      ...managed.activeObjective!,
      lastOutcome: {
        state: 'continue', blocker: null, remainingWork,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
      },
    }
    const parentObjectiveId = managed.activeObjective.objectiveId ?? managed.activeObjective.userMessageId
    child.delegation = {
      rootSessionId: managed.id, rootObjectiveId: parentObjectiveId, parentObjectiveId,
      depth: 1, role: 'worker', finishedAt: 2,
    }
    child.activeObjective = { ...child.activeObjective!, terminalState: 'complete_verified', completedAt: 2 }
    child.pendingTurnRecovery = undefined
    child.messages.push({
      id: 'pre-provider-child-final', role: 'assistant',
      content: 'Preserved terminal child result.', timestamp: 2,
    })
    const queued = {
      message: 'Preserved terminal child result.',
      messageId: deliveryId,
      options: { hidden: true, internalOrigin: {
        kind: 'agent-message' as const,
        senderSessionId: child.id,
        deliveryId,
        agentMessageType: 'result' as const,
      } },
    }
    managed.messages.push({
      id: deliveryId, role: 'user', content: queued.message, timestamp: 2,
      hidden: true, isQueued: true, internalOrigin: queued.options.internalOrigin,
      agentDelivery: { id: deliveryId, status: 'queued', attempts: 1 },
    })
    const pending = {
      ...managed.pendingTurnRecovery!,
      lastCause: 'user_retry' as const,
      continuationWork: remainingWork,
    }
    const handoff = createCleanRecoveryContinuationHandoff({
      objective: managed.activeObjective,
      pending,
      objectiveText: managed.activeObjective.originalText,
      evidence: [],
      remainingWork,
    })!
    expect(handoff.id).toMatch(/^clean-continuation-v1-[a-f0-9]{24}$/)
    managed.pendingTurnRecovery = {
      ...pending,
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 3,
        cause: 'user_retry', origin: 'retry', allocatedAt: 2,
        phase: 'allocated', cleanContinuationId: handoff.id,
      },
      cleanContextBoundaryMessageId: dispatchId,
    }
    managed.providerContextBoundaryMessageId = dispatchId
    const dispatchToken = Symbol('fixture-agent-delivery-dequeue')
    sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.set(managed.id, dispatchToken)
    sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.set(deliveryId, {
      sessionId: managed.id,
      deliveryId,
      dispatchToken,
      claimed: false,
      providerStarted: false, dispatchSettled: false,
    })
    let preparations = 0
    h.runtime.getOrCreateAgent = async () => {
      preparations++
      throw new Error('Provider preparation must not start')
    }

    await expect(h.manager.sendMessage(
      managed.id,
      queued.message,
      undefined,
      undefined,
      queued.options,
      deliveryId,
      undefined,
      undefined,
      undefined,
      dispatchToken,
      queued,
    )).rejects.toThrow('clean recovery continuation failed its durable dispatch authentication')

    expect(preparations).toBe(0)
    expect(managed.messages.find(message => message.id === deliveryId)).toMatchObject({
      isQueued: true,
      agentDelivery: { id: deliveryId, status: 'queued', attempts: 1 },
    })
    expect(managed.isProcessing).toBe(false)
    expect(managed.messageQueue).toEqual([queued])
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.has(managed.id)).toBe(false)
    expect(sessionRuntimeStateForTest(h.runtime).queuedAgentDeliveryDispatches.has(deliveryId)).toBe(false)
    expect(sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.has(managed.id)).toBe(false)
    expect(managed.userInputRequests?.some(request => (
      request.status === 'pending'
      && request.questions.some(question => question.id.startsWith('retry-child-result-'))
    )) ?? false).toBe(false)

    // After the exact clean dispatch produces durable provider output, the
    // same retained child receipt must be eligible without spending a second
    // clean-boundary attempt or replaying that provider dispatch.
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      recoveryDispatch: {
        ...managed.pendingTurnRecovery!.recoveryDispatch!,
        phase: 'started', startedAt: 3,
      },
    }
    managed.messages.push({
      id: dispatchId, role: 'user', hidden: true, timestamp: 3,
      content: buildCleanRecoveryContinuationPrompt(handoff)!,
    })
    expect(h.runtime.hasConsumedCleanRecoveryDispatch(managed)).toBe(false)
    managed.sessionStatus = 'in-progress'
    h.runtime.processNextQueuedMessage(managed.id)
    for (let attempt = 0; attempt < 30
      && !h.events.some(event => event.type === 'typed_error'
        && event.error?.title === 'Queued agent result retained'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(h.events.filter(event => event.type === 'typed_error'
      && event.error?.title === 'Queued agent result retained')).toHaveLength(1)
    expect(managed.messageQueue).toEqual([queued])
    expect(managed.messages.find(message => message.id === deliveryId)).toMatchObject({
      isQueued: true, agentDelivery: { status: 'queued', attempts: 1 },
    })
    managed.messages.push({
      id: 'observed-clean-provider-tool', role: 'tool', content: 'Read completed', timestamp: 4,
    })
    expect(h.runtime.hasConsumedCleanRecoveryDispatch(managed)).toBe(true)
    let queueDrains = 0
    h.runtime.processNextQueuedMessage = () => { queueDrains++ }
    await h.runtime.onProcessingStopped(managed.id, 'interrupted', managed.processingGeneration)
    expect(managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
    expect(queueDrains).toBe(1)
    expect(managed.messageQueue).toEqual([queued])
    expect(managed.messages.find(message => message.id === deliveryId)).toMatchObject({
      isQueued: true, agentDelivery: { status: 'queued', attempts: 1 },
    })
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
    expect(requiredTestValue(requiredTestValue(stored[0]).pendingTurnRecovery).recoveryDispatch).toBeUndefined()
  })
});
