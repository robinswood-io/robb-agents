import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { assertRetryTurnAnchor as policyAssertRetryTurnAnchor } from "./SessionManager/policy.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  for (const variant of ['user-input', 'automatic-recovery'] as const) {
    it(`keeps the distinct generic allocation when ${variant} crashes between complete and accepted-fence clear`, async () => {
      const h = harness(); const managed = h.make(`provider-complete-seam-${variant}`)
      const consumedId = `${managed.id}-consumed`
      const genericId = `${managed.id}-generic`
      const consumed: Managed['messages'][number] = {
        id: consumedId,
        role: 'user',
        content: `EXACT_${variant.toUpperCase()}_CONTENT_MUST_NOT_REPLAY`,
        timestamp: 2,
        hidden: true,
        providerDispatch: {
          schemaVersion: 1,
          state: 'accepted',
          messageId: consumedId,
          objectiveId: managed.activeObjective!.objectiveId!,
          objectiveUserMessageId: managed.activeObjective!.userMessageId,
          generation: 2,
          cancellationEpoch: 0,
          markedAt: Date.now(),
          acceptedAt: Date.now() + 1,
        },
        ...(variant === 'user-input' ? {
          internalOrigin: { kind: 'user-input' as const },
        } : {}),
      }
      managed.messages.push(consumed)
      if (variant === 'user-input') {
        const questions = [{
          id: 'scope', question: 'Which saved scope remains authorized?',
          options: [{ id: 'same', label: 'The same scope' }],
        }]
        const answers = [{ questionId: 'scope', optionIds: ['same'] }]
        consumed.content = USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({
          requestId: `${managed.id}-question`, questions, answers,
        })
        managed.userInputRequests = [{
          id: `${managed.id}-question`, sessionId: managed.id,
          originWorkspaceId: h.workspace.id,
          objectiveUserMessageId: managed.activeObjective!.userMessageId,
          status: 'answered', createdAt: 2, answeredAt: 3,
          questions, answers, responseMessageId: consumedId,
        }]
      }
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        userMessageId: variant === 'user-input'
          ? consumedId : managed.pendingTurnRecovery!.userMessageId,
        attempts: 3,
        lastAttemptAt: Date.now(),
        lastCause: 'stream_ended',
        continuationRequired: false,
        recoveryDispatch: {
          schemaVersion: 1,
          id: genericId,
          attempt: 3,
          cause: 'stream_ended',
          origin: 'automatic',
          allocatedAt: Date.now(),
          phase: 'allocated',
          preToolExecutionReceiptVersion: 1,
        },
      }
      const genericPrompt = buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery,
        'stream_ended',
        undefined,
        3,
        undefined, // Native recovery keeps objective tracking in the bounded host scope.
      )
      managed.messageQueue.push({
        message: genericPrompt,
        options: {
          hidden: true,
          automaticRecovery: {
            originalUserMessageId: managed.pendingTurnRecovery.userMessageId,
            cause: 'stream_ended',
            dispatchId: genericId,
            dispatchAttempt: 3,
            dispatchOrigin: 'automatic',
            dispatchAllocatedAt: managed.pendingTurnRecovery.recoveryDispatch!.allocatedAt,
          },
        },
      })
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      const prompts: string[] = []
      const providerHandoff = deferred()
      const releaseCompletion = deferred()
      const runtimeAgent = completeSessionAgentFixture(h.workspace, {
        onProviderHandoff: null as (() => void) | null,
        onBeforeProviderDispatch: null as (() => Promise<void>) | null,
        onProviderDispatchRejected: null as (() => void) | null,
        onProviderDispatchUncertain: null as (() => void) | null,
        getModel: () => 'fixture-model', getSessionId: () => null,
        setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: async () => {},
        async *chat(message: string): ReturnType<ScriptedSessionAgent['chat']> {
          prompts.push(message)
          await runtimeAgent.onBeforeProviderDispatch?.()
          runtimeAgent.onProviderHandoff?.()
          providerHandoff.resolve()
          await releaseCompletion.promise
          yield { type: 'text_complete' as const, text: 'Recovered generically.', isIntermediate: false }
          yield { type: 'complete' as const }
        },
      })
      cold.runtime.getOrCreateAgent = async () => {
        restored.agent = runtimeAgent as never
        return runtimeAgent
      }
      await cold.runtime.ensureMessagesLoaded(restored)
      await cold.manager.flushSession(restored.id); await tick(); await tick()
      if (!prompts.length) await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      for (let attempt = 0; attempt < 100 && prompts.length === 0; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      await providerHandoff.promise

      try {
        expect(prompts).toHaveLength(1)
        expect(prompts[0]?.startsWith(genericPrompt)).toBe(true)
        expect(prompts[0]).not.toBe(consumed.content)
        expect(prompts[0]).not.toContain(consumed.content)
        expect(restored.pendingTurnRecovery?.recoveryDispatch?.id).toBe(genericId)
        expect(restored.messages.find((message: Managed['messages'][number]) => message.id === consumedId)?.providerDispatch)
          .toBeUndefined()
        if (variant === 'user-input') {
          expect(restored.messages.find((message: Managed['messages'][number]) => message.id === consumedId))
            .toMatchObject({ hidden: true, isQueued: false, internalOrigin: { kind: 'user-input' } })
        } else {
          expect(restored.messages.some((message: Managed['messages'][number]) => message.id === consumedId))
            .toBe(false)
        }
      } finally {
        releaseCompletion.resolve()
      }
      for (let attempt = 0; attempt < 100 && restored.isProcessing; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      expect(restored.pendingTurnRecovery).toBeUndefined()
    })
  }

  it('advances a structured-answer recovery identity and budget across repeated ACK-before-output crashes', async () => {
    const h = harness(); const managed = h.make('provider-user-input-multi-crash')
    const requestId = `${managed.id}-question`
    const answerId = `${managed.id}-answer`
    const questions = [{
      id: 'scope', question: 'Which saved scope remains authorized?',
      options: [{ id: 'same', label: 'The same scope' }],
    }]
    const answers = [{ questionId: 'scope', optionIds: ['same'] }]
    const answerContent = USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({
      requestId, questions, answers,
    })
    managed.messages.push({
      id: answerId, role: 'user', timestamp: 2, hidden: true,
      internalOrigin: { kind: 'user-input' }, content: answerContent,
      providerDispatch: {
        schemaVersion: 1, state: 'accepted', messageId: answerId,
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        generation: 2, cancellationEpoch: 0,
        markedAt: Date.now(), acceptedAt: Date.now() + 1,
      },
    })
    managed.userInputRequests = [{
      id: requestId, sessionId: managed.id, originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      status: 'answered', createdAt: 2, answeredAt: 3,
      questions, answers, responseMessageId: answerId,
    }]
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, userMessageId: answerId,
      attempts: 2,
      recoveryDispatch: {
        schemaVersion: 1, id: answerId, attempt: 2,
        cause: 'objective_incomplete', origin: 'automatic', allocatedAt: 2,
        phase: 'started', startedAt: 3, preToolExecutionReceiptVersion: 1,
      },
    }
    await h.save(managed)

    const firstCold = h.cold(); const first = requiredTestValue(sessionRuntimeStateForTest(firstCold.runtime).sessions.get(managed.id))
    const firstAck = deferred(); const releaseFirst = deferred()
    const firstPrompts: string[] = []
    const firstAgent = completeSessionAgentFixture(h.workspace, {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true,
      forceAbort: () => { releaseFirst.resolve() }, dispose: async () => { releaseFirst.resolve() },
      async *chat(message: string): ReturnType<ScriptedSessionAgent['chat']> {
        firstPrompts.push(message)
        await firstAgent.onBeforeProviderDispatch?.()
        firstAgent.onProviderHandoff?.()
        firstAck.resolve()
        await releaseFirst.promise
        yield { type: 'complete' as const }
      },
    })
    firstCold.runtime.getOrCreateAgent = async () => {
      first.agent = firstAgent as never
      return firstAgent
    }
    await firstCold.runtime.ensureMessagesLoaded(first)
    await firstAck.promise
    await firstCold.manager.flushSession(first.id)
    const firstDispatch = structuredClone(first.pendingTurnRecovery?.recoveryDispatch)

    const secondCold = h.cold(); const second = requiredTestValue(sessionRuntimeStateForTest(secondCold.runtime).sessions.get(managed.id))
    const secondPrompts: string[] = []
    const releaseSecond = deferred()
    const secondAgent = completeSessionAgentFixture(h.workspace, {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: async () => {},
      async *chat(message: string): ReturnType<ScriptedSessionAgent['chat']> {
        secondPrompts.push(message)
        await secondAgent.onBeforeProviderDispatch?.()
        secondAgent.onProviderHandoff?.()
        await releaseSecond.promise
        yield { type: 'text_complete' as const, text: 'Recovered after the second host start.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    secondCold.runtime.getOrCreateAgent = async () => {
      second.agent = secondAgent as never
      return secondAgent
    }
    await secondCold.runtime.ensureMessagesLoaded(second)
    await secondCold.manager.flushSession(second.id); await tick(); await tick()
    if (!secondPrompts.length) await secondCold.runtime.resumePendingTurnAfterRestart(second.id)
    for (let attempt = 0; attempt < 100 && secondPrompts.length === 0; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }

    expect(firstPrompts).toHaveLength(1)
    expect(secondPrompts).toHaveLength(1)
    expect(firstPrompts[0]).not.toContain(answerContent)
    expect(secondPrompts[0]).not.toContain(answerContent)
    expect(secondPrompts[0]).not.toBe(firstPrompts[0])
    expect(firstDispatch).toMatchObject({ cause: 'app_restart', origin: 'restart', attempt: 3 })
    expect(second.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
      cause: 'app_restart', origin: 'restart', attempt: 4,
    })
    expect(second.pendingTurnRecovery?.recoveryDispatch?.id).not.toBe(firstDispatch?.id)
    expect(second.pendingTurnRecovery?.attempts).toBe(4)
    expect(second.pendingTurnRecovery!.attempts).toBeLessThanOrEqual(8)

    releaseSecond.resolve()
    for (let attempt = 0; attempt < 100 && second.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    releaseFirst.resolve()
    for (let attempt = 0; attempt < 100 && first.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
  })

  for (const backend of ['Pi', 'Claude'] as const) {
    it(`completes local /compact through ${backend} without WAL, recovery, or objective replacement`, async () => {
      const h = harness(); const managed = h.make(`local-compact-${backend.toLowerCase()}`)
      const objectiveBefore = structuredClone(managed.activeObjective)
      const recoveryBefore = structuredClone(managed.pendingTurnRecovery)
      let sessionCompletions = 0
      h.manager.onSessionComplete(() => { sessionCompletions++ })
      let sawWriteAheadHook = false
      let sawHandoffHook = false
      const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
        onProviderHandoff: null as (() => void) | null,
        onBeforeProviderDispatch: null as (() => Promise<void>) | null,
        onProviderDispatchRejected: null as (() => void) | null,
        onProviderDispatchUncertain: null as (() => void) | null,
        getModel: () => `${backend.toLowerCase()}-fixture`, getSessionId: () => null,
        setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: async () => {},
        async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
          sawWriteAheadHook = runtimeAgent.onBeforeProviderDispatch !== null
          sawHandoffHook = runtimeAgent.onProviderHandoff !== null
          yield { type: 'info' as const, message: 'Compacted context to fit within limits' }
          yield { type: 'complete' as const }
        },
      })
      h.runtime.getOrCreateAgent = async () => {
        managed.agent = runtimeAgent
        return runtimeAgent
      }

      await h.manager.sendMessage(managed.id, '/compact\nPreserve the verified deployment evidence.')
      await h.manager.flushSession(managed.id)

      expect(sawWriteAheadHook).toBe(false)
      expect(sawHandoffHook).toBe(false)
      expect(managed.messages.some(message => !!message.providerDispatch)).toBe(false)
      expect(managed.messages.some(message => message.role === 'user'
        && message.content.startsWith('/compact'))).toBe(false)
      expect(managed.activeObjective).toEqual(objectiveBefore)
      expect(managed.pendingTurnRecovery).toEqual(recoveryBefore)
      expect(policyAssertRetryTurnAnchor(managed, objectiveBefore!.userMessageId).id)
        .toBe(objectiveBefore!.userMessageId)
      expect(sessionCompletions).toBe(0)
      expect(managed.messageQueue).toEqual([])
      expect(managed.isProcessing).toBe(false)
      expect(h.events.some(event => event.type === 'typed_error'
        && event.error?.title === 'Provider acceptance requires confirmation')).toBe(false)
      expect(managed.messages.filter(message => message.hidden
        && message.content.includes('<automatic_turn_recovery>'))).toEqual([])
    })
  }
});
