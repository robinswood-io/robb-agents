import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath, listSessions } from "@craft-agent/shared/sessions/storage";
import { SessionManager } from "./SessionManager";
import { DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('authenticated cost checkpoint durability', () => {
  const reason = 'Cost guard checkpoint: mutation Edit was not started because this turn no longer has the 4-call reserve required to verify and close it safely. End this response with a concise checkpoint naming the remaining action; automatic recovery will continue it without waiting for another user message.'

  async function checkpoint(h: ReturnType<typeof harness>, managed: Managed, overrides: Record<string, unknown> = {}) {
    await h.runtime.processEvent(managed, { type: 'tool_start', toolName: 'Edit', toolUseId: 'unexecuted-edit',
      input: { file_path: '/fixture/paperbridge-security.yml', old_string: 'output: ../codeql-results', new_string: 'output: codeql-results' } }, 1)
    await h.runtime.processEvent(managed, { isError: false, type: 'tool_result', toolName: 'Edit', toolUseId: 'unexecuted-edit',
      result: reason, executed: false, continuationRequired: true,
      checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason }, ...overrides }, 1)
  }

  it('keeps Stop final even when the interrupted objective remains active', async () => {
    const h = harness(); const managed = h.make('stopped-active-checkpoint')
    managed.isProcessing = true; managed.processingGeneration = 1
    await h.runtime.processEvent(managed, { type: 'tool_start', toolName: 'Edit', toolUseId: 'late-call', input: {} }, 1)
    await h.manager.cancelProcessing(managed.id)
    await h.runtime.onProcessingStopped(managed.id, 'interrupted', managed.processingGeneration)
    expect(managed.activeObjective?.terminalState).toBe('active')
    expect(managed.pendingTurnRecovery).toBeUndefined()
    expect(managed.isProcessing).toBe(false)
    await h.runtime.processEvent(managed, { isError: false, type: 'tool_result', toolName: 'Edit', toolUseId: 'late-call', result: reason,
      executed: false, continuationRequired: true, checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason } }, 1)
    expect(managed.pendingTurnRecovery).toBeUndefined()
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.find(m => m.toolUseId === 'late-call')?.toolExecuted).toBe(false)
  })

  it('retains known counters on an unfinished internal turn, then persists its unexecuted checkpoint for restart', async () => {
    const h = harness(); const managed = h.make('known-checkpoint')
    managed.isProcessing = true; managed.processingGeneration = 1
    managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery!, attempts: 1, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000 }
    managed.messages.push({ id: 'already-written', role: 'tool', content: '', timestamp: 2, toolName: 'Write',
      toolUseId: 'completed-write', toolStatus: 'completed', toolExecuted: true, toolResult: 'Prior work completed.' })
    const before = structuredClone({ objective: managed.activeObjective, recovery: managed.pendingTurnRecovery, receipt: managed.messages[1] })
    await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)
    expect(managed.pendingTurnRecovery).toEqual(before.recovery)
    managed.isProcessing = true
    await checkpoint(h, managed)
    expect(managed.pendingTurnRecovery).toEqual({ ...before.recovery, continuationRequired: true })
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    cold.runtime.processNextQueuedMessage = () => {}
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    expect(restored.pendingTurnRecovery).toMatchObject({ attempts: 2, leaseExpiresAt: before.recovery!.leaseExpiresAt })
    expect(restored.messageQueue).toHaveLength(1)
    expect(requiredTestValue(restored.messageQueue[0]).message).toContain('Do not repeat an external mutation')
    expect(restored.messages.find((m) => m.id === 'already-written')).toEqual(before.receipt)
    expect(requiredTestValue(restored.messages.find((m) => m.toolUseId === 'unexecuted-edit')).toolExecuted).toBe(false)
    expect(restored.activeObjective).toEqual(before.objective)
  })

  it('replays the missing wide-fox marker without inventing an automatic allowance', async () => {
    const h = harness(); const managed = h.make('wide-fox-checkpoint')
    managed.isProcessing = true; managed.processingGeneration = 1; managed.pendingTurnRecovery = undefined
    Object.assign(managed.activeObjective!, { continuationCount: 1, budgetBaselineUsd: 0, tokenBaseline: 0 })
    const beforeObjective = structuredClone(managed.activeObjective)
    await checkpoint(h, managed)
    const recovery = managed.pendingTurnRecovery as Managed['pendingTurnRecovery']
    expect(recovery).toMatchObject({ userMessageId: 'wide-fox-checkpoint-user',
      continuationRequired: true, budgetHistoryUnavailable: true })
    expect(recovery?.exhaustedAt).toBeGreaterThan(0)
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'tool_checkpoint')).toBe(false)
    expect(managed.messageQueue).toEqual([])
    expect(recovery?.attempts).toBe(0)
    managed.activeObjective!.terminalState = 'exhausted'
    await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    await cold.runtime.ensureMessagesLoaded(restored)
    expect(requiredTestValue(restored.pendingTurnRecovery).budgetHistoryUnavailable).toBe(true)
    const preparing = deferred(); const release = deferred(); let dispatch: Promise<void> | undefined
    cold.runtime.getOrCreateAgent = async () => { preparing.resolve(); await release.promise; throw new Error('Synthetic provider boundary') }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    expect(await cold.manager.retryTurn(restored.id, 'wide-fox-checkpoint-user')).toEqual({ status: 'started' })
    await preparing.promise
    expect(requiredTestValue(restored.pendingTurnRecovery).budgetHistoryUnavailable).toBe(true)
    expect(restored.activeObjective).toMatchObject({ ...beforeObjective, terminalState: 'active' })
    expect(restored.messages.filter((m) => m.toolUseId === 'unexecuted-edit')).toHaveLength(1)
    expect(requiredTestValue(restored.messages.find((m) => m.toolUseId === 'unexecuted-edit')).toolExecuted).toBe(false)
    release.resolve(); await dispatch; await cold.manager.cleanup()
  })

  it('directly retries the legacy exhausted wide-fox state without allocating a new automatic budget', async () => {
    const h = harness(); const managed = h.make('legacy-wide-fox')
    managed.pendingTurnRecovery = undefined
    Object.assign(managed.activeObjective!, { terminalState: 'exhausted', continuationCount: 1, budgetBaselineUsd: 0, tokenBaseline: 0 })
    managed.messages.push(
      { id: 'already-written', role: 'tool', content: '', timestamp: 2, toolName: 'Edit', toolUseId: 'completed-edit',
        toolStatus: 'completed', toolExecuted: true, toolResult: 'Prior edit completed.' },
      { id: 'old-checkpoint', role: 'tool', content: '', timestamp: 3, toolName: 'Edit', toolUseId: 'unexecuted-edit',
        toolStatus: 'completed', toolExecuted: false, toolResult: reason, toolCheckpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason } },
    )
    const before = structuredClone({ objective: managed.activeObjective, receipts: managed.messages.slice(1) })
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    await cold.runtime.ensureMessagesLoaded(restored)
    const preparing = deferred(); const release = deferred(); let dispatch: Promise<void> | undefined
    cold.runtime.getOrCreateAgent = async () => { preparing.resolve(); await release.promise; throw new Error('Synthetic legacy Retry boundary') }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    try {
      expect(await cold.manager.retryTurn(restored.id, 'legacy-wide-fox-user')).toEqual({ status: 'started' })
      await preparing.promise
      expect(requiredTestValue(restored.pendingTurnRecovery).budgetHistoryUnavailable).toBe(true)
      expect(requiredTestValue(restored.pendingTurnRecovery).exhaustedAt).toBeGreaterThan(0)
      const expectedObjective = { ...requiredTestValue(before.objective), terminalState: 'active' as const }
      delete expectedObjective.completedAt
      expect(restored.activeObjective).toEqual(expectedObjective)
      expect(Object.hasOwn(requiredTestValue(restored.activeObjective), 'completedAt')).toBe(false)
      expect(restored.messages.filter((m) => m.role === 'tool')).toEqual(before.receipts)
      expect(await cold.runtime.enqueueAutomaticTurnRecovery(restored, 'tool_checkpoint')).toBe(false)
      expect(restored.messageQueue).toEqual([])
      await cold.manager.flushSession(restored.id)
      const header = parseRecoveryJournalObservation(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!)
      expect(requiredTestValue(header.pendingTurnRecovery).budgetHistoryUnavailable).toBe(true)
    } finally {
      release.resolve(); await dispatch; await cold.manager.cleanup()
    }
  })

  it.each(['tool_checkpoint', 'objective_incomplete'] as const)(
    'cannot exhaust a newer human objective when Stop finishes during %s persistence', async cause => {
      process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
      const h = harness(); const managed = h.make(`checkpoint-stop-race-${cause}`)
      managed.activeObjective!.orchestrationMode = 'mission'
      managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery!, attempts: 99 }
      const entered = deferred(); const release = deferred(); let held = false
      const flush = h.manager.flushSession.bind(h.manager)
      h.manager.flushSession = async id => {
        if (!held && managed.pendingTurnRecovery?.exhaustedAt) { held = true; entered.resolve(); await release.promise }
        await flush(id)
      }
      const agent = completeSessionAgentFixture(h.workspace, { getModel: () => 'fixture-model', getSessionId: () => null, setAllSources: () => {},
        isProcessing: () => false, forceAbort: () => {}, dispose: () => {},
        async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
          if (cause === 'tool_checkpoint') {
            yield { type: 'tool_start', toolName: 'Edit', toolUseId: 'live-checkpoint', input: { file_path: '/fixture/pending.json' } }
            yield { isError: false, type: 'tool_result', toolName: 'Edit', toolUseId: 'live-checkpoint', result: reason, executed: false,
              continuationRequired: true, checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason } }
          }
          yield { type: 'text_complete', text: 'Completed.', isIntermediate: false }
          yield { type: 'complete' }
        },
      })
      h.runtime.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
      const sending = h.manager.sendMessage(managed.id, 'Saved scoped internal observation.', undefined, undefined,
        { hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: 'fixture-child' } })
      const nextEntered = deferred(); const nextRelease = deferred(); let newer: Promise<void> | undefined
      try {
        await entered.promise
        expect(managed.pendingTurnRecovery?.lastCause).toBe(cause)
        await h.manager.cancelProcessing(managed.id)
        await h.runtime.onProcessingStopped(managed.id, 'interrupted', managed.processingGeneration)
        expect(managed.stopRequested).toBe(false)
        expect(managed.isProcessing).toBe(false)
        h.runtime.getOrCreateAgent = async () => { nextEntered.resolve(); await nextRelease.promise; throw new Error('Synthetic newer human boundary') }
        newer = h.manager.sendMessage(managed.id, 'New objective: Explain the second isolated fixture.')
        await nextEntered.promise
        const objective = structuredClone(managed.activeObjective)
        const errors = managed.messages.filter(m => m.role === 'error')
        expect(objective?.terminalState).toBe('active')
        release.resolve(); await sending
        expect(managed.activeObjective).toEqual(objective)
        expect(managed.messages.filter(m => m.role === 'error')).toEqual(errors)
      } finally {
        release.resolve(); nextRelease.resolve(); await sending; await newer; await h.manager.cleanup()
      }
    },
  )

  it.each(['tool_checkpoint', 'objective_incomplete', 'premature_final', 'stream_ended'] as const)(
    'explains unavailable legacy budget after %s without claiming a retry limit was reached', async cause => {
      process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
      const h = harness(); const managed = h.make(`legacy-diagnostic-${cause}`)
      managed.activeObjective!.terminalState = 'exhausted'
      managed.activeObjective!.orchestrationMode = 'mission'
      managed.pendingTurnRecovery = undefined
      const agent = completeSessionAgentFixture(h.workspace, { getModel: () => 'fixture-model', getSessionId: () => null, setAllSources: () => {},
        isProcessing: () => false, forceAbort: () => {}, dispose: () => {},
        async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
          if (cause === 'tool_checkpoint') {
            yield { type: 'tool_start', toolName: 'Edit', toolUseId: 'live-checkpoint', input: {} }
            yield { isError: false, type: 'tool_result', toolName: 'Edit', toolUseId: 'live-checkpoint', result: reason, executed: false,
              continuationRequired: true, checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason } }
          }
          if (cause !== 'stream_ended') yield { type: 'text_complete',
            text: cause === 'premature_final' ? 'I will now continue the remaining work.' : 'Completed.', isIntermediate: false }
          yield { type: 'complete' }
        },
      })
      h.runtime.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
      let dispatch: Promise<void> | undefined
      const send = h.manager.sendMessage.bind(h.manager)
      h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
      expect(await h.manager.retryTurn(managed.id, `${managed.id}-user`)).toEqual({ status: 'started' })
      await dispatch
      expect((managed.pendingTurnRecovery as Managed['pendingTurnRecovery'])?.lastCause).toBe(cause)
      const error = managed.messages.filter(m => m.role === 'error').at(-1)
      expect(error?.content).toContain('no recoverable budget history')
      expect(error?.content).not.toContain('retry limit')
      expect(managed.messageQueue).toEqual([])
      expect(managed.messages.filter(m => m.hidden && m.content.includes('<automatic_turn_recovery>'))).toEqual([])
    },
  )

  it('keeps a new human objective intact when restart budget persistence returns late', async () => {
    const h = harness(); const managed = h.make('restart-budget-race')
    managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery!, attempts: 99 }
    const entered = deferred(); const release = deferred(); let held = false
    const flush = h.manager.flushSession.bind(h.manager)
    h.manager.flushSession = async id => {
      if (!held && managed.pendingTurnRecovery?.exhaustedAt) { held = true; entered.resolve(); await release.promise }
      await flush(id)
    }
    const resuming = h.runtime.resumePendingTurnAfterRestart(managed.id)
    const nextEntered = deferred(); const nextRelease = deferred(); let newer: Promise<void> | undefined
    try {
      await entered.promise
      h.runtime.getOrCreateAgent = async () => { nextEntered.resolve(); await nextRelease.promise; throw new Error('Synthetic newer human boundary') }
      newer = h.manager.sendMessage(managed.id, 'New objective: Explain the second isolated fixture.')
      await nextEntered.promise
      const objective = structuredClone(managed.activeObjective)
      const errors = managed.messages.filter(m => m.role === 'error')
      release.resolve(); await resuming
      expect(managed.activeObjective).toEqual(objective)
      expect(managed.activeObjective?.terminalState).toBe('active')
      expect(managed.messages.filter(m => m.role === 'error')).toEqual(errors)
    } finally {
      release.resolve(); nextRelease.resolve(); await resuming; await newer; await h.manager.cleanup()
    }
  })

  it.each(['executed', 'unstructured', 'wrong-kind', 'old-generation', 'stopped', 'terminal', 'changed-objective'])(
    'keeps the receipt without inventing a continuation for %s', async variant => {
      const h = harness(); const managed = h.make(`reject-checkpoint-${variant}`)
      managed.isProcessing = true; managed.processingGeneration = 1; managed.pendingTurnRecovery = undefined
      await h.runtime.processEvent(managed, { type: 'tool_start', toolName: 'Edit', toolUseId: 'unexecuted-edit', input: {} }, 1)
      if (variant === 'old-generation') managed.processingGeneration = 2
      if (variant === 'stopped') managed.stopRequested = true
      if (variant === 'terminal') managed.activeObjective!.terminalState = 'complete_verified'
      if (variant === 'changed-objective') managed.activeObjective!.userMessageId = 'another-objective'
      const checkpoint = { schemaVersion: 1 as const, kind: 'tool-call-budget' as const, reason }
      // Deliberately corrupt the external receipt to exercise rejection of an invalid kind.
      if (variant === 'wrong-kind') Object.defineProperty(checkpoint, 'kind', { value: 'other' })
      await h.runtime.processEvent(managed, { isError: false, type: 'tool_result', toolName: 'Edit', toolUseId: 'unexecuted-edit',
        result: reason, executed: variant === 'executed', continuationRequired: true,
        ...(variant === 'unstructured' ? {} : { checkpoint }) }, 1)
      expect(managed.pendingTurnRecovery).toBeUndefined()
      expect(managed.messages.find(m => m.toolUseId === 'unexecuted-edit')?.toolResult).toBe(reason)
    },
  )
});

