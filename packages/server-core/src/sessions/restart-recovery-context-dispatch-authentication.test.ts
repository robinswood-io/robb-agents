import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { createPendingTurnRecovery, buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it.each(['started', 'allocated'] as const)(
    'accepts a current-host %s context prompt bound to the root while recovery tracks its latest amendment',
    async phase => {
      const h = harness(); const managed = h.make(`current-root-context-prompt-${phase}`)
      const rootId = `${managed.id}-user`
      const amendmentId = `${managed.id}-implementation`
      const amendmentText = 'Implement the accepted plan completely on the existing target.'
      managed.messages.push({
        id: amendmentId, role: 'user', content: amendmentText, timestamp: 2,
      })
      managed.activeObjective = {
        ...managed.activeObjective!, lastUserMessageId: amendmentId,
        amendments: [{ messageId: amendmentId, text: amendmentText, timestamp: 2 }],
        requiresAcceptanceCriteria: true, acceptanceRegisteredRevision: amendmentId,
        acceptanceRegisteredAt: 3,
        acceptanceCriteria: [{
          id: 'verified', description: 'The existing target is verified.',
          toolName: 'Read', input: { file_path: '/fixture/state.json' },
          checks: [{ path: '$.healthy', equals: true }],
        }],
      }
      const allocatedAt = Date.now() - 2_000
      const startedAt = allocatedAt + 400
      const dispatchId = `current-root-context-dispatch-${phase}`
      managed.pendingTurnRecovery = {
        ...createPendingTurnRecovery(amendmentId, 2), attempts: 3,
        lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete',
        validationExhausted: true, validationGaps: ['required execution evidence is missing'],
        recoveryDispatch: phase === 'started' ? {
          schemaVersion: 1, id: dispatchId, attempt: 4,
          cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
          phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
        } : {
          schemaVersion: 1, id: dispatchId, attempt: 4,
          cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
          phase: 'allocated', preToolExecutionReceiptVersion: 1,
        },
      }
      if (phase === 'started') {
        managed.messages.push({
          id: dispatchId, role: 'user', hidden: true, timestamp: startedAt + 1,
          content: buildAutomaticTurnRecoveryPrompt(
            managed.pendingTurnRecovery, 'objective_incomplete', undefined, 4, managed.activeObjective,
          ),
        })
      }
      managed.contextCompactionAttempt = {
        attemptedAt: allocatedAt - 1_000, contextTokensBefore: 147_223,
        outcome: 'succeeded', objectiveRootId: amendmentId,
        providerContextBaselineTokens: 133_667, hardLimitTokens: 100_000,
        hardLimitFollowUpAttempted: true,
      }
      managed.tokenUsage = {
        inputTokens: 1, outputTokens: 1, totalTokens: 2,
        contextTokens: 134_945, costUsd: 1,
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
      const created = await h.runtime.requestUserInput(
        managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
      )
      const request = managed.userInputRequests![0]!
      expect(request).toMatchObject({
        id: created.requestId, objectiveUserMessageId: rootId,
        hostPrompt: { objectiveId: rootId, recoveryDispatchId: dispatchId },
      })
      expect(h.runtime.retryableContextLimitRequest(managed)).toMatchObject({
        id: created.requestId,
      })
      expect(h.runtime.createContextLimitRetryHandoff(managed, managed.pendingTurnRecovery)).toBeDefined()
    },
  )

  it('selects the current context-limit dispatch after a prior clean Retry left its question cancelled', async () => {
    const h = harness(); const managed = h.make('second-context-limit-cycle')
    const rootId = `${managed.id}-user`
    const now = Date.now()
    const oldDispatchId = 'first-context-limit-dispatch'
    const dispatchId = 'second-context-limit-dispatch'
    const allocatedAt = now - 2_000
    const startedAt = allocatedAt + 400
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
    managed.activeObjective = {
      ...managed.activeObjective!, requiresAcceptanceCriteria: true,
      acceptanceRegisteredRevision: rootId, acceptanceRegisteredAt: now - 5_000,
      acceptanceCriteria: [{
        id: 'verified', description: 'The existing target is complete and verified.',
        toolName: 'Read', input: { file_path: '/fixture/state.json' },
        checks: [{ path: '$.healthy', equals: true }],
      }],
    }
    managed.userInputRequests = [{
      id: 'first-context-limit-question', sessionId: managed.id,
      originWorkspaceId: h.workspace.id, objectiveUserMessageId: rootId,
      status: 'cancelled', createdAt: now - 9_000, answeredAt: now - 8_000,
      hostPrompt: { schemaVersion: 1, kind: 'context-limit-next-step', objectiveId: rootId,
        recoveryDispatchId: oldDispatchId, issuedAt: now - 9_100 },
      questions,
    }]
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 2), attempts: 4,
      lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete',
      validationExhausted: true, validationGaps: ['required verification is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: dispatchId, attempt: 5,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
        phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
      },
    }
    managed.messages.push({
      id: dispatchId, role: 'user', hidden: true, timestamp: startedAt + 1,
      content: buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery, 'objective_incomplete', undefined, 5, managed.activeObjective,
      ),
    })
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000, contextTokensBefore: 147_223,
      outcome: 'succeeded', objectiveRootId: rootId,
      providerContextBaselineTokens: 133_667, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
    }
    managed.tokenUsage = {
      inputTokens: 1, outputTokens: 1, totalTokens: 2,
      contextTokens: 134_945, costUsd: 1,
    }
    const created = await h.runtime.requestUserInput(
      managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
    )
    expect(managed.userInputRequests).toHaveLength(2)
    expect(managed.userInputRequests![0]).toMatchObject({
      id: 'first-context-limit-question', status: 'cancelled',
      hostPrompt: { recoveryDispatchId: oldDispatchId },
    })
    expect(h.runtime.retryableContextLimitRequest(managed)).toMatchObject({
      id: created.requestId, status: 'pending',
      hostPrompt: { recoveryDispatchId: dispatchId },
    })

    const preparing = deferred(); const release = deferred(); let retryDispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      preparing.resolve(); await release.promise
      throw new Error('Synthetic second-cycle clean Retry provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { retryDispatch = send(...args); return retryDispatch }
    try {
      expect(await h.manager.retryTurn(managed.id, rootId)).toEqual({ status: 'started' })
      await preparing.promise
      expect<unknown>(managed.userInputRequests).toEqual([
        (expect.objectContaining({ id: 'first-context-limit-question', status: 'cancelled' }) as unknown),
        (expect.objectContaining({ id: created.requestId, status: 'cancelled' }) as unknown),
      ])
      expect<unknown>(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        cause: 'user_retry', origin: 'retry', phase: 'started',
        cleanContinuationId: (expect.any(String) as unknown),
      })
    } finally {
      release.resolve()
      await retryDispatch?.catch(() => {})
    }
  })

  it.each(['started', 'allocated'] as const)(
    'accepts a current-host %s context prompt when recovery tracks an authenticated structured answer',
    async phase => {
      const h = harness(); const managed = h.make(`current-answer-context-prompt-${phase}`)
      const rootId = `${managed.id}-user`
      const answerRequestId = `${managed.id}-business-question`
      const answerId = `${managed.id}-business-answer`
      const answerQuestions = [{ id: 'scope', question: 'Which existing target should be completed?',
        options: [{ id: 'current', label: 'Current target' }] }]
      const answerSelections = [{ questionId: 'scope', optionIds: ['current'] }]
      managed.activeObjective = {
        ...managed.activeObjective!, requiresAcceptanceCriteria: true,
        acceptanceRegisteredRevision: rootId, acceptanceRegisteredAt: 3,
        acceptanceCriteria: [{
          id: 'verified', description: 'The existing target is complete and verified.',
          toolName: 'Read', input: { file_path: '/fixture/state.json' },
          checks: [{ path: '$.healthy', equals: true }],
        }],
      }
      managed.messages.push({
        id: answerId, role: 'user', hidden: true, isQueued: false, timestamp: 2,
        internalOrigin: { kind: 'user-input' },
        content: USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({
          requestId: answerRequestId, questions: answerQuestions, answers: answerSelections,
        }),
      })
      managed.userInputRequests = [{
        id: answerRequestId, sessionId: managed.id, originWorkspaceId: h.workspace.id,
        objectiveUserMessageId: rootId, status: 'answered', createdAt: 1,
        answeredAt: 2, responseMessageId: answerId,
        questions: answerQuestions, answers: answerSelections,
      }]
      const allocatedAt = Date.now() - 2_000
      const startedAt = allocatedAt + 400
      const dispatchId = `current-answer-context-dispatch-${phase}`
      managed.pendingTurnRecovery = {
        ...createPendingTurnRecovery(answerId, 2), attempts: 3,
        lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete',
        validationExhausted: true, validationGaps: ['required execution evidence is missing'],
        recoveryDispatch: phase === 'started' ? {
          schemaVersion: 1, id: dispatchId, attempt: 4,
          cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
          phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
        } : {
          schemaVersion: 1, id: dispatchId, attempt: 4,
          cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
          phase: 'allocated', preToolExecutionReceiptVersion: 1,
        },
      }
      if (phase === 'started') {
        managed.messages.push({
          id: dispatchId, role: 'user', hidden: true, timestamp: startedAt + 1,
          content: buildAutomaticTurnRecoveryPrompt(
            managed.pendingTurnRecovery, 'objective_incomplete', undefined, 4, managed.activeObjective,
          ),
        })
      }
      managed.contextCompactionAttempt = {
        attemptedAt: allocatedAt - 1_000, contextTokensBefore: 147_223,
        outcome: 'succeeded', objectiveRootId: rootId,
        providerContextBaselineTokens: 133_667, hardLimitTokens: 100_000,
        hardLimitFollowUpAttempted: true,
      }
      managed.tokenUsage = {
        inputTokens: 1, outputTokens: 1, totalTokens: 2,
        contextTokens: 134_945, costUsd: 1,
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
      const created = await h.runtime.requestUserInput(
        managed.id, questions, sessionRuntimeStateForTest(h.runtime).contextLimitUserInputCapability, dispatchId,
      )
      const contextRequest = managed.userInputRequests.find((request) => request.id === created.requestId)!
      expect(contextRequest).toMatchObject({
        objectiveUserMessageId: rootId,
        hostPrompt: { objectiveId: rootId, recoveryDispatchId: dispatchId },
      })
      expect(h.runtime.pendingRecoveryBelongsToCurrentObjective(
        managed, managed.pendingTurnRecovery,
      )).toBe(true)
      expect(h.runtime.retryableContextLimitRequest(managed)).toMatchObject({
        id: created.requestId,
      })
      expect(h.runtime.createContextLimitRetryHandoff(managed, managed.pendingTurnRecovery)).toBeDefined()

      const preparing = deferred(); const release = deferred(); let dispatch: Promise<void> | undefined
      h.runtime.getOrCreateAgent = async () => {
        preparing.resolve(); await release.promise
        throw new Error('Synthetic answer-driven clean Retry provider boundary')
      }
      const send = h.manager.sendMessage.bind(h.manager)
      h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
      try {
        expect(await h.manager.retryTurn(managed.id, rootId)).toEqual({ status: 'started' })
        await preparing.promise
        const cleanBoundary = managed.messages.find(message => (
          message.id === managed.pendingTurnRecovery?.recoveryDispatch?.id
        ))
        expect(cleanBoundary?.content).toContain('[host-authenticated-user-answer:v1]')
        expect(cleanBoundary?.content).toContain('Current target')
        expect(managed.pendingTurnRecovery?.userMessageId).toBe(rootId)
        expect(contextRequest.status).toBe('cancelled')
      } finally {
        release.resolve()
        await dispatch?.catch(() => {})
      }
    },
  )

  it('rejects a current-host root prompt when the recovery is not the authenticated latest amendment', () => {
    const h = harness(); const managed = h.make('current-root-stale-revision')
    const rootId = `${managed.id}-user`
    const staleRevisionId = `${managed.id}-stale-revision`
    const allocatedAt = Date.now() - 2_000
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, userMessageId: staleRevisionId, attempts: 3,
      lastAttemptAt: allocatedAt, lastCause: 'objective_incomplete', validationExhausted: true,
      validationGaps: ['required execution evidence is missing'],
      recoveryDispatch: {
        schemaVersion: 1, id: 'current-root-stale-dispatch', attempt: 4,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
        phase: 'allocated', preToolExecutionReceiptVersion: 1,
      },
    }
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000, contextTokensBefore: 147_223,
      outcome: 'succeeded', objectiveRootId: rootId,
      providerContextBaselineTokens: 133_667, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
    }
    managed.tokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2,
      contextTokens: 134_945, costUsd: 1 }
    managed.userInputRequests = [{
      id: 'current-root-stale-question', sessionId: managed.id,
      originWorkspaceId: h.workspace.id, objectiveUserMessageId: rootId,
      status: 'pending', createdAt: allocatedAt + 200,
      hostPrompt: { schemaVersion: 1, kind: 'context-limit-next-step', objectiveId: rootId,
        recoveryDispatchId: 'current-root-stale-dispatch', issuedAt: allocatedAt + 100 },
      questions: [{ id: 'context-limit-next-step',
        question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
        options: [{ id: 'provide-guidance', label: 'Préciser la reprise',
          description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.', recommended: true },
        { id: 'stop-objective', label: 'Arrêter cette mission',
          description: 'Conserver les résultats actuels sans nouvel appel fournisseur.' }] }],
    }]

    expect(h.runtime.retryableContextLimitRequest(managed)).toBeUndefined()
  })

  it.each([
    ['post-allocation provider transcript', (managed: Managed, allocatedAt: number) => {
      managed.messages.push({
        id: 'provider-lookalike-tool', role: 'tool', content: 'Running request_user_input...',
        timestamp: allocatedAt + 1, toolName: 'mcp__session__request_user_input',
        toolUseId: 'provider-lookalike-question', toolStatus: 'completed', toolExecuted: true,
      })
    }],
    ['allocation timestamp mismatch', (managed: Managed) => {
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        lastAttemptAt: managed.pendingTurnRecovery!.recoveryDispatch!.allocatedAt - 1,
      }
    }],
    ['stale legacy allocation window', (managed: Managed, allocatedAt: number) => {
      managed.userInputRequests![0]!.createdAt = allocatedAt + 5 * 60 * 1_000 + 1
    }],
  ] as const)(
    'does not treat exact allocated context-limit text as host authority with %s',
    async (_case, invalidate) => {
      const h = harness(); const managed = h.make(`allocated-context-lookalike-${_case.replaceAll(' ', '-')}`)
      const rootId = `${managed.id}-user`
      const allocatedAt = Date.now() - 2_000
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!, attempts: 3, lastAttemptAt: allocatedAt,
        lastCause: 'objective_incomplete', validationExhausted: true,
        validationGaps: ['required execution evidence is missing'],
        recoveryDispatch: {
          schemaVersion: 1, id: 'allocated-context-dispatch', attempt: 4,
          cause: 'objective_incomplete', origin: 'automatic', allocatedAt,
          phase: 'allocated', preToolExecutionReceiptVersion: 1,
        },
      }
      managed.contextCompactionAttempt = {
        attemptedAt: allocatedAt - 1_000, contextTokensBefore: 147_223,
        outcome: 'succeeded', objectiveRootId: rootId,
        providerContextBaselineTokens: 133_667, hardLimitTokens: 100_000,
        hardLimitFollowUpAttempted: true,
      }
      managed.tokenUsage = {
        inputTokens: 1, outputTokens: 1, totalTokens: 2,
        contextTokens: 134_945, costUsd: 1,
      }
      managed.userInputRequests = [{
        id: 'exact-text-lookalike', sessionId: managed.id,
        originWorkspaceId: h.workspace.id, objectiveUserMessageId: rootId,
        status: 'pending', createdAt: allocatedAt + 266,
        questions: [{
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
      }]
      invalidate(managed, allocatedAt)

      expect(h.runtime.retryableContextLimitRequest(managed)).toBeUndefined()
      await expect(h.manager.retryTurn(managed.id, rootId))
        .rejects.toThrow('Answer or cancel the pending questions')
      expect(managed.userInputRequests[0]).toMatchObject({ status: 'pending' })
    },
  )
});
