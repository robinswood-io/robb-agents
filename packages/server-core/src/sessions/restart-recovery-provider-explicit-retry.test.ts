import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('provider dispatch write-ahead recovery', () => {
  it('re-arms an unknown turn only through explicit Retry reconciliation', async () => {
    const h = harness(); const managed = h.make('provider-write-ahead-explicit-retry')
    const anchor = managed.messages[0]!
    const previousMarker = {
      schemaVersion: 1 as const,
      state: 'acceptance-unknown' as const,
      messageId: anchor.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 4,
      cancellationEpoch: 1,
      markedAt: Date.now() - 10_000,
    }
    anchor.providerDispatch = previousMarker
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      startedAt: Date.now() - DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS - 1_000,
      leaseExpiresAt: Date.now() - 500,
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const entered = deferred(); const release = deferred()
    let providerWrites = 0
    const runtimeAgent = completeSessionAgentFixture(h.workspace, {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true, forceAbort: () => {}, dispose: async () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        await runtimeAgent.onBeforeProviderDispatch?.()
        providerWrites++
        entered.resolve()
        await release.promise
        runtimeAgent.onProviderDispatchRejected?.()
        yield { type: 'error' as const, message: 'End explicit Retry fixture preflight' }
        yield { type: 'complete' as const }
      },
    })
    cold.runtime.getOrCreateAgent = async () => {
      restored.agent = runtimeAgent as never
      return runtimeAgent
    }

    await cold.runtime.ensureMessagesLoaded(restored)
    await tick(); await tick()
    expect(providerWrites).toBe(0)
    expect(restored.messages.find((message: Managed['messages'][number]) => message.id === anchor.id)
      ?.providerDispatch).toEqual(previousMarker)

    expect(await cold.manager.retryTurn(restored.id, anchor.id)).toEqual({ status: 'started' })
    await entered.promise
    const rearmed = restored.messages.find((message: Managed['messages'][number]) => message.id === anchor.id)
      ?.providerDispatch
    expect(providerWrites).toBe(1)
    expect(rearmed).toMatchObject({
      state: 'acceptance-unknown',
      messageId: anchor.id,
      objectiveId: previousMarker.objectiveId,
      objectiveUserMessageId: previousMarker.objectiveUserMessageId,
    })
    expect(rearmed?.generation).not.toBe(previousMarker.generation)
    expect(rearmed?.markedAt).toBeGreaterThan(previousMarker.markedAt)
    release.resolve()
    for (let index = 0; index < 4; index++) await tick()
  })

  for (const variant of ['human', 'agent-delivery'] as const) {
    for (const blocker of ['question', 'auth'] as const) {
      it(`keeps ${variant} provider uncertainty durable when Retry is blocked by ${blocker}`, async () => {
        const h = harness(); const managed = h.make(`provider-retry-blocked-${variant}-${blocker}`)
        const anchor = managed.messages[0]!
        const fenced = variant === 'human' ? anchor : {
          id: `blocked-${variant}-receipt`, role: 'user' as const, hidden: true,
          content: 'CHILD_RECEIPT_MUST_REMAIN_FENCED', timestamp: 2,
          internalOrigin: { kind: 'agent-message' as const, senderSessionId: 'child',
            deliveryId: 'blocked-delivery', agentMessageType: 'result' as const },
          agentDelivery: { id: 'blocked-delivery', status: 'processing' as const, attempts: 1 },
        }
        if (variant === 'agent-delivery') managed.messages.push(fenced)
        fenced.providerDispatch = {
          schemaVersion: 1, state: 'acceptance-unknown', messageId: fenced.id,
          objectiveId: managed.activeObjective!.objectiveId!,
          objectiveUserMessageId: managed.activeObjective!.userMessageId,
          generation: 3, cancellationEpoch: 0, markedAt: Date.now(),
        }
        if (blocker === 'question') {
          managed.userInputRequests = [{
            id: 'blocked-question', sessionId: managed.id,
            originWorkspaceId: h.workspace.id,
            objectiveUserMessageId: managed.activeObjective!.userMessageId,
            status: 'pending', createdAt: 1,
            questions: [{ id: 'confirm', question: 'Confirm the next step?', options: [] }],
          }] as never
        } else {
          managed.pendingAuthRequestId = 'blocked-auth'
        }
        await h.save(managed)

        await expect(h.manager.retryTurn(managed.id, anchor.id)).rejects.toThrow(/pending|Resolve/)
        expect(fenced.providerDispatch?.state).toBe('acceptance-unknown')
        if (variant === 'agent-delivery') expect(fenced.agentDelivery?.status).toBe('processing')
        await h.manager.flushSession(managed.id)
        const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
          .trim().split('\n').map(parseRecoveryJournalObservation)
          .find(message => message.id === fenced.id)
        expect(requiredTestValue(stored).providerDispatch?.state).toBe('acceptance-unknown')
      })
    }
  }

  it('restores the durable provider fence when a blocker appears during Retry fsync', async () => {
    const h = harness(); const managed = h.make('provider-retry-blocker-toctou')
    const anchor = managed.messages[0]!
    anchor.providerDispatch = {
      schemaVersion: 1, state: 'acceptance-unknown', messageId: anchor.id,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      generation: 3, cancellationEpoch: 0, markedAt: Date.now(),
    }
    await h.save(managed)
    const entered = deferred(); const release = deferred()
    const flushDurably = h.manager.flushSessionDurably.bind(h.manager)
    let durableFlushes = 0
    h.manager.flushSessionDurably = async id => {
      durableFlushes++
      if (durableFlushes === 1) { entered.resolve(); await release.promise }
      await flushDurably(id)
    }

    const retry = h.manager.retryTurn(managed.id, anchor.id)
    await entered.promise
    managed.pendingAuthRequestId = 'arrived-during-fsync'
    release.resolve()
    await expect(retry).rejects.toThrow(/authentication|approval/)

    expect(managed.messages.find(message => message.id === anchor.id)?.providerDispatch?.state)
      .toBe('acceptance-unknown')
    await h.manager.flushSession(managed.id)
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
      .find(message => message.id === anchor.id)
    expect(requiredTestValue(stored).providerDispatch?.state).toBe('acceptance-unknown')
    expect(durableFlushes).toBeGreaterThanOrEqual(2)
  })

  it('reconciles an unknown agent receipt through a generic parent continuation without redelivery', async () => {
    const h = harness(); const managed = h.make('provider-agent-delivery-explicit-retry')
    const anchor = managed.messages[0]!
    const receipt: Managed['messages'][number] = {
      id: 'uncertain-child-receipt', role: 'user', hidden: true,
      content: 'CHILD_EXACT_PAYLOAD_DO_NOT_REPEAT', timestamp: 2,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child',
        deliveryId: 'uncertain-delivery', agentMessageType: 'result' },
      agentDelivery: { id: 'uncertain-delivery', status: 'processing', attempts: 1 },
      providerDispatch: {
        schemaVersion: 1, state: 'acceptance-unknown', messageId: 'uncertain-child-receipt',
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveUserMessageId: managed.activeObjective!.userMessageId,
        generation: 3, cancellationEpoch: 0, markedAt: Date.now(),
      },
    }
    managed.messages.push(receipt)
    await h.save(managed)
    const entered = deferred(); const release = deferred()
    let deliveredPrompt = ''
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
      onProviderHandoff: null as (() => void) | null,
      onBeforeProviderDispatch: null as (() => Promise<void>) | null,
      onProviderDispatchRejected: null as (() => void) | null,
      onProviderDispatchUncertain: null as (() => void) | null,
      getModel: () => 'fixture-model', getSessionId: () => null,
      setAllSources: () => {}, isProcessing: () => true, forceAbort: () => {}, dispose: async () => {},
      async *chat(prompt: string): ReturnType<ScriptedSessionAgent['chat']> {
        deliveredPrompt = prompt
        await runtimeAgent.onBeforeProviderDispatch?.()
        entered.resolve(); await release.promise
        runtimeAgent.onProviderDispatchRejected?.()
        yield { type: 'error' as const, message: 'End generic receipt reconciliation fixture' }
        yield { type: 'complete' as const }
      },
    })
    h.runtime.getOrCreateAgent = async () => { managed.agent = runtimeAgent; return runtimeAgent }

    expect(await h.manager.retryTurn(managed.id, anchor.id)).toEqual({ status: 'started' })
    await entered.promise
    expect(deliveredPrompt).toContain('<automatic_turn_recovery')
    expect(deliveredPrompt).not.toContain(receipt.content)
    expect(receipt).toMatchObject({ isQueued: false, agentDelivery: { status: 'processed' } })
    expect(receipt.providerDispatch).toBeUndefined()
    release.resolve(); for (let index = 0; index < 4; index++) await tick()
  })
});
