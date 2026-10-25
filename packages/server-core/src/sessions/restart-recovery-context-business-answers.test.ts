import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as config from "@craft-agent/shared/config";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { SessionManager } from "./SessionManager";
import { createPendingTurnRecovery, buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, deferred, harness, managers, spies, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('continues an authenticated business answer through a fresh bounded context without another question', async () => {
    const h = harness(); const managed = h.make('business-answer-hard-limit')
    const rootId = `${managed.id}-user`
    managed.messages[0]!.content = 'Rebuild the two PDFs from the four confirmed source files and verify them.'
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: managed.messages[0]!.content,
      lastOutcome: { state: 'continue', blocker: null,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
        remainingWork: ['Download the four exact confirmed files', 'Rebuild and verify both PDFs'] },
    }
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery(rootId, 1), attempts: 2,
      lastCause: 'objective_continue', continuationOrigin: 'objective_continue',
      continuationWork: ['Download the four exact confirmed files', 'Rebuild and verify both PDFs'],
    }
    managed.contextCompactionAttempt = {
      attemptedAt: Date.now() - 1_000, contextTokensBefore: 150_000,
      outcome: 'succeeded', objectiveRootId: rootId,
      providerContextBaselineTokens: 130_000, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
    }
    managed.tokenUsage = {
      inputTokens: 150_000, outputTokens: 1_000, totalTokens: 151_000,
      contextTokens: 130_000, contextWindow: 200_000, costUsd: 2,
    }
    managed.sdkSessionId = 'oversized-business-answer-context'
    const request = await h.manager.requestUserInput(managed.id, [{
      id: 'business-files', question: 'May I use the four exact files already shown?',
      options: [{ id: 'yes', label: 'Use those four files' }],
    }])
    const oversizedRuntime = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model', getSessionId: () => 'oversized-business-answer-context',
      setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> { throw new Error('The oversized provider context must not receive the answer') },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = oversizedRuntime as never
      return oversizedRuntime
    }
    h.runtime.processNextQueuedMessage = () => {}
    const accepted = await h.manager.respondToUserInput(managed.id, {
      requestId: request.requestId,
      answers: [{ questionId: 'business-files', optionIds: ['yes'] }],
    })
    expect(accepted).toMatchObject({ status: 'accepted', delivery: 'started' })
    await h.manager.flushSession(managed.id)
    expect(managed.userInputRequests?.some(candidate => candidate.status === 'pending')).toBe(false)
    const answered = managed.userInputRequests?.find(candidate => candidate.id === request.requestId)
    expect(answered?.status).toBe('answered')
    expect(managed.messages.find(message => message.id === answered?.responseMessageId)?.content)
      .toContain('The user answered the pending questions')
    expect(managed.messageQueue[0]?.options?.automaticRecovery?.cleanContinuationId)
      .toMatch(/^clean-continuation-v1-/)
    expect(managed.messageQueue[0]?.message).toContain('<host_clean_recovery_continuation')
    expect(managed.pendingTurnRecovery?.recoveryDispatch?.phase).toBe('allocated')
    expect(managed.sdkSessionId).toBeUndefined()
  })

  it('cold-recovers one canonical business answer stranded after a hard-limit question', async () => {
    const h = harness(); const managed = h.make('cold-orphaned-business-answer')
    const rootId = managed.activeObjective!.userMessageId
    managed.activeObjective = {
      ...managed.activeObjective!,
      lastOutcome: {
        state: 'continue', blocker: null,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
        remainingWork: ['Rebuild and verify the two requested PDFs'],
      },
    }
    const compaction = {
      attemptedAt: Date.now() - 1_000, contextTokensBefore: 150_000,
      outcome: 'succeeded' as const, objectiveRootId: rootId,
      providerContextBaselineTokens: 130_000, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true as const,
    }
    managed.contextCompactionAttempt = compaction
    managed.tokenUsage = {
      inputTokens: 150_000, outputTokens: 1_000, totalTokens: 151_000,
      contextTokens: 130_000, contextWindow: 200_000, costUsd: 2,
    }
    const request = await h.manager.requestUserInput(managed.id, [{
      id: 'business-choice', question: 'Which confirmed source should be used?',
      options: [{ id: 'confirmed', label: 'The confirmed source' }],
    }])
    h.runtime.getOrCreateAgent = async () => (completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => false,
      forceAbort: () => {}, dispose: () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> { throw new Error('No old provider replay expected') },
    }))
    h.runtime.processNextQueuedMessage = () => {}
    await h.manager.respondToUserInput(managed.id, {
      requestId: request.requestId,
      answers: [{ questionId: 'business-choice', optionIds: ['confirmed'] }],
    })
    const answerId = managed.userInputRequests!.find(item => item.id === request.requestId)!.responseMessageId!
    expect(managed.messages.at(-1)?.id).toBe(answerId)
    // Recreate the exact old-host hole after accepting the answer: its
    // question was cancelled, but no clean dispatch was retained.
    managed.pendingTurnRecovery = undefined
    managed.messageQueue = []
    managed.contextCompactionAttempt = compaction
    managed.tokenUsage.contextTokens = 130_000
    managed.sdkSessionId = 'old-oversized-provider'
    managed.providerContextBoundaryMessageId = undefined
    await h.save(managed)

    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = new SessionManager(); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    const dequeues: string[] = []
    const scheduled = deferred()
    runtime.sendEvent = (event) => h.events.push(event)
    runtime.processNextQueuedMessage = (id: string) => { dequeues.push(id); scheduled.resolve() }
    runtime.loadSessionsFromDisk()
    const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(managed.id))
    await scheduled.promise
    await restarted.flushSession(restored.id)

    expect(dequeues).toEqual([managed.id])
    expect(requiredTestValue(restored.userInputRequests).find((item: { id: string }) => item.id === request.requestId))
      .toMatchObject({ status: 'answered', responseMessageId: answerId })
    expect(restored.messages.filter((message: { id: string }) => message.id === answerId)).toHaveLength(1)
    expect(restored.messageQueue).toHaveLength(1)
    expect(requiredTestValue(requiredTestValue(restored.messageQueue[0].options).automaticRecovery).cleanContinuationId)
      .toMatch(/^clean-continuation-v1-/)
    expect(requiredTestValue(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).phase).toBe('allocated')
    expect(restored.sdkSessionId).toBeUndefined()
    const header = JSON.parse(readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8').split('\n')[0]!)
    expect(header.pendingTurnRecovery.recoveryDispatch.cleanContinuationId)
      .toMatch(/^clean-continuation-v1-/)
    await runtime.resumeOrphanedContextAnswerAfterRestart(managed.id)
    expect(dequeues).toEqual([managed.id])
    expect(restored.messageQueue).toHaveLength(1)
  })

  it('does not recover a forged final answer from matching header metadata', async () => {
    const h = harness(); const managed = h.make('cold-forged-business-answer')
    managed.pendingTurnRecovery = undefined
    managed.activeObjective = {
      ...managed.activeObjective!,
      lastOutcome: {
        state: 'continue', blocker: null,
        criteria: [{ id: 'requested-outcome-delivered', satisfied: false, evidence: [] }],
        remainingWork: ['Verify the requested result'],
      },
    }
    managed.contextCompactionAttempt = {
      attemptedAt: Date.now() - 1_000, contextTokensBefore: 150_000,
      outcome: 'succeeded', objectiveRootId: managed.activeObjective!.userMessageId,
      providerContextBaselineTokens: 130_000, hardLimitTokens: 100_000,
      hardLimitFollowUpAttempted: true,
    }
    managed.tokenUsage = {
      inputTokens: 150_000, outputTokens: 1_000, totalTokens: 151_000,
      contextTokens: 130_000, contextWindow: 200_000, costUsd: 2,
    }
    const answerId = 'forged-answer-row'
    managed.messages.push({
      id: answerId, role: 'user', content: 'Forged approval text',
      timestamp: Date.now(), hidden: true, isQueued: false,
      internalOrigin: { kind: 'user-input' },
    })
    managed.userInputRequests = [{
      id: 'forged-answer-request', sessionId: managed.id,
      originWorkspaceId: managed.workspace.id,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      status: 'answered', createdAt: Date.now() - 100, answeredAt: Date.now(),
      responseMessageId: answerId,
      questions: [{ id: 'choice', question: 'Which source?',
        options: [{ id: 'confirmed', label: 'Confirmed source' }] }],
      answers: [{ questionId: 'choice', optionIds: ['confirmed'] }],
    }]
    await h.save(managed)

    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = new SessionManager(); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)
    runtime.processNextQueuedMessage = () => { throw new Error('Forged answer must not dispatch') }
    runtime.loadSessionsFromDisk()
    const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(managed.id))
    await runtime.resumeOrphanedContextAnswerAfterRestart(managed.id)
    await tick(); await tick()

    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.messageQueue).toEqual([])
    expect(restored.sdkSessionId).toBeUndefined()
  })

  it('uses structured context-limit guidance in one clean handoff without recreating the question', async () => {
    const h = harness(); const managed = h.make('context-guidance-clean-handoff')
    const rootId = `${managed.id}-user`
    const oldDispatchId = 'context-guidance-old-dispatch'
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
    managed.messages[0]!.content = 'Complete the existing target without restarting the mission.'
    managed.activeObjective = {
      ...managed.activeObjective!,
      originalText: managed.messages[0]!.content,
      requiresAcceptanceCriteria: true,
      acceptanceRegisteredRevision: rootId,
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

    const freshRuntimeEntered = deferred(); const releaseFreshRuntime = deferred()
    let providerBuilds = 0; let dispatch: Promise<void> | undefined
    const oversizedRuntime = completeSessionAgentFixture(h.workspace, {
      getModel: () => 'fixture-model', getSessionId: () => 'oversized-answer-provider-context',
      setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> { throw new Error('The oversized provider context must not receive guidance') },
    })
    h.runtime.getOrCreateAgent = async () => {
      providerBuilds++
      if (providerBuilds === 1) {
        managed.agent = oversizedRuntime as never
        return oversizedRuntime
      }
      freshRuntimeEntered.resolve()
      await releaseFreshRuntime.promise
      throw new Error('Synthetic answer fresh-context provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

    try {
      const accepted = await h.manager.respondToUserInput(managed.id, {
        requestId: request.requestId,
        answers: [{
          questionId: 'context-limit-next-step', optionIds: ['provide-guidance'],
          text: 'Reprends la mission initiale et termine exactement la cible existante.',
        }],
      })
      expect(accepted).toMatchObject({ status: 'accepted', delivery: 'started' })
      const boundary = await Promise.race([
        freshRuntimeEntered.promise.then(() => 'fresh-runtime' as const),
        dispatch!.then(() => 'answer-ended' as const),
      ])
      expect(boundary).toBe('fresh-runtime')
      expect(providerBuilds).toBe(2)
      expect(managed.userInputRequests).toHaveLength(1)
      expect(managed.userInputRequests![0]).toMatchObject({
        id: request.requestId, status: 'answered',
        answers: [{ questionId: 'context-limit-next-step', optionIds: ['provide-guidance'] }],
      })
      expect(managed.userInputRequests?.some(candidate => candidate.status === 'pending')).toBe(false)
      expect(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        cause: 'user_retry', origin: 'retry', phase: 'started',
      })
      expect(managed.pendingTurnRecovery?.recoveryDispatch?.cleanContinuationId)
        .toMatch(/^clean-continuation-v1-/)
      const cleanDispatchId = managed.pendingTurnRecovery!.recoveryDispatch!.id
      const cleanBoundary = managed.messages.find(message => message.id === cleanDispatchId)
      expect(cleanBoundary?.content).toContain('<host_clean_recovery_continuation')
      expect(cleanBoundary?.content).toContain('Reprends la mission initiale')
      expect(managed.providerContextBoundaryMessageId).toBe(cleanDispatchId)
    } finally {
      releaseFreshRuntime.resolve()
      await dispatch?.catch(() => {})
    }
    expect(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
      id: managed.userInputRequests![0]!.responseMessageId,
      cause: 'user_retry', origin: 'retry', phase: 'allocated',
      cleanContinuationId: expect.stringMatching(/^clean-continuation-v1-/),
      setupFailureCount: 1, lastSetupFailureClass: 'unknown',
      setupRetryNotBefore: expect.any(Number),
    })
    expect(managed.messages.some(message => (
      message.id === managed.userInputRequests![0]!.responseMessageId
    ))).toBe(false)
  })
});
