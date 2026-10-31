import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  it('fsyncs the exact human turn before dispatch and durably marks exact ACK before output', async () => {
    const h = harness(); const managed = h.make('provider-write-ahead-ack')
    const fenced = deferred(); const allowAck = deferred(); const acknowledged = deferred(); const finish = deferred()
    const durabilityOrder: string[] = []
    let dispatchedMessageId = ''
    const persist = h.runtime.persistSession.bind(h.runtime)
    h.runtime.persistSession = (session: Managed) => {
      if (session.messages.some(message => message.providerDispatch?.state === 'acceptance-unknown')
        && !durabilityOrder.includes('persist-marker')) durabilityOrder.push('persist-marker')
      return persist(session)
    }
    const flushDurably = h.manager.flushSessionDurably.bind(h.manager)
    h.manager.flushSessionDurably = async id => {
      const isMarkerFlush = managed.messages.some(message => (
        message.providerDispatch?.state === 'acceptance-unknown'
      )) && !durabilityOrder.includes('sync-complete')
      if (isMarkerFlush) durabilityOrder.push('flush-durable')
      await flushDurably(id)
      if (isMarkerFlush) durabilityOrder.push('sync-complete')
    }
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true, forceAbort: () => {}, dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        await runtimeAgent.onBeforeProviderDispatch?.()
        durabilityOrder.push('provider-write')
        dispatchedMessageId = managed.messages.findLast(message => message.role === 'user')!.id
        fenced.resolve()
        await allowAck.promise
        runtimeAgent.onProviderHandoff?.()
        acknowledged.resolve()
        await finish.promise
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    const run = h.manager.sendMessage(managed.id, 'Perform the exact durable operation.')
    await fenced.promise
    const beforeAck = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
      .find(message => message.id === dispatchedMessageId)
    expect(requiredTestValue(beforeAck).providerDispatch).toMatchObject({
      state: 'acceptance-unknown', messageId: dispatchedMessageId,
      objectiveId: managed.activeObjective!.objectiveId,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: managed.processingGeneration,
    })
    expect(durabilityOrder.slice(0, 4)).toEqual([
      'persist-marker', 'flush-durable', 'sync-complete', 'provider-write',
    ])

    allowAck.resolve(); await acknowledged.promise
    await h.manager.flushSession(managed.id)
    const afterAck = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
      .find(message => message.id === dispatchedMessageId)
    expect<unknown>(requiredTestValue(afterAck).providerDispatch).toMatchObject({
      state: 'accepted',
      messageId: dispatchedMessageId,
      acceptedAt: (expect.any(Number) as unknown),
    })

    await h.manager.cancelProcessing(managed.id, true)
    finish.resolve(); await run
  })

  it('consumes an ACKed complete-only prompt and continues generically without replay', async () => {
    const h = harness(); const managed = h.make('provider-acked-complete-only')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    const prompts: string[] = []
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
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
        if (prompts.length === 1) {
          yield { type: 'complete' as const }
          return
        }
        yield { type: 'text_complete' as const, text: 'Recovered from current state.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    await h.manager.sendMessage(managed.id, 'Perform this operation exactly once.')
    for (let attempt = 0; attempt < 100 && prompts.length < 2; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 100 && managed.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }

    expect(prompts).toHaveLength(2)
    expect(prompts[0]?.startsWith('Perform this operation exactly once.')).toBe(true)
    expect(prompts[1]).not.toBe(prompts[0])
    expect(prompts[1]).toContain('<automatic_turn_recovery')
    expect(managed.messages.some(message => message.providerDispatch)).toBe(false)
    expect(managed.messageQueue).toEqual([])
  })

  for (const boundary of ['continuation-required', 'iterator-return', 'post-ack-throw'] as const) {
    it(`durably consumes an ACKed ${boundary} prompt only with its generic successor`, async () => {
      const h = harness(); const managed = h.make(`provider-acked-${boundary}`)
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        attempts: 0,
        stagnantAttempts: 0,
        leaseExpiresAt: Date.now() + 60_000,
        ...(boundary === 'continuation-required' ? { continuationRequired: true } : {}),
      }
      const prompts: string[] = []
      const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
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
          if (prompts.length === 1) {
            if (boundary === 'post-ack-throw') throw new Error('transport failed immediately after ACK')
            if (boundary === 'iterator-return') return
            yield { type: 'complete' as const }
            return
          }
          yield { type: 'text_complete' as const, text: 'Recovered from the durable successor.', isIntermediate: false }
          yield { type: 'complete' as const }
        },
      })
      h.runtime.getOrCreateAgent = async () => {
        managed.agent = runtimeAgent
        return runtimeAgent
      }

      await h.manager.sendMessage(managed.id, `Perform ${boundary} exactly once.`)
      for (let attempt = 0; attempt < 100 && prompts.length < 2; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      for (let attempt = 0; attempt < 100 && managed.isProcessing; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }

      expect(prompts).toHaveLength(2)
      expect(prompts[1]).not.toBe(prompts[0])
      expect(prompts[1]).toContain('<automatic_turn_recovery')
      expect(managed.messages.some(message => (
        message.providerDispatch?.state === 'accepted'
        || message.providerDispatch?.state === 'acceptance-unknown'
      ))).toBe(false)
      expect(managed.messageQueue).toEqual([])

      const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
      let coldStarts = 0
      cold.runtime.getOrCreateAgent = async () => {
        coldStarts++
        throw new Error('completed successor must not replay after restart')
      }
      await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
      await tick(); await tick()
      expect(coldStarts).toBe(0)
    })
  }
});
