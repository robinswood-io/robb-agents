import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupRestartRecovery, deferred, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  it('refreshes auth after an ACK with one generic continuation and never resends the accepted envelope', async () => {
    const h = harness(); const managed = h.make('provider-acked-auth-error')
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
          yield {
            type: 'typed_error' as const,
            error: { actions: [],
              code: 'expired_oauth_token' as const,
              title: 'Authentication expired',
              message: 'The provider token is expired.',
              canRetry: true,
            },
          }
          yield { type: 'complete' as const }
          return
        }
        yield { type: 'text_complete' as const, text: 'The current provider state is explained.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    await h.manager.sendMessage(managed.id, 'Explain the current authenticated provider state without changing it.')
    for (let attempt = 0; attempt < 150 && prompts.length < 2; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 150 && managed.isProcessing; attempt++) {
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
  })

  it('retires an ACKed turn when a queued human steer aborts it before output', async () => {
    const h = harness(); const managed = h.make('provider-acked-human-abort')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    const acknowledged = deferred(); const releaseFirst = deferred()
    const prompts: string[] = []
    let firstMessageId = ''
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true,
      redirect: () => { releaseFirst.resolve(); return false },
      getCurrentTurnUserMessage: () => 'Possibly apply objective A exactly once.',
      forceAbort: () => { releaseFirst.resolve() },
      dispose: async () => { releaseFirst.resolve() },
      async *chat(message: string): ReturnType<ScriptedSessionAgent['chat']> {
        prompts.push(message)
        await runtimeAgent.onBeforeProviderDispatch?.()
        runtimeAgent.onProviderHandoff?.()
        if (prompts.length === 1) {
          firstMessageId = managed.messages.findLast(candidate => candidate.role === 'user')!.id
          acknowledged.resolve()
          await releaseFirst.promise
          const error = new Error('Request was aborted.')
          error.name = 'AbortError'
          throw error
        }
        yield {
          type: 'typed_error' as const,
          error: { actions: [],
            code: 'invalid_request' as const,
            title: 'Fixture terminal after successor admission',
            message: 'The durable successor reached the provider exactly once.',
            canRetry: false,
          },
        }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    const first = h.manager.sendMessage(managed.id, 'Possibly apply objective A exactly once.')
    await acknowledged.promise
    await h.manager.sendMessage(managed.id, 'Explain the distinct durable state for objective B.')
    await first
    for (let attempt = 0; attempt < 150 && prompts.length < 2; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 150 && managed.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toBe(prompts[0])
    expect(prompts[1]).toContain('Explain the distinct durable state for objective B.')
    expect(managed.messages.find(message => message.id === firstMessageId)?.providerDispatch).toBeUndefined()
    expect(managed.messages.some(message => (
      message.providerDispatch?.messageId === firstMessageId
      && message.providerDispatch.state === 'retired-uncertain'
    ))).toBe(true)
    expect(h.runtime.providerDispatchAdmissionBarrier(managed)).toBeUndefined()
    expect(managed.messageQueue).toEqual([])
  })

  it('consumes an ACKed complete-only fence with a durable pending question before accepting its answer', async () => {
    const h = harness(); const managed = h.make('provider-acked-pending-question')
    const prompts: string[] = []
    let requestId = ''
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
          const request = await h.manager.requestUserInput(managed.id, [{
            id: 'scope', question: 'Which preserved scope should continue?',
            options: [{ id: 'same', label: 'The same scope' }],
          }])
          requestId = request.requestId
          yield { type: 'complete' as const }
          return
        }
        yield { type: 'text_complete' as const, text: 'Continued with the authenticated answer.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    await h.manager.sendMessage(managed.id, 'Ask only if the existing scope genuinely needs confirmation.')
    expect(requestId).not.toBe('')
    expect(managed.messages.some(message => !!message.providerDispatch)).toBe(false)
    expect(managed.userInputRequests?.find(request => request.id === requestId)?.status).toBe('pending')

    await h.manager.respondToUserInput(managed.id, {
      requestId,
      answers: [{ questionId: 'scope', optionIds: ['same'] }],
    })
    for (let attempt = 0; attempt < 100 && prompts.length < 2; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    for (let attempt = 0; attempt < 100 && managed.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toBe(prompts[0])
    expect(managed.messages.some(message => !!message.providerDispatch)).toBe(false)
    expect(managed.userInputRequests?.find(request => request.id === requestId)?.status).toBe('answered')
  })

  it('consumes an ACKed complete-only fence with a terminal recovery error and admits a fresh human turn', async () => {
    const h = harness(); const managed = h.make('provider-acked-recovery-halt')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 8,
      stagnantAttempts: 0,
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
        yield { type: 'text_complete' as const, text: 'Started the fresh human objective.', isIntermediate: false }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => {
      managed.agent = runtimeAgent
      return runtimeAgent
    }

    await h.manager.sendMessage(managed.id, 'This bounded recovery may halt without output.')
    expect(managed.messages.some(message => !!message.providerDispatch)).toBe(false)
    expect(managed.messages.some(message => message.role === 'error')).toBe(true)

    await h.manager.sendMessage(managed.id, 'Start a distinct fresh objective after the terminal recovery error.')
    for (let attempt = 0; attempt < 100 && managed.isProcessing; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).not.toBe(prompts[0])
    expect(managed.messages.some(message => !!message.providerDispatch)).toBe(false)
  })
});
