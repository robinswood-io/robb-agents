import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  it('keeps an explicit Stop of acceptance-unknown quarantined across cold restart', async () => {
    const h = harness(); const managed = h.make('provider-write-ahead-stop-after-write')
    const written = deferred(); const release = deferred()
    let dispatchedMessageId = ''
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true, forceAbort: () => {}, dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        await runtimeAgent.onBeforeProviderDispatch?.()
        dispatchedMessageId = managed.messages.findLast(message => message.role === 'user')!.id
        runtimeAgent.onProviderDispatchUncertain?.()
        written.resolve()
        await release.promise
        const error = new Error('Request was aborted.')
        error.name = 'AbortError'
        throw error
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    const run = h.manager.sendMessage(managed.id, 'Perform this once even if Stop races.')
    await written.promise
    await h.manager.cancelProcessing(managed.id, false)
    const fenced = managed.messages.find(message => message.id === dispatchedMessageId)!
    expect(fenced.providerDispatch?.state).toBe('acceptance-unknown')
    expect(fenced.providerDispatch?.userStoppedAt).toEqual(expect.any(Number))
    expect(managed.pendingTurnRecovery?.userMessageId).toBe(dispatchedMessageId)
    release.resolve(); await run
    await h.manager.flushSession(managed.id)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let providerStarts = 0
    let genericContinuations = 0
    cold.runtime.getOrCreateAgent = async () => {
      providerStarts++
      throw new Error('stopped acceptance-unknown turn must not replay')
    }
    cold.runtime.enqueueAutomaticTurnRecovery = async (_managed: Managed, cause: string) => {
      genericContinuations++
      expect(cause).toBe('app_restart')
      return true
    }
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.manager.flushSession(restored.id); await tick(); await tick()
    if (!genericContinuations) await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    expect(providerStarts).toBe(0)
    expect(genericContinuations).toBe(0)
    expect(restored.messages.find((message: Managed['messages'][number]) => (
      message.id === dispatchedMessageId
    ))?.providerDispatch).toMatchObject({
      state: 'acceptance-unknown',
      userStoppedAt: expect.any(Number),
    })
    expect(h.events.some(event => event.type === 'typed_error'
      && event.error?.title === 'Provider dispatch requires reconciliation')).toBe(true)
  })

  it('lets Stop win before the write-ahead callback and performs no provider write', async () => {
    const h = harness(); const managed = h.make('provider-write-ahead-stop-before-write')
    const ready = deferred(); const release = deferred()
    let providerWrite = false
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true, forceAbort: () => {}, dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        ready.resolve()
        await release.promise
        await runtimeAgent.onBeforeProviderDispatch?.()
        providerWrite = true
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    const run = h.manager.sendMessage(managed.id, 'Stop before this provider write.')
    await ready.promise
    await h.manager.cancelProcessing(managed.id, true)
    release.resolve(); await run
    expect(providerWrite).toBe(false)
    expect(managed.messages.some(message => (
      message.providerDispatch?.state === 'acceptance-unknown'
    ))).toBe(false)
  })

  for (const state of ['acceptance-unknown', 'accepted'] as const) {
    it(`keeps the ${state} non-replay proof when Stop races Retry reconciliation fsync`, async () => {
      const h = harness(); const managed = h.make(`provider-${state}-retry-stop-race`)
      const anchorId = managed.messages[0]!.id
      managed.messages[0]!.providerDispatch = {
        schemaVersion: 1, state, messageId: anchorId,
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        generation: 1, cancellationEpoch: 0, markedAt: Date.now(),
        ...(state === 'accepted' ? { acceptedAt: Date.now() + 1 } : {}),
      }
      await h.save(managed)

      const entered = deferred(); const release = deferred()
      const flushSessionDurably = h.manager.flushSessionDurably.bind(h.manager)
      let gateReconciliation = true
      h.manager.flushSessionDurably = async id => {
        if (gateReconciliation && !managed.messages.some(message => message.providerDispatch)) {
          gateReconciliation = false
          entered.resolve()
          await release.promise
        }
        await flushSessionDurably(id)
      }

      const retry = h.manager.retryTurn(managed.id, anchorId).catch(error => error)
      await entered.promise
      await expect(h.manager.sendMessage(managed.id, 'A newer human turn must not cross this Retry fence.'))
        .rejects.toThrow('Provider reconciliation is still being persisted')
      const stop = h.manager.cancelProcessing(managed.id, false)
      await tick()
      release.resolve()
      await retry
      await stop

      expect(managed.messages.some(message => (
        message.content === 'A newer human turn must not cross this Retry fence.'
      ))).toBe(false)
      const stopped = managed.messages.find(message => message.id === anchorId)?.providerDispatch
      if (state === 'accepted') {
        expect(stopped).toMatchObject({
          state: 'retired-accepted', retirementReason: 'user-stop-after-provider-ack',
          userStoppedAt: expect.any(Number),
        })
      } else {
        expect(stopped).toMatchObject({
          state: 'acceptance-unknown', userStoppedAt: expect.any(Number),
        })
      }

      const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
      let continuations = 0
      cold.runtime.enqueueAutomaticTurnRecovery = async () => { continuations++; return true }
      await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
      await tick(); await tick()
      expect(continuations).toBe(0)
    })
  }

  for (const variant of ['clean-retry', 'source-activation', 'user-input'] as const) {
    it(`never reconstructs the exact ${variant} prompt after Retry reconciliation fsync`, async () => {
      const h = harness(); const managed = h.make(`provider-retry-crash-${variant}`)
      const dispatchId = `${managed.id}-exact-dispatch`
      const dispatch: Managed['messages'][number] = {
        id: dispatchId,
        role: 'user',
        content: `EXACT_${variant.toUpperCase()}_PROMPT_MUST_NOT_REPLAY`,
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
        } : variant === 'user-input' ? {
          internalOrigin: { kind: 'user-input' as const },
        } : {}),
      }
      managed.messages.push(dispatch)
      if (variant === 'user-input') {
        managed.userInputRequests = [{
          id: 'provider-retry-crash-question', sessionId: managed.id,
          originWorkspaceId: h.workspace.id,
          objectiveUserMessageId: managed.activeObjective!.userMessageId,
          status: 'answered', createdAt: 2, answeredAt: 3,
          questions: [{ id: 'scope', question: 'Continue?', options: [{ id: 'yes', label: 'Yes' }] }],
          answers: [{ questionId: 'scope', optionIds: ['yes'] }],
          responseMessageId: dispatchId,
        }]
        dispatch.content = `${USER_INPUT_ANSWER_MESSAGE_PREFIX}${JSON.stringify({
          requestId: 'provider-retry-crash-question',
          questions: managed.userInputRequests[0]!.questions,
          answers: managed.userInputRequests[0]!.answers,
        })}`
      }
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        ...(variant === 'user-input' ? { userMessageId: dispatchId } : {}),
        recoveryDispatch: {
          schemaVersion: 1,
          id: dispatchId,
          attempt: 3,
          cause: variant === 'clean-retry' ? 'user_retry' : 'runtime_error',
          origin: variant === 'clean-retry' ? 'retry' : 'automatic',
          allocatedAt: 2,
          phase: 'started',
          startedAt: 3,
          preToolExecutionReceiptVersion: 1,
          ...(variant === 'clean-retry' ? { cleanContinuationId: 'clean-boundary' } : {}),
        },
      }
      dispatch.providerDispatch = {
        schemaVersion: 1,
        state: 'acceptance-unknown',
        messageId: dispatch.id,
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        generation: 3,
        cancellationEpoch: 0,
        markedAt: Date.now(),
      }
      await h.save(managed)

      await h.runtime.reconcileProviderAcceptanceUnknownForRetry(managed, 0)
      expect(managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
      if (variant === 'user-input') {
        expect(managed.messages.find(message => message.id === dispatchId)).toMatchObject({
          hidden: true, isQueued: false, internalOrigin: { kind: 'user-input' },
        })
        expect(managed.messages.find(message => message.id === dispatchId)?.providerDispatch).toBeUndefined()
      } else {
        expect(managed.messages.some(message => message.id === dispatchId)).toBe(false)
      }

      // Simulate a host crash at the exact boundary after the reconciliation
      // snapshot fsyncs but before retryTurn can allocate its generic prompt.
      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      let genericContinuations = 0
      cold.runtime.enqueueAutomaticTurnRecovery = async (_session: Managed, cause: string) => {
        genericContinuations++
        expect(cause).toBe('app_restart')
        return true
      }
      await cold.runtime.ensureMessagesLoaded(restored)
      await tick(); await tick()
      if (!genericContinuations) await cold.runtime.resumePendingTurnAfterRestart(restored.id)

      expect(genericContinuations).toBeLessThanOrEqual(1)
      if (variant === 'user-input') {
        expect(restored.messages.find((message: Managed['messages'][number]) => message.id === dispatchId))
          .toMatchObject({ hidden: true, isQueued: false })
        expect(restored.messages.find((message: Managed['messages'][number]) => message.id === dispatchId)?.providerDispatch)
          .toBeUndefined()
        expect(restored.messageQueue.some((item: Managed['messageQueue'][number]) => item.messageId === dispatchId))
          .toBe(false)
      } else {
        expect(restored.messages.some((message: Managed['messages'][number]) => (
          message.id === dispatchId || message.content.includes(`EXACT_${variant.toUpperCase()}_PROMPT_MUST_NOT_REPLAY`)
        ))).toBe(false)
      }
      expect(restored.pendingTurnRecovery?.recoveryDispatch?.id).not.toBe(dispatchId)
    })
  }

  it('keeps a malformed accepted receipt quarantined instead of consuming it', async () => {
    const h = harness(); const managed = h.make('provider-malformed-accepted')
    const dispatch = managed.messages[0]!
    dispatch.providerDispatch = {
      schemaVersion: 1,
      state: 'accepted',
      messageId: 'wrong-message-id',
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 2,
      cancellationEpoch: 0,
      markedAt: Date.now(),
      acceptedAt: Date.now() + 1,
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let continuations = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { continuations++; return true }
    await cold.runtime.ensureMessagesLoaded(restored)
    await tick(); await tick()

    expect(continuations).toBe(0)
    expect(restored.messages[0]?.providerDispatch).toMatchObject({
      state: 'accepted', messageId: 'wrong-message-id',
    })
    expect(cold.runtime.providerDispatchAdmissionBarrier(restored)).toBe(restored.messages[0])
    expect(h.events.some(event => event.type === 'typed_error'
      && event.error?.title === 'Provider dispatch requires reconciliation')).toBe(true)
  })
});