describe('cold automatic recovery lease', () => {
  it('quarantines an old marker with its exact receipts and lets only explicit Retry resume it', async () => {
    const h = harness(); const managed = h.make('expired-cold-recovery')
    const now = Date.now()
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      startedAt: now - DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS - 1_000,
      // A previous build may already have touched the old marker and minted a
      // later lease. Cold age remains anchored to the logical turn itself.
      leaseExpiresAt: now + DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS,
      lastAttemptAt: now - 1_000,
      lastCause: 'stream_ended',
      continuationRequired: true,
      validationGaps: ['Verify the existing deployment before any mutation'],
    }
    managed.messages.push({
      id: 'preserved-tool-receipt', role: 'tool', content: '', timestamp: now - 2_000,
      toolName: 'Bash', toolUseId: 'verified-state', toolStatus: 'completed', toolExecuted: true,
      toolResult: 'Existing deployment inspected; no mutation repeated.',
    })
    const recovery = structuredClone(managed.pendingTurnRecovery)
    const receipt = structuredClone(managed.messages[1])
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let automaticStarts = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { automaticStarts++; return true }
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(automaticStarts).toBe(0)
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect<unknown>(restored.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      completedAt: (expect.any(Number) as unknown),
      interruptedTurnRecovery: {
        objectiveId: `${managed.id}-user`,
        userMessageId: `${managed.id}-user`,
        recovery,
      },
    })
    expect(restored.messages.find((message: { id: string }) => message.id === requiredTestValue(receipt).id)).toEqual(receipt)
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(restored.id)).toBe(false)
    expect(sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.has(restored.id)).toBe(false)
    const header = listSessions(h.rootPath).find(meta => meta.id === managed.id)
    expect(header?.pendingTurnRecovery).toBeUndefined()
    expect(header?.activeObjective?.interruptedTurnRecovery?.recovery).toEqual(recovery)

    const sends: Array<Parameters<SessionManager['sendMessage']>> = []
    cold.manager.sendMessage = async (...args: Parameters<SessionManager['sendMessage']>) => {
      sends.push(args)
      args[7]?.(args[5]!)
    }
    expect(await cold.manager.retryTurn(restored.id, `${managed.id}-user`)).toEqual({ status: 'started' })
    expect(sends).toHaveLength(1)
    expect(sends[0]?.[4]?.automaticRecovery).toMatchObject({
      originalUserMessageId: `${managed.id}-user`,
      cause: 'user_retry',
    })
    expect(sends[0]?.[1]).toContain('Verify the existing deployment before any mutation')
  })

  it('still resumes a recent turn and a stale marker backed by one recent durable allocation', async () => {
    const h = harness(); const recent = h.make('recent-cold-recovery'); const allocated = h.make('recent-allocation')
    const now = Date.now()
    allocated.pendingTurnRecovery = {
      ...allocated.pendingTurnRecovery!,
      startedAt: now - DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS - 1_000,
      leaseExpiresAt: now - 1,
      attempts: 1,
      lastAttemptAt: now - 1_000,
      lastCause: 'runtime_error',
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'recent-durable-allocation',
        attempt: 2,
        cause: 'runtime_error',
        origin: 'automatic',
        allocatedAt: now - 500,
        phase: 'allocated',
      },
    }
    await h.save(recent); await h.save(allocated)
    const cold = h.cold()
    const restoredRecent = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(recent.id))
    const restoredAllocated = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(allocated.id))
    const automatic: string[] = []
    cold.runtime.enqueueAutomaticTurnRecovery = async (session: Managed) => {
      automatic.push(session.id); session.isProcessing = true; return true
    }
    cold.runtime.processNextQueuedMessage = () => {}

    await cold.runtime.resumePendingTurnAfterRestart(restoredRecent.id)
    await cold.runtime.resumePendingTurnAfterRestart(restoredAllocated.id)

    expect(automatic).toEqual([recent.id])
    expect(restoredRecent.pendingTurnRecovery).toBeDefined()
    expect(restoredAllocated.activeObjective?.terminalState).toBe('active')
    expect(restoredAllocated.pendingTurnRecovery?.recoveryDispatch?.id).toBe('recent-durable-allocation')
    expect(restoredAllocated.messageQueue).toHaveLength(1)
    expect(restoredAllocated.messageQueue[0]?.options?.automaticRecovery?.dispatchId)
      .toBe('recent-durable-allocation')
  })

  it('does not age out an authenticated explicit Retry marker', async () => {
    const h = harness(); const managed = h.make('old-explicit-retry')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      startedAt: Date.now() - DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS - 1_000,
      lastCause: 'user_retry',
    }
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let resumes = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { resumes++; return true }

    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(resumes).toBe(1)
    expect(restored.activeObjective?.terminalState).toBe('active')
    expect(restored.pendingTurnRecovery?.lastCause).toBe('user_retry')
    expect(restored.activeObjective?.interruptedTurnRecovery).toBeUndefined()
  })

  it('revokes an expired marker from another objective without exhausting the current objective', async () => {
    const h = harness(); const managed = h.make('old-objective-marker')
    const currentObjective = managed.activeObjective!
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      userMessageId: 'superseded-objective-user',
      startedAt: Date.now() - DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS - 1_000,
      lastCause: 'stream_ended',
    }
    managed.messages.push({
      id: 'superseded-objective-user', role: 'user', content: 'Older objective.', timestamp: 0,
    })
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let resumes = 0
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { resumes++; return true }

    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(resumes).toBe(0)
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.activeObjective).toMatchObject({
      objectiveId: currentObjective.objectiveId,
      terminalState: 'active',
    })
    expect(Object.hasOwn(requiredTestValue(restored.activeObjective), 'interruptedTurnRecovery')).toBe(false)
    expect(restored.activeObjective?.interruptedTurnRecovery).toBeUndefined()
    expect(restored.activeObjective?.completedAt).toBeUndefined()
  })
});
