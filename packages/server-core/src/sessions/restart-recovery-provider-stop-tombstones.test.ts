import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupRestartRecovery, type Managed, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  it('tombstones an ACKed prompt on explicit Stop, stays idle cold, and Retry uses a fresh generic boundary', async () => {
    const h = harness(); const managed = h.make('provider-accepted-explicit-stop')
    const anchor = managed.messages[0]!
    anchor.providerDispatch = {
      schemaVersion: 1,
      state: 'accepted',
      messageId: anchor.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 1,
      cancellationEpoch: 0,
      markedAt: Date.now(),
      acceptedAt: Date.now() + 1,
    }
    await h.save(managed)

    await h.manager.cancelProcessing(managed.id, false)
    expect<unknown>(anchor.providerDispatch).toMatchObject({
      state: 'retired-accepted',
      retirementReason: 'user-stop-after-provider-ack',
      userStoppedAt: (expect.any(Number) as unknown),
    })

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let automaticContinuations = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { automaticContinuations++; return true }
    await cold.runtime.ensureMessagesLoaded(restored)
    await tick(); await tick()
    expect(automaticContinuations).toBe(0)
    expect(restored.pendingTurnRecovery).toBeUndefined()

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
        yield { type: 'text_complete' as const, text: 'Reconciled from current state.', isIntermediate: false }
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

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toBe(anchor.content)
    expect(prompts[0]).toContain('Resume from existing evidence and the current external state')
    for (let attempt = 0; attempt < 100 && restored.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 100 && restored.messages.some((message: Managed['messages'][number]) => (
      message.id === anchor.id && message.providerDispatch !== undefined
    )); attempt++) await new Promise<void>(resolve => setTimeout(resolve, 10))
    expect(restored.messages.find((message: Managed['messages'][number]) => message.id === anchor.id)?.providerDispatch)
      .toBeUndefined()
  })

  it('allows a fresh human objective only after the accepted Stop tombstone is durable', async () => {
    const h = harness(); const managed = h.make('provider-accepted-stop-then-human')
    const anchor = managed.messages[0]!
    anchor.providerDispatch = {
      schemaVersion: 1, state: 'accepted', messageId: anchor.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 1, cancellationEpoch: 0, markedAt: Date.now(), acceptedAt: Date.now() + 1,
    }
    await h.save(managed)
    await h.manager.cancelProcessing(managed.id, false)

    let starts = 0
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        await runtimeAgent.onBeforeProviderDispatch?.()
        starts++
        runtimeAgent.onProviderHandoff?.()
        yield { type: 'text_complete' as const, text: 'Fresh objective started.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }
    await h.manager.sendMessage(managed.id, 'Start a distinct fresh objective.')

    expect(starts).toBe(1)
    expect(anchor.providerDispatch).toMatchObject({ state: 'retired-accepted' })
  })

  it('restores the accepted barrier when the explicit Stop tombstone fsync fails', async () => {
    const h = harness(); const managed = h.make('provider-accepted-stop-fsync-failure')
    const anchor = managed.messages[0]!
    anchor.providerDispatch = {
      schemaVersion: 1, state: 'accepted', messageId: anchor.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 1, cancellationEpoch: 0, markedAt: Date.now(), acceptedAt: Date.now() + 1,
    }
    await h.save(managed)
    h.manager.flushSessionDurably = async () => { throw new Error('synthetic Stop fsync failure') }

    await h.manager.cancelProcessing(managed.id, false)

    expect<unknown>(anchor.providerDispatch).toMatchObject({
      state: 'accepted',
      userStoppedAt: (expect.any(Number) as unknown),
    })
    expect(h.runtime.providerDispatchAdmissionBarrier(managed)).toBe(anchor)
    await expect(h.manager.sendMessage(managed.id, 'This must remain blocked.'))
      .rejects.toThrow('Use Retry to reconcile')
    expect(managed.messages.some(message => message.content === 'This must remain blocked.')).toBe(false)
  })

  for (const state of ['acceptance-unknown', 'accepted'] as const) {
    it(`prioritizes a queued human over restored auth after cold ${state} reconciliation`, async () => {
      const h = harness(); const managed = h.make(`provider-${state}-auth-human`)
      const anchor = managed.messages[0]!
      anchor.providerDispatch = {
        schemaVersion: 1, state, messageId: anchor.id,
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        generation: 1, cancellationEpoch: 0, markedAt: Date.now(),
        ...(state === 'accepted' ? { acceptedAt: Date.now() + 1 } : {}),
      }
      managed.pendingAuthRequestId = 'stale-auth'
      managed.messages.push({
        id: 'auth-message', role: 'auth-request', content: 'Credentials required', timestamp: 2,
        authRequestId: 'stale-auth', authRequestType: 'credential', authSourceSlug: 'source',
        authSourceName: 'Source', authStatus: 'pending', authCredentialMode: 'bearer',
      }, {
        id: 'queued-human', role: 'user', content: 'Continue with my newer instruction.',
        timestamp: 3, isQueued: true,
      })
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      let dequeues = 0
      const processNext = cold.runtime.processNextQueuedMessage.bind(cold.runtime)
      cold.runtime.processNextQueuedMessage = (sessionId: string) => {
        dequeues++
        processNext(sessionId)
      }
      const runtimeAgent = completeSessionAgentFixture(h.workspace, {
        onProviderHandoff: null as (() => void) | null,
        onBeforeProviderDispatch: null as (() => Promise<void>) | null,
        onProviderDispatchRejected: null as (() => void) | null,
        onProviderDispatchUncertain: null as (() => void) | null,
        getModel: () => 'fixture-model', getSessionId: () => null,
        setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: async () => {},
        async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
          await runtimeAgent.onBeforeProviderDispatch?.()
          runtimeAgent.onProviderHandoff?.()
          yield { type: 'text_complete' as const, text: 'New human objective received.', isIntermediate: false }
          yield { type: 'complete' as const }
        },
      })
      cold.runtime.getOrCreateAgent = async () => {
        restored.agent = runtimeAgent as never
        return runtimeAgent
      }
      await cold.runtime.ensureMessagesLoaded(restored)
      await cold.manager.flushSession(restored.id)
      for (let attempt = 0; attempt < 50 && dequeues === 0; attempt++) await tick()
      for (let attempt = 0; attempt < 50 && restored.pendingAuthRequestId; attempt++) await tick()

      expect(dequeues).toBeGreaterThanOrEqual(1)
      expect(restored.pendingAuthRequestId).toBeUndefined()
      expect(restored.messages.find((message: Managed['messages'][number]) => message.id === 'auth-message')?.authStatus)
        .toBe('cancelled')
      expect(restored.messages.find((message: Managed['messages'][number]) => message.id === anchor.id)?.providerDispatch)
        .toBeUndefined()
    })
  }
});
