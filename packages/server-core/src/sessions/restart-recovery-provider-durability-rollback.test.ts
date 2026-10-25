import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { cleanupRestartRecovery, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  it('blocks the provider write when the durable WAL sync fails', async () => {
    const h = harness(); const managed = h.make('provider-write-ahead-sync-failure')
    let providerWrite = false
    let failNextDurableFlush = true
    const flushDurably = h.manager.flushSessionDurably.bind(h.manager)
    h.manager.flushSessionDurably = async id => {
      if (failNextDurableFlush && managed.messages.some(message => (
        message.providerDispatch?.state === 'acceptance-unknown'
      ))) {
        failNextDurableFlush = false
        throw new Error('synthetic WAL fsync failure')
      }
      await flushDurably(id)
    }
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        await runtimeAgent.onBeforeProviderDispatch?.()
        providerWrite = true
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    await h.manager.sendMessage(managed.id, 'Never write this prompt without a durable fence.')

    expect(providerWrite).toBe(false)
    expect(managed.messages.some(message => !!message.providerDispatch)).toBe(false)
  })

  it('surfaces ACK durability failure even when the provider stays silent', async () => {
    const h = harness(); const managed = h.make('provider-ack-sync-failure-silent')
    const prompts: string[] = []
    let durableFlushes = 0
    const flushDurably = h.manager.flushSessionDurably.bind(h.manager)
    h.manager.flushSessionDurably = async id => {
      durableFlushes += 1
      if (durableFlushes === 2) throw new Error('synthetic ACK fsync failure')
      await flushDurably(id)
    }
    const never = deferred()
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true,
      forceAbort: () => { never.resolve() }, dispose: async () => { never.resolve() },
      async *chat(message: string): ReturnType<ScriptedSessionAgent['chat']> {
        prompts.push(message)
        await runtimeAgent.onBeforeProviderDispatch?.()
        runtimeAgent.onProviderHandoff?.()
        if (prompts.length === 1) {
          await never.promise
          return
        }
        yield { type: 'text_complete' as const, text: 'Reconciled after the ACK durability failure.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await h.manager.sendMessage(managed.id, 'Preserve this accepted turn if ACK fsync fails.')
      for (let attempt = 0; attempt < 100 && prompts.length < 2; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
      for (let attempt = 0; attempt < 100 && managed.isProcessing; attempt++) {
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
    } finally {
      process.off('unhandledRejection', onUnhandled)
      never.resolve()
    }

    expect(unhandled).toEqual([])
    expect(managed.isProcessing).toBe(false)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toBe(prompts[0])
    expect(prompts[1]).toContain('<automatic_turn_recovery')
    expect(managed.messages.find(message => message.role === 'user'
      && message.content === 'Preserve this accepted turn if ACK fsync fails.')?.providerDispatch)
      .toBeUndefined()
    expect(h.events.some(event => event.type === 'typed_error'
      && event.error?.title === 'Provider acceptance requires confirmation')).toBe(false)
  })

  it('durably rolls back only an exact correlated preflight rejection', async () => {
    const h = harness(); const managed = h.make('provider-write-ahead-rejected')
    let dispatchedMessageId = ''
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => false, forceAbort: () => {}, dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        await runtimeAgent.onBeforeProviderDispatch?.()
        dispatchedMessageId = managed.messages.findLast(message => message.role === 'user')!.id
        runtimeAgent.onProviderDispatchRejected?.()
        yield { type: 'error' as const, message: 'Exact child preflight rejected the prompt' }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    await h.manager.sendMessage(managed.id, 'Reject this exact preflight fixture.')
    await h.manager.flushSession(managed.id)
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
      .find(message => message.id === dispatchedMessageId)
    expect(stored.providerDispatch).toBeUndefined()
  })

  it('retires an uncorrelated post-write error and continues generically without exact replay', async () => {
    const h = harness(); const managed = h.make('provider-write-ahead-uncorrelated-error')
    let dispatchedMessageId = ''
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
        if (prompts.length === 1) {
          dispatchedMessageId = managed.messages.findLast(candidate => candidate.role === 'user')!.id
          yield { type: 'error' as const, message: 'Transport closed after a possibly successful write' }
          yield { type: 'complete' as const }
          return
        }
        runtimeAgent.onProviderHandoff?.()
        yield { type: 'text_complete' as const, text: 'Reconciled from current provider state.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    await h.manager.sendMessage(managed.id, 'Do not duplicate this ambiguous provider write.')
    for (let attempt = 0; attempt < 100 && prompts.length < 2; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 100 && managed.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    await h.manager.flushSession(managed.id)

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Do not duplicate this ambiguous provider write.')
    expect(prompts[1]).not.toBe(prompts[0])
    expect(prompts[1]).toContain('<automatic_turn_recovery')
    // The host objective contract may quote the visible objective as inert
    // context. What must never recur is the exact provider envelope.
    expect(prompts[1]).not.toBe(prompts[0])
    const preserved = managed.messages.find(message => message.id === dispatchedMessageId)
    expect(preserved?.providerDispatch).toBeUndefined()
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
      .find(message => message.id === dispatchedMessageId)
    expect(stored.providerDispatch).toBeUndefined()
    expect(managed.messageQueue).toEqual([])
    expect(h.events.some(event => (
      event.type === 'typed_error'
      && event.sessionId === managed.id
      && event.error?.title === 'Provider acceptance requires confirmation'
    ))).toBe(false)

    const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
    let coldContinuations = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { coldContinuations++; return true }
    await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
    await tick(); await tick()
    expect(coldContinuations).toBe(0)
  })

  it('retires a stale unknown turn when a newer durable human objective supersedes it live', async () => {
    const h = harness(); const managed = h.make('provider-live-human-supersession')
    const firstWritten = deferred(); const releaseFirst = deferred()
    const prompts: string[] = []
    let firstMessageId = ''
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true,
      redirect: () => true,
      getCurrentTurnUserMessage: () => 'Potentially mutate objective A exactly once.',
      forceAbort: () => { releaseFirst.resolve() }, dispose: async () => { releaseFirst.resolve() },
      async *chat(message: string): ReturnType<ScriptedSessionAgent['chat']> {
        prompts.push(message)
        await runtimeAgent.onBeforeProviderDispatch?.()
        if (prompts.length === 1) {
          firstMessageId = managed.messages.findLast(candidate => candidate.role === 'user')!.id
          runtimeAgent.onProviderDispatchUncertain?.()
          firstWritten.resolve()
          await releaseFirst.promise
          throw new Error('the first provider write may have succeeded before transport loss')
        }
        runtimeAgent.onProviderHandoff?.()
        yield { type: 'text_complete' as const, text: 'Completed the newer human objective.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    const firstRun = h.manager.sendMessage(managed.id, 'Potentially mutate objective A exactly once.')
    await firstWritten.promise
    await h.manager.sendMessage(managed.id, 'Continue instead with durable human objective B.')
    releaseFirst.resolve()
    await firstRun
    for (let attempt = 0; attempt < 100 && prompts.length < 2; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 100 && managed.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toBe('Continue instead with durable human objective B.')
    expect(prompts[1]).toContain('<automatic_turn_recovery')
    expect(managed.messages.find(message => message.id === firstMessageId)?.providerDispatch).toBeUndefined()
    expect(managed.messages.find(message => (
      message.providerDispatch?.messageId === firstMessageId
      && message.providerDispatch.state === 'retired-uncertain'
    ))?.providerDispatch).toMatchObject({
      state: 'retired-uncertain',
      retirementReason: 'superseded-by-new-human-objective',
    })
    expect(h.runtime.providerDispatchAdmissionBarrier(managed)).toBeUndefined()
    expect(managed.messageQueue).toEqual([])
  })
});
