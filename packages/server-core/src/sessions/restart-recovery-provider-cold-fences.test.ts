import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createPendingTurnRecovery } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  for (const state of ['acceptance-unknown', 'accepted'] as const) {
    for (const variant of ['human', 'clean-retry', 'source-activation', 'agent-delivery'] as const) {
      it(`atomically replaces a cold ${state} ${variant} prompt with one generic continuation`, async () => {
      const h = harness()
      const managed = h.make(`provider-unknown-${variant}`)
      const objectiveBefore = structuredClone(managed.activeObjective)
      let dispatch = managed.messages[0]!
      if (variant !== 'human') {
        dispatch = {
          id: `provider-unknown-${variant}-dispatch`,
          role: 'user',
          content: `Preserved ${variant} dispatch`,
          timestamp: 2,
          hidden: true,
          ...(variant === 'source-activation' ? {
            internalOrigin: {
              kind: 'source-activation' as const,
              objectiveId: managed.activeObjective!.objectiveId!,
              objectiveRevision: managed.activeObjective!.userMessageId,
              sourceSlug: 'fixture-source',
              sourceActivationId: 'fixture-activation',
            },
          } : {}),
          ...(variant === 'agent-delivery' ? {
            internalOrigin: {
              kind: 'agent-message' as const,
              senderSessionId: 'fixture-child',
              deliveryId: 'fixture-delivery',
              agentMessageType: 'result' as const,
            },
            agentDelivery: { id: 'fixture-delivery', status: 'processing' as const, attempts: 1 },
          } : {}),
        }
        managed.messages.push(dispatch)
      }
      if (variant === 'clean-retry') {
        managed.pendingTurnRecovery = {
          ...managed.pendingTurnRecovery!,
          recoveryDispatch: {
            schemaVersion: 1,
            id: dispatch.id,
            attempt: 3,
            cause: 'user_retry',
            origin: 'retry',
            allocatedAt: 2,
            phase: 'started',
            startedAt: 3,
            preToolExecutionReceiptVersion: 1,
            cleanContinuationId: 'clean-continuation',
          },
        }
      }
      dispatch.providerDispatch = {
        schemaVersion: 1,
        state,
        messageId: dispatch.id,
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        generation: 7,
        cancellationEpoch: 2,
        markedAt: Date.now(),
        ...(state === 'accepted' ? { acceptedAt: Date.now() + 1 } : {}),
      }
      await h.save(managed)

      const cold = h.cold()
      const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      let providerStarts = 0
      let automaticContinuations = 0
      cold.runtime.getOrCreateAgent = async () => {
        providerStarts++
        throw new Error('the exact provider dispatch must not start automatically')
      }
      cold.runtime.enqueueAutomaticTurnRecovery = async (_session: Managed, cause: string) => {
        automaticContinuations++
        expect(cause).toBe('app_restart')
        return true
      }
      await cold.runtime.ensureMessagesLoaded(restored)
      await cold.manager.flushSession(restored.id)
      await tick(); await tick(); await tick()
      if (automaticContinuations === 0) {
        await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      }

      const restoredDispatch = restored.messages.find((message: Managed['messages'][number]) => (
        message.id === dispatch.id
      ))
      expect(providerStarts).toBe(0)
      if (variant === 'clean-retry') expect(restoredDispatch).toBeUndefined()
      else expect(restoredDispatch?.providerDispatch).toBeUndefined()
      expect(restored.activeObjective).toEqual(objectiveBefore)
      expect(restored.messageQueue.some((item: Managed['messageQueue'][number]) => (
        item.messageId === dispatch.id
      ))).toBe(false)
      if (variant === 'agent-delivery') {
        expect(restoredDispatch).toMatchObject({
          isQueued: false,
          agentDelivery: { status: 'processed', attempts: 1 },
        })
      }
      expect(automaticContinuations).toBe(1)
      expect(h.events.some(event => (
        event.type === 'typed_error'
        && event.sessionId === managed.id
        && event.error?.title === 'Provider dispatch requires reconciliation'
      ))).toBe(false)
      const storedRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line))
      expect(storedRows.some(row => row.providerDispatch?.state === state)).toBe(false)
      })
    }
  }

  it('retires an accepted old objective while reconciling the current unknown dispatch once', async () => {
    const h = harness(); const managed = h.make('provider-old-accepted-current-unknown')
    const old = managed.messages[0]!
    old.providerDispatch = {
      schemaVersion: 1, state: 'accepted', messageId: old.id,
      objectiveId: old.id, objectiveUserMessageId: old.id,
      generation: 1, cancellationEpoch: 0, markedAt: 10, acceptedAt: 11,
    }
    const current: Managed['messages'][number] = { id: 'current-human-root', role: 'user' as const,
      content: 'Continue the new objective.', timestamp: 20 }
    managed.messages.push(current)
    managed.activeObjective = {
      ...managed.activeObjective!, objectiveId: current.id, userMessageId: current.id,
      originalText: current.content, startedAt: current.timestamp,
    }
    managed.pendingTurnRecovery = { ...createPendingTurnRecovery(current.id), attempts: 1 }
    current.providerDispatch = {
      schemaVersion: 1, state: 'acceptance-unknown', messageId: current.id,
      objectiveId: current.id, objectiveUserMessageId: current.id,
      generation: 2, cancellationEpoch: 0, markedAt: Date.now(),
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let continuations = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async (_managed: Managed, cause: string) => {
      continuations++; expect(cause).toBe('app_restart'); return true
    }
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id); await tick(); await tick()
    if (!continuations) await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(continuations).toBe(1)
    expect(restored.messages.find((message: Managed['messages'][number]) => message.id === old.id)?.providerDispatch)
      .toBeUndefined()
    expect(restored.messages.find((message: Managed['messages'][number]) => message.id === current.id)?.providerDispatch)
      .toBeUndefined()
    expect(restored.pendingTurnRecovery).toMatchObject({ userMessageId: current.id, lastCause: 'app_restart' })
  })

  it('retires an old uncertain prompt as an inert tombstone before resuming a later human objective', async () => {
    const h = harness(); const managed = h.make('provider-old-unknown-new-human')
    const old = managed.messages[0]!
    old.providerDispatch = {
      schemaVersion: 1, state: 'acceptance-unknown', messageId: old.id,
      objectiveId: old.id, objectiveUserMessageId: old.id,
      generation: 1, cancellationEpoch: 0, markedAt: 10,
    }
    const current: Managed['messages'][number] = { id: 'new-human-root', role: 'user' as const,
      content: 'Start a distinct objective.', timestamp: 20 }
    managed.messages.push(current)
    managed.activeObjective = {
      ...managed.activeObjective!, objectiveId: current.id, userMessageId: current.id,
      originalText: current.content, startedAt: current.timestamp,
    }
    managed.pendingTurnRecovery = { ...createPendingTurnRecovery(current.id), attempts: 1 }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let continuations = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { continuations++; return true }
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id); await tick(); await tick()
    if (!continuations) await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(continuations).toBe(1)
    expect(restored.messages.find((message: Managed['messages'][number]) => message.id === old.id)?.providerDispatch)
      .toMatchObject({
        state: 'retired-uncertain',
        retirementReason: 'superseded-by-new-human-objective',
        retiredAt: expect.any(Number),
      })
  })

  it('durably consumes an exact cold unknown but defers its generic continuation behind a question', async () => {
    const h = harness(); const managed = h.make('provider-unknown-pending-question')
    const dispatch = managed.messages[0]!
    dispatch.providerDispatch = {
      schemaVersion: 1, state: 'acceptance-unknown', messageId: dispatch.id,
      objectiveId: dispatch.id, objectiveUserMessageId: dispatch.id,
      generation: 1, cancellationEpoch: 0, markedAt: Date.now(),
    }
    managed.userInputRequests = [{ status: 'pending', sessionId: managed.id }] as never
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let continuations = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { continuations++; return true }
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id); await tick(); await tick()

    expect(restored.messages[0]?.providerDispatch).toBeUndefined()
    expect(restored.pendingTurnRecovery).toMatchObject({ lastCause: 'app_restart', continuationRequired: true })
    expect(continuations).toBe(0)
  })

  for (const state of ['acceptance-unknown', 'accepted'] as const) {
    it(`keeps a consumed ${state} structured answer as provenance while resuming generically`, async () => {
      const h = harness(); const managed = h.make(`provider-${state}-user-input-cold`)
      const requestId = `${managed.id}-question`
      const answerId = `${managed.id}-answer`
      const questions = [{
        id: 'scope', question: 'Which saved scope remains authorized?',
        options: [{ id: 'same', label: 'The same scope' }],
      }]
      const answers = [{ questionId: 'scope', optionIds: ['same'] }]
      const answer: Managed['messages'][number] = {
        id: answerId, role: 'user', timestamp: 2, hidden: true,
        internalOrigin: { kind: 'user-input' },
        content: USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({ requestId, questions, answers }),
        providerDispatch: {
          schemaVersion: 1, state, messageId: answerId,
          objectiveId: managed.activeObjective!.objectiveId!,
          objectiveUserMessageId: managed.activeObjective!.userMessageId,
          generation: 2, cancellationEpoch: 0, markedAt: Date.now(),
          ...(state === 'accepted' ? { acceptedAt: Date.now() + 1 } : {}),
        },
      }
      managed.messages.push(answer)
      managed.userInputRequests = [{
        id: requestId, sessionId: managed.id, originWorkspaceId: h.workspace.id,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        status: 'answered', createdAt: 2, answeredAt: 3, questions, answers,
        responseMessageId: answerId,
      }]
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!, userMessageId: answerId,
        recoveryDispatch: {
          schemaVersion: 1, id: answerId, attempt: 2, cause: 'objective_incomplete',
          origin: 'automatic', allocatedAt: 2, phase: 'started', startedAt: 3,
          preToolExecutionReceiptVersion: 1,
        },
      }
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      const prompts: string[] = []
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
          await releaseCompletion.promise
          yield { type: 'text_complete' as const, text: 'Reconciled the saved answer.', isIntermediate: false }
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

      expect(prompts).toHaveLength(1)
      expect(prompts[0]).not.toBe(answer.content)
      expect(prompts[0]).not.toContain(answer.content)
      expect(prompts[0]).toContain('<automatic_turn_recovery')
      for (let attempt = 0; attempt < 100 && restored.messages.find(
        (message: Managed['messages'][number]) => message.id === answerId,
      )?.providerDispatch; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      expect(restored.messages.find((message: Managed['messages'][number]) => message.id === answerId))
        .toMatchObject({ hidden: true, isQueued: false, internalOrigin: { kind: 'user-input' } })
      expect(restored.messages.find((message: Managed['messages'][number]) => message.id === answerId)?.providerDispatch)
        .toBeUndefined()
      expect(restored.messageQueue.some((item: Managed['messageQueue'][number]) => item.messageId === answerId))
        .toBe(false)
      expect(restored.pendingTurnRecovery).toMatchObject({
        userMessageId: answerId,
        attempts: 3,
        lastCause: 'app_restart',
        recoveryDispatch: {
          cause: 'app_restart', origin: 'restart', attempt: 3,
        },
      })
      expect(restored.pendingTurnRecovery?.recoveryDispatch?.id).not.toBe(answerId)
      releaseCompletion.resolve()
      for (let attempt = 0; attempt < 100 && restored.isProcessing; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      expect(restored.pendingTurnRecovery).toBeUndefined()
    })
  }
});
