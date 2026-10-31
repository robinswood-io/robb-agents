import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { sessionRuntimeStateForTest,requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach,describe,expect,it } from "bun:test";
import { readFileSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createAutonomyFallbackIntent } from "./autonomy-browser-fallback";
import { cleanupRestartRecovery,deferred,harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('atomically converts an allocated restart pass to a specialized fallback without spending another attempt', async () => {
    const h = harness(); const managed = h.make('restart-allocation-specialized')
    writeFileSync(join(h.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1, id: h.workspace.id, name: h.workspace.name,
      slug: 'restart-allocation-specialized', createdAt: 1, updatedAt: 1,
      automaticRoutingEnabled: true,
      automaticToolFallbackEnabled: true,
    }))
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed, 'app_restart', undefined, undefined, 'restart',
    )).toBe(true)
    const originalDispatch = structuredClone(managed.pendingTurnRecovery!.recoveryDispatch!)
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed,
      'runtime_error',
      undefined,
      undefined,
      undefined,
      createAutonomyFallbackIntent('structured_fallback', 'mcp__session__browser_tool'),
    )).toBe(true)
    expect(managed.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      lastCause: 'runtime_error',
      recoveryDispatch: {
        id: originalDispatch.id,
        attempt: originalDispatch.attempt,
        origin: 'restart',
        cause: 'runtime_error',
        phase: 'allocated',
        fallbackIntent: { kind: 'structured_fallback', failedToolName: 'mcp__session__browser_tool' },
      },
    })
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.message).toContain('<automatic_structured_fallback')
    expect(managed.messageQueue[0]?.options?.automaticRecovery).toMatchObject({
      cause: 'runtime_error', dispatchId: originalDispatch.id, dispatchOrigin: 'restart',
    })

    const expectedPrompt = managed.messageQueue[0]!.message
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      recoveryDispatch: {
        id: originalDispatch.id,
        attempt: originalDispatch.attempt,
        cause: 'runtime_error',
        origin: 'restart',
        phase: 'allocated',
      },
    })
    expect(restored.messageQueue).toHaveLength(1)
    expect(restored.messageQueue[0]?.message).toBe(expectedPrompt)
  })

  it('persists a unique Retry dispatch allocation before model preparation', async () => {
    const h = harness(); const managed = h.make('explicit-retry-dispatch')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 2,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'automatic-dispatch-2',
        attempt: 2,
        cause: 'objective_continue',
        origin: 'automatic',
        allocatedAt: Date.now() - 2_000,
        phase: 'started',
        startedAt: Date.now() - 1_900,
      },
    }
    const preparing = deferred(); const release = deferred()
    let preparations = 0; let persistedAtPreparation: ReturnType<typeof parseRecoveryJournalObservation>['pendingTurnRecovery']; let retryPrompt = ''; let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      preparations++
      persistedAtPreparation = parseRecoveryJournalObservation(
        readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8').split('\n')[0]!,
      ).pendingTurnRecovery
      preparing.resolve(); await release.promise
      throw new Error('Synthetic Retry provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => {
      retryPrompt = args[1]
      dispatch = send(...args)
      return dispatch
    }

    try {
      expect(await h.manager.retryTurn(managed.id, `${managed.id}-user`)).toEqual({ status: 'started' })
      await preparing.promise
      expect(preparations).toBe(1)
      expect(retryPrompt).toContain('attempt="3"')
      expect<unknown>(managed.pendingTurnRecovery).toMatchObject({
        attempts: 2,
        lastCause: 'user_retry',
        recoveryDispatch: {
          schemaVersion: 1,
          attempt: 3,
          cause: 'user_retry',
          origin: 'retry',
          phase: 'started',
          startedAt: (expect.any(Number) as unknown),
        },
      })
      expect(managed.pendingTurnRecovery?.recoveryDispatch?.id).not.toBe('automatic-dispatch-2')
      expect(requiredTestValue(persistedAtPreparation).recoveryDispatch).toEqual(managed.pendingTurnRecovery?.recoveryDispatch)
      expect(await h.manager.retryTurn(managed.id, `${managed.id}-user`)).toEqual({ status: 'already_running' })
      expect(preparations).toBe(1)
    } finally {
      release.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('opens the first hard-limit Retry in a clean context without asking for the objective again', async () => {
    const h = harness(); const managed = h.make('first-hard-limit-retry-clean-context')
    const rootId = `${managed.id}-user`
    managed.messages[0]!.content = 'Finish the existing implementation and verify the requested outcome.'
    managed.activeObjective = {
      ...managed.activeObjective!,
      originalText: managed.messages[0]!.content,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'],
    }
    managed.tokenUsage = {
      inputTokens: 120_000, outputTokens: 1_000, totalTokens: 121_000,
      contextTokens: 120_000, contextWindow: 200_000, costUsd: 2,
    }
    managed.sdkSessionId = 'oversized-provider-context'

    const freshRuntimeEntered = deferred(); const releaseFreshRuntime = deferred()
    let providerBuilds = 0; let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      providerBuilds++
      expect(managed.sdkSessionId).toBeUndefined()
      freshRuntimeEntered.resolve()
      await releaseFreshRuntime.promise
      throw new Error('Synthetic fresh-context provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

    try {
      expect(await h.manager.retryTurn(managed.id, rootId)).toEqual({ status: 'started' })
      const boundary = await Promise.race([
        freshRuntimeEntered.promise.then(() => 'fresh-runtime' as const),
        dispatch!.then(() => 'retry-ended' as const),
      ])
      expect(boundary).toBe('fresh-runtime')
      expect(providerBuilds).toBe(1)
      expect(managed.userInputRequests?.filter(request => request.status === 'pending') ?? []).toEqual([])
      expect<unknown>(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        cause: 'user_retry', origin: 'retry', phase: 'started',
        cleanContinuationId: (expect.stringMatching(/^clean-continuation-v1-/) as unknown),
      })
      const cleanDispatchId = managed.pendingTurnRecovery!.recoveryDispatch!.id
      const cleanBoundary = managed.messages.find(message => message.id === cleanDispatchId)
      expect(cleanBoundary).toMatchObject({ role: 'user', hidden: true })
      expect(cleanBoundary?.content).toContain('<host_clean_recovery_continuation')
      expect(cleanBoundary?.content).toContain(managed.messages[0]!.content)
      expect(managed.providerContextBoundaryMessageId).toBe(cleanDispatchId)
      expect(managed.sdkSessionId).toBeUndefined()
    } finally {
      releaseFreshRuntime.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('uses the visible objective for a hard-limit Retry despite an old malformed legacy answer', async () => {
    const h = harness(); const managed = h.make('visible-root-malformed-legacy-answer')
    const rootId = `${managed.id}-user`
    const legacyRequestId = 'old-legacy-business-question'
    const legacyAnswerId = 'old-malformed-legacy-answer'
    const objectiveText = 'Finish the preserved implementation, verify it, and report the exact result.'
    const legacyQuestions = [{
      id: 'environment', question: 'Which existing environment should be verified?',
      options: [{ id: 'staging', label: 'Staging' }],
    }]
    const legacyAnswers = [{ questionId: 'environment', optionIds: ['staging'] }]
    managed.messages[0]!.content = objectiveText
    managed.messages.push({
      id: legacyAnswerId, role: 'user', hidden: true, timestamp: 3,
      internalOrigin: { kind: 'user-input' },
      content: 'The user answered the pending questions. Apply these answers to the current objective without replacing it.\n'
        + '{"requestId":"old-legacy-business-question","answers":',
    })
    managed.activeObjective = {
      ...managed.activeObjective!, originalText: objectiveText,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'],
    }
    managed.userInputRequests = [{
      id: legacyRequestId, sessionId: managed.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: rootId, status: 'answered', createdAt: 2, answeredAt: 3,
      questions: legacyQuestions, answers: legacyAnswers, responseMessageId: legacyAnswerId,
    }]
    managed.tokenUsage = {
      inputTokens: 120_000, outputTokens: 1_000, totalTokens: 121_000,
      contextTokens: 120_000, contextWindow: 200_000, costUsd: 2,
    }
    managed.sdkSessionId = 'oversized-provider-context-with-malformed-answer'

    const freshRuntimeEntered = deferred(); const releaseFreshRuntime = deferred()
    let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => {
      expect(managed.sdkSessionId).toBeUndefined()
      freshRuntimeEntered.resolve()
      await releaseFreshRuntime.promise
      throw new Error('Synthetic malformed-answer fresh-context provider boundary')
    }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

    try {
      expect(await h.manager.retryTurn(managed.id, rootId)).toEqual({ status: 'started' })
      await freshRuntimeEntered.promise
      expect<unknown>(managed.userInputRequests).toEqual([(expect.objectContaining({
        id: legacyRequestId, status: 'answered', responseMessageId: legacyAnswerId,
      }) as unknown)])
      expect(managed.userInputRequests.some(request => request.status === 'pending')).toBe(false)
      expect<unknown>(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        cause: 'user_retry', origin: 'retry', phase: 'started',
        cleanContinuationId: (expect.stringMatching(/^clean-continuation-v1-/) as unknown),
      })
      const cleanDispatchId = managed.pendingTurnRecovery!.recoveryDispatch!.id
      const cleanBoundary = managed.messages.find(message => message.id === cleanDispatchId)
      expect(cleanBoundary?.content).toContain('<host_clean_recovery_continuation')
      expect(cleanBoundary?.content).toContain(objectiveText)
      expect(cleanBoundary?.content).not.toContain('old-legacy-business-question')
      expect(managed.messages.filter(message => (
        message.content.includes('La limite sûre de contexte est atteinte')
      ))).toEqual([])
    } finally {
      releaseFreshRuntime.resolve()
      await dispatch?.catch(() => {})
    }
  })
});
