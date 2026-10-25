import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  it('retires malformed and multiple provider receipts only on explicit Retry, then continues generically', async () => {
    const h = harness(); const managed = h.make('provider-malformed-multiple-retry')
    const anchor = managed.messages[0]!
    anchor.providerDispatch = {
      schemaVersion: 1,
      state: 'accepted',
      messageId: 'malformed-anchor-id',
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 1,
      cancellationEpoch: 0,
      markedAt: Date.now(),
      acceptedAt: Date.now() + 1,
    }
    const hiddenContent = 'EXACT_AMBIGUOUS_HIDDEN_PROVIDER_ENVELOPE'
    const hiddenId = `${managed.id}-hidden`
    managed.messages.push({
      id: hiddenId, role: 'user', hidden: true, content: hiddenContent, timestamp: 2,
      providerDispatch: {
        schemaVersion: 1,
        state: 'acceptance-unknown',
        messageId: hiddenId,
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        generation: 2,
        cancellationEpoch: 0,
        markedAt: Date.now() + 2,
      },
    })
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      recoveryDispatch: {
        schemaVersion: 1,
        id: hiddenId,
        attempt: 2,
        cause: 'runtime_error',
        origin: 'automatic',
        allocatedAt: Date.now(),
        phase: 'started',
        startedAt: Date.now() + 1,
        preToolExecutionReceiptVersion: 1,
      },
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    await cold.runtime.ensureMessagesLoaded(restored)
    await tick(); await tick()
    expect(cold.runtime.providerDispatchAdmissionBarrier(restored)).toBeDefined()

    const prompts: string[] = []
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
        yield { type: 'text_complete' as const, text: 'Reconciled the ambiguous receipt from current state.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    cold.runtime.getOrCreateAgent = async () => {
      restored.agent = runtimeAgent as never
      return runtimeAgent
    }
    await cold.manager.retryTurn(restored.id, anchor.id)
    for (let attempt = 0; attempt < 100 && prompts.length === 0; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 100 && restored.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toBe(anchor.content)
    expect(prompts[0]).toContain('<automatic_turn_recovery')
    expect(prompts[0]).not.toContain(hiddenContent)
    expect(restored.messages.some((message: Managed['messages'][number]) => (
      message.id === hiddenId || message.content === hiddenContent
    ))).toBe(false)
    expect(restored.pendingTurnRecovery?.recoveryDispatch?.id).not.toBe(hiddenId)
    expect(cold.runtime.providerDispatchAdmissionBarrier(restored)).toBeUndefined()
    expect(restored.messages.filter((message: Managed['messages'][number]) => (
      message.providerDispatch?.state === 'retired-uncertain'
      && message.providerDispatch.retirementReason === 'explicit-retry-reconciliation'
    ))).toHaveLength(2)

    const afterCrash = h.cold(); const afterCrashRestored = requiredTestValue(sessionRuntimeStateForTest(afterCrash.runtime).sessions.get(managed.id))
    let exactReplays = 0
    afterCrash.runtime.getOrCreateAgent = async () => {
      exactReplays++
      throw new Error('inert receipts must not replay after restart')
    }
    await afterCrash.runtime.ensureMessagesLoaded(afterCrashRestored)
    await tick(); await tick()
    expect(exactReplays).toBe(0)
    expect(afterCrashRestored.messages.some((message: Managed['messages'][number]) => (
      message.id === hiddenId || message.content === hiddenContent
    ))).toBe(false)
    expect(readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')).not.toContain(hiddenContent)
    expect(afterCrash.runtime.providerDispatchAdmissionBarrier(afterCrashRestored)).toBeUndefined()
  })

  it('does not roll a cold provider snapshot back over a concurrent explicit Stop', async () => {
    const h = harness(); const managed = h.make('provider-cold-fsync-stop-race')
    managed.messages[0]!.providerDispatch = {
      schemaVersion: 1,
      state: 'acceptance-unknown',
      messageId: managed.messages[0]!.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 1,
      cancellationEpoch: 0,
      markedAt: Date.now(),
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const entered = deferred(); const release = deferred()
    cold.manager.flushSessionDurably = async () => {
      entered.resolve()
      await release.promise
      throw new Error('synthetic cold reconciliation fsync failure')
    }
    await cold.runtime.ensureMessagesLoaded(restored)
    await entered.promise
    await cold.manager.cancelProcessing(restored.id, false)
    const stopEpoch = sessionRuntimeStateForTest(cold.runtime).turnCancellationEpochs.get(restored)
    release.resolve(); await tick(); await tick()

    expect(sessionRuntimeStateForTest(cold.runtime).turnCancellationEpochs.get(restored)).toBe(stopEpoch)
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.activeObjective?.interruptedTurnRecovery).toBeDefined()
    expect(h.events.some(event => event.type === 'typed_error' && event.error.title === 'Provider recovery state was not persisted')).toBe(false)
  })

  it('continues a successful cold reconciliation across a newer metadata persist', async () => {
    const h = harness(); const managed = h.make('provider-cold-metadata-race')
    managed.messages[0]!.providerDispatch = {
      schemaVersion: 1, state: 'acceptance-unknown', messageId: managed.messages[0]!.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 1, cancellationEpoch: 0, markedAt: Date.now(),
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const entered = deferred(); const release = deferred()
    cold.manager.flushSessionDurably = async id => {
      entered.resolve()
      await release.promise
      void id
    }
    let continuations = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { continuations++; return true }
    await cold.runtime.ensureMessagesLoaded(restored)
    await entered.promise
    await cold.manager.setSessionLabels(restored.id, ['metadata-race'])
    release.resolve()
    for (let attempt = 0; attempt < 100 && continuations === 0; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }

    expect(restored.labels).toEqual(['metadata-race'])
    expect(continuations).toBe(1)
  })

  it('does not roll a failed cold provider snapshot over a concurrently persisted question answer', async () => {
    const h = harness(); const managed = h.make('provider-cold-fsync-question-race')
    managed.messages[0]!.providerDispatch = {
      schemaVersion: 1,
      state: 'acceptance-unknown',
      messageId: managed.messages[0]!.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 1,
      cancellationEpoch: 0,
      markedAt: Date.now(),
    }
    managed.userInputRequests = [{
      id: 'provider-race-question',
      sessionId: managed.id,
      originWorkspaceId: h.workspace.id,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      status: 'pending',
      createdAt: 2,
      questions: [{
        id: 'scope', question: 'Which existing scope should be inspected?',
        options: [{ id: 'same', label: 'The same scope' }],
      }],
    }]
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const entered = deferred(); const release = deferred()
    const prompts: string[] = []
    let providerWrites = 0
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
        providerWrites++
        yield { type: 'text_complete' as const, text: 'Applied the saved answer.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    cold.runtime.getOrCreateAgent = async () => {
      restored.agent = runtimeAgent as never
      return runtimeAgent
    }
    const flushSessionDurably = cold.manager.flushSessionDurably.bind(cold.manager)
    let failColdReconciliation = true
    cold.manager.flushSessionDurably = async () => {
      if (failColdReconciliation) {
        entered.resolve()
        await release.promise
        failColdReconciliation = false
        throw new Error('synthetic cold reconciliation fsync failure')
      }
      await flushSessionDurably(restored.id)
    }
    await cold.runtime.ensureMessagesLoaded(restored)
    await entered.promise
    await cold.manager.respondToUserInput(restored.id, {
      requestId: 'provider-race-question',
      answers: [{ questionId: 'scope', optionIds: ['same'] }],
    }).catch(() => undefined)
    const responseMessageId = requiredTestValue(restored.userInputRequests)[0]!.responseMessageId
    expect(responseMessageId).toEqual(expect.any(String))
    release.resolve(); await tick(); await tick()
    await cold.manager.flushSession(restored.id)

    expect(requiredTestValue(restored.userInputRequests)[0]).toMatchObject({
      id: 'provider-race-question', status: 'answered', responseMessageId,
    })
    expect(restored.messages.find((message: Managed['messages'][number]) => message.id === responseMessageId))
      .toMatchObject({ role: 'user', hidden: true, isQueued: true })
    expect(h.events.some(event => event.type === 'typed_error' && event.error.title === 'Provider recovery state was not persisted')).toBe(false)
    for (let attempt = 0; attempt < 100 && providerWrites === 0; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    const persistedAnswer = restored.messages.find((message: Managed['messages'][number]) => (
      message.id === responseMessageId
    ))
    expect(providerWrites).toBe(1)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.startsWith(persistedAnswer?.content ?? '')).toBe(true)
  })
});
