import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { getQueuedPendingUserInputResponse as policyGetQueuedPendingUserInputResponse } from "./SessionManager/policy.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createPendingTurnRecovery, buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('keeps an unrelated pending question intact instead of consuming it for a context-limit Retry', async () => {
    const h = harness(); const managed = h.make('context-retry-unrelated-question')
    const now = Date.now()
    managed.activeObjective = {
      ...managed.activeObjective!, requiresAcceptanceCriteria: true,
      acceptanceRegisteredRevision: `${managed.id}-user`, acceptanceRegisteredAt: now,
      acceptanceCriteria: [{ id: 'verified', description: 'Target is verified.', toolName: 'Read',
        input: { file_path: '/fixture' }, checks: [{ path: '$text', equals: 'ok' }] }],
    }
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, validationGaps: ['verification missing'],
      recoveryDispatch: { schemaVersion: 1, id: 'context-dispatch', attempt: 3,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt: now - 2_000,
        phase: 'started', startedAt: now - 1_500, preToolExecutionReceiptVersion: 1 },
    }
    managed.messages.push({ id: 'context-dispatch', role: 'user', hidden: true, timestamp: now - 1_400,
      content: buildAutomaticTurnRecoveryPrompt(managed.pendingTurnRecovery, 'objective_incomplete', undefined, 3, managed.activeObjective) })
    managed.contextCompactionAttempt = { attemptedAt: now - 3_000, contextTokensBefore: 120_000,
      outcome: 'succeeded', objectiveRootId: `${managed.id}-user`, hardLimitTokens: 100_000,
      providerContextBaselineTokens: 120_000, hardLimitFollowUpAttempted: true }
    managed.tokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, contextTokens: 120_000, costUsd: 1 }
    managed.userInputRequests = [{ id: 'context-question', sessionId: managed.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: `${managed.id}-user`, status: 'pending', createdAt: now - 1_000,
      questions: [{ id: 'context-limit-next-step',
        question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
        options: [{ id: 'provide-guidance', label: 'Préciser la reprise',
          description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.', recommended: true },
        { id: 'stop-objective', label: 'Arrêter cette mission',
          description: 'Conserver les résultats actuels sans nouvel appel fournisseur.' }] }],
    }, { id: 'business-question', sessionId: managed.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: `${managed.id}-user`, status: 'pending', createdAt: now - 900,
      questions: [{ id: 'target', question: 'Which target?', options: [{ id: 'a', label: 'A' }] }] }]
    await expect(h.manager.retryTurn(managed.id, `${managed.id}-user`))
      .rejects.toThrow('Answer or cancel the pending questions')
    expect(managed.userInputRequests.map(request => request.status)).toEqual(['pending', 'pending'])
    expect(managed.messages.filter(message => message.content.includes('<host_clean_recovery_continuation'))).toEqual([])
  })

  it('cold-rebinds an ordinary pending question to the repaired human root and accepts its answer', async () => {
    const h = harness(); const managed = h.make('repaired-root-business-question')
    const originalId = `${managed.id}-user`
    const contextualId = 'repaired-root-contextual-request'
    const originalRequest = 'Audit and implement the requested Zero corrections so the deployment is solid and reproducible.'
    const contextualRequest = 'Procède à leur implantaiotn totale et méthodique selon le plan'
    managed.messages[0]!.content = originalRequest
    managed.messages.push({
      id: 'repaired-root-old-plan', role: 'assistant', content: 'Previous plan.', timestamp: 2,
      objectiveOutcome: { state: 'complete_verified', blocker: null, remainingWork: [],
        criteria: [{ id: 'requested-outcome-delivered', satisfied: true, evidence: [] }] },
    }, { id: contextualId, role: 'user', content: contextualRequest, timestamp: 3 })
    managed.activeObjective = {
      schemaVersion: 1, objectiveId: contextualId, userMessageId: contextualId,
      lastUserMessageId: contextualId, originalText: contextualRequest,
      startedAt: 3, budgetBaselineUsd: 2, tokenBaseline: 100, continuationCount: 0,
      orchestrationMode: 'direct', risk: 'standard', requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      terminalState: 'active',
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery(contextualId, 3)
    managed.userInputRequests = [{
      id: 'business-target-question', sessionId: managed.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: contextualId, status: 'pending', createdAt: 4,
      questions: [{ id: 'target', question: 'Which environment should be inspected?',
        options: [{ id: 'dev', label: 'Development' }] }],
    }]
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id)
    expect(restored.activeObjective).toMatchObject({
      userMessageId: originalId, lastUserMessageId: contextualId, originalText: originalRequest,
    })
    expect(requiredTestValue(restored.userInputRequests)[0]).toMatchObject({
      id: 'business-target-question', status: 'pending', objectiveUserMessageId: originalId,
    })
    const repairedHeader = JSON.parse(
      readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!,
    )
    expect(repairedHeader.userInputRequests[0].objectiveUserMessageId).toBe(originalId)

    restored.isProcessing = true
    const accepted = await cold.manager.respondToUserInput(restored.id, {
      requestId: 'business-target-question',
      answers: [{ questionId: 'target', optionIds: ['dev'] }],
    })
    expect(accepted).toMatchObject({ status: 'accepted', delivery: 'queued' })
    expect(requiredTestValue(restored.userInputRequests)[0]).toMatchObject({
      status: 'answered', objectiveUserMessageId: originalId,
    })
    expect(restored.messages.find((message) => (
      message.id === requiredTestValue(restored.userInputRequests)[0].responseMessageId
    ))).toMatchObject({ role: 'user', hidden: true, isQueued: true,
      internalOrigin: { kind: 'user-input' } })
  })

  it.each(['current', 'legacy'] as const)(
    'cold-rebinds an exact %s answered business question for queued replay and later authority', async format => {
      const h = harness(); const managed = h.make(`repaired-root-answered-${format}`)
      const originalId = `${managed.id}-user`
      const contextualId = `repaired-root-contextual-${format}`
      const responseId = `repaired-root-answer-${format}`
      const requestId = `repaired-root-question-${format}`
      const originalRequest = 'Audit and implement the requested Zero corrections so the deployment is solid and reproducible.'
      const contextualRequest = 'Procède à leur implantation totale et méthodique selon le plan'
      const questions = [{ id: 'deploy', question: 'Deploy the verified target?',
        options: [{ id: 'yes', label: 'Yes', description: 'Deploy the verified target.' }] }]
      const answers = [{ questionId: 'deploy', optionIds: ['yes'] }]
      const prefix = format === 'current'
        ? 'The user answered the pending questions. Apply these authenticated selections to the current objective without replacing it. An affirmative selection authorizes only the exact displayed scope it confirms; it grants no broader permission or credential.\n'
        : 'The user answered the pending questions. Apply these answers to the current objective without replacing it. They are preferences or information, not an execution permission or credential.\n'
      const responseContent = prefix + JSON.stringify({ requestId, questions, answers })
      managed.messages[0]!.content = originalRequest
      managed.messages.push({
        id: 'repaired-root-answered-old-plan', role: 'assistant', content: 'Previous plan.', timestamp: 2,
        objectiveOutcome: { state: 'complete_verified', blocker: null, remainingWork: [],
          criteria: [{ id: 'requested-outcome-delivered', satisfied: true, evidence: [] }] },
      }, { id: contextualId, role: 'user', content: contextualRequest, timestamp: 3 }, {
        id: responseId, role: 'user', content: responseContent, timestamp: 5,
        hidden: true, isQueued: true, internalOrigin: { kind: 'user-input' },
      })
      managed.activeObjective = {
        schemaVersion: 1, objectiveId: contextualId, userMessageId: contextualId,
        lastUserMessageId: contextualId, originalText: contextualRequest,
        startedAt: 3, budgetBaselineUsd: 2, tokenBaseline: 100, continuationCount: 0,
        orchestrationMode: 'direct', risk: 'standard', requiresExecutionEvidence: true,
        completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
        terminalState: 'active',
      }
      managed.pendingTurnRecovery = createPendingTurnRecovery(contextualId, 3)
      managed.userInputRequests = [{
        id: requestId, sessionId: managed.id, originWorkspaceId: h.workspace.id,
        objectiveUserMessageId: contextualId, status: 'answered', createdAt: 4, answeredAt: 5,
        questions, answers, responseMessageId: responseId,
      }, {
        id: `repaired-root-context-limit-${format}`, sessionId: managed.id,
        originWorkspaceId: h.workspace.id, objectiveUserMessageId: contextualId,
        status: 'pending', createdAt: 6,
        questions: [{ id: 'context-limit-next-step',
          question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
          options: [{ id: 'provide-guidance', label: 'Préciser la reprise',
            description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.', recommended: true },
          { id: 'stop-objective', label: 'Arrêter cette mission',
            description: 'Conserver les résultats actuels sans nouvel appel fournisseur.' }] }],
      }]
      managed.messageQueue = [{
        message: responseContent, messageId: responseId,
        options: { hidden: true, internalOrigin: { kind: 'user-input' } },
      }]
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      cold.runtime.processNextQueuedMessage = () => {}
      await cold.runtime.ensureMessagesLoaded(restored)
      await cold.manager.flushSession(restored.id)

      expect(restored.activeObjective).toMatchObject({
        userMessageId: originalId, lastUserMessageId: contextualId, originalText: originalRequest,
      })
      expect(requiredTestValue(restored.userInputRequests)[0]).toMatchObject({
        id: requestId, status: 'answered', objectiveUserMessageId: originalId,
      })
      expect(requiredTestValue(restored.userInputRequests)[1]).toMatchObject({
        id: `repaired-root-context-limit-${format}`,
        status: 'pending', objectiveUserMessageId: contextualId,
      })
      expect(policyGetQueuedPendingUserInputResponse(restored)?.id).toBe(requestId)
      expect(cold.runtime.queuedHumanIndex(restored)).toBeGreaterThanOrEqual(0)
      const repairedHeader = JSON.parse(
        readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!,
      )
      expect(repairedHeader.userInputRequests[0].objectiveUserMessageId).toBe(originalId)
      expect(repairedHeader.userInputRequests[1].objectiveUserMessageId).toBe(contextualId)

      const response = restored.messages.find((message) => message.id === responseId)!
      response.isQueued = false
      restored.messageQueue = restored.messageQueue.filter((item) => item.messageId !== responseId)
      const authority = cold.runtime.authenticatedObjectiveAuthorizationSegments(
        restored,
        requiredTestValue(restored.activeObjective),
      )
      expect(authority.authenticatedUserAuthorizationSegments).toHaveLength(1)
      expect(authority.authenticatedUserAuthorizationSegments[0])
        .toContain('[host-authenticated-user-authorization:v1]')
      expect(authority.authorizationSegments).toContain(originalRequest)
    },
  )

  it('rolls back the clean context Retry boundary, question and provider boundary when its first fsync fails', async () => {
    const h = harness(); const managed = h.make('context-retry-first-fsync-failure')
    const rootId = `${managed.id}-user`
    const now = Date.now()
    const oldDispatchId = 'context-retry-old-dispatch'
    managed.activeObjective = {
      ...managed.activeObjective!, requiresAcceptanceCriteria: true,
      acceptanceRegisteredRevision: rootId, acceptanceRegisteredAt: now - 3_000,
      acceptanceCriteria: [{ id: 'verified', description: 'Target is verified.', toolName: 'Read',
        input: { file_path: '/fixture' }, checks: [{ path: '$text', equals: 'ok' }] }],
    }
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, validationGaps: ['verification missing'],
      recoveryDispatch: { schemaVersion: 1, id: oldDispatchId, attempt: 3,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt: now - 2_000,
        phase: 'started', startedAt: now - 1_500, preToolExecutionReceiptVersion: 1 },
    }
    managed.messages.push({ id: oldDispatchId, role: 'user', hidden: true, timestamp: now - 1_400,
      content: buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery, 'objective_incomplete', undefined, 3, managed.activeObjective,
      ) })
    managed.contextCompactionAttempt = { attemptedAt: now - 3_000, contextTokensBefore: 120_000,
      outcome: 'succeeded', objectiveRootId: rootId, hardLimitTokens: 100_000,
      providerContextBaselineTokens: 120_000, hardLimitFollowUpAttempted: true }
    managed.tokenUsage = { inputTokens: 1, outputTokens: 1, totalTokens: 2,
      contextTokens: 120_000, costUsd: 1 }
    managed.providerContextBoundaryMessageId = rootId
    managed.userInputRequests = [{ id: 'context-question', sessionId: managed.id,
      originWorkspaceId: h.workspace.id, objectiveUserMessageId: rootId,
      status: 'pending', createdAt: now - 1_000,
      hostPrompt: { schemaVersion: 1, kind: 'context-limit-next-step', objectiveId: rootId,
        recoveryDispatchId: oldDispatchId, issuedAt: now - 1_200 },
      questions: [{ id: 'context-limit-next-step',
        question: 'La limite sûre de contexte est atteinte et aucun transfert autonome borné ne peut être prouvé. Quelle suite souhaitez-vous ?',
        options: [{ id: 'provide-guidance', label: 'Préciser la reprise',
          description: 'Fournissez uniquement le fait ou le choix manquant pour reprendre avec un contexte neuf.', recommended: true },
        { id: 'stop-objective', label: 'Arrêter cette mission',
          description: 'Conserver les résultats actuels sans nouvel appel fournisseur.' }] }],
    }]
    await h.save(managed)
    const previousObjective = structuredClone(managed.activeObjective)
    const previousRecovery = structuredClone(managed.pendingTurnRecovery)
    const originalFlush = h.manager.flushSession.bind(h.manager)
    let flushes = 0
    h.manager.flushSession = async id => {
      if (++flushes === 1) throw new Error('Fixture clean Retry first fsync failure')
      await originalFlush(id)
    }

    await expect(h.manager.retryTurn(managed.id, rootId))
      .rejects.toThrow('Fixture clean Retry first fsync failure')

    expect(flushes).toBeGreaterThanOrEqual(2)
    expect(managed.isProcessing).toBe(false)
    expect(managed.activeObjective).toEqual(previousObjective)
    expect(managed.pendingTurnRecovery).toEqual(previousRecovery)
    expect(managed.providerContextBoundaryMessageId).toBe(rootId)
    expect(managed.userInputRequests).toEqual([expect.objectContaining({
      id: 'context-question', status: 'pending', answeredAt: undefined,
    })])
    expect(managed.messages.some(message => message.content.includes('<host_clean_recovery_continuation'))).toBe(false)
    const rows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(rows[0].providerContextBoundaryMessageId).toBe(rootId)
    expect(rows[0].userInputRequests[0]).toMatchObject({ id: 'context-question', status: 'pending' })
    expect(rows.some(row => row.type === 'user'
      && row.content?.includes('<host_clean_recovery_continuation'))).toBe(false)
  })
});
