import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { type SessionManagerTestView } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { createAutonomyFallbackIntent } from "./autonomy-browser-fallback";
import { cleanupRestartRecovery, deferred, harness, setAutomaticToolFallback } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('automatic channel-fallback kill switch recovery boundaries', () => {
  it.each([
    ['browser_fallback', 'mcp__crm__lookup', 'automatic_browser_fallback'],
    ['structured_fallback', 'mcp__session__browser_tool', 'automatic_structured_fallback'],
  ] as const)(
    'downgrades an allocated %s to the same generic recovery before FIFO admission',
    async (fallbackKind, failedToolName, specializedMarker) => {
      const h = harness(); const managed = h.make(`routing-off-admission-${fallbackKind}`)
      setAutomaticToolFallback(h, true)
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        attempts: 0,
        stagnantAttempts: 0,
        leaseExpiresAt: Date.now() + 60_000,
      }
      expect(await h.runtime.enqueueAutomaticTurnRecovery(
        managed,
        'runtime_error',
        undefined,
        undefined,
        undefined,
        createAutonomyFallbackIntent(fallbackKind, failedToolName),
      )).toBe(true)
      const allocated = structuredClone(managed.pendingTurnRecovery!.recoveryDispatch!)
      expect(allocated).toMatchObject({
        phase: 'allocated',
        fallbackIntent: { kind: fallbackKind, failedToolName },
      })
      expect(managed.messageQueue).toHaveLength(1)
      expect(managed.messageQueue[0]?.options?.internalOrigin).toEqual({ kind: 'browser-fallback' })
      expect(managed.messageQueue[0]?.message).toContain(`<${specializedMarker}`)

      // The user can disable routing after allocation but before the private
      // FIFO record reaches sendMessage. Admission must re-read that live bit.
      setAutomaticToolFallback(h, false)
      const preparationEntered = deferred(); const releasePreparation = deferred()
      let admittedTurn: Parameters<SessionManagerTestView['getOrCreateAgent']>[1]
      let dispatch: Promise<void> | undefined
      h.runtime.getOrCreateAgent = async (_session, turn) => {
        admittedTurn = structuredClone(turn)
        preparationEntered.resolve()
        await releasePreparation.promise
        throw new Error('Synthetic routing-off provider boundary')
      }
      const send = h.manager.sendMessage.bind(h.manager)
      h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }

      try {
        h.runtime.processNextQueuedMessage(managed.id)
        await preparationEntered.promise
        expect(managed.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
          id: allocated.id,
          attempt: allocated.attempt,
          cause: allocated.cause,
          origin: allocated.origin,
          phase: 'started',
        })
        expect(managed.pendingTurnRecovery?.recoveryDispatch?.fallbackIntent).toBeUndefined()
        expect(admittedTurn?.options).toMatchObject({
          hidden: true,
          automaticRecovery: {
            dispatchId: allocated.id,
            dispatchAttempt: allocated.attempt,
          },
        })
        expect(admittedTurn?.options?.internalOrigin).toBeUndefined()
        expect(admittedTurn?.message).toContain('<automatic_turn_recovery')
        expect(admittedTurn?.message).not.toContain(`<${specializedMarker}`)
        expect(admittedTurn?.message).not.toContain(failedToolName)
        expect(managed.messages.find(message => message.id === allocated.id)).toMatchObject({
          role: 'user', hidden: true, content: admittedTurn?.message,
        })
        expect(managed.messages.find(message => message.id === allocated.id)?.internalOrigin).toBeUndefined()
        const persistedRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
          .trim().split('\n').map(parseRecoveryJournalObservation)
        expect(requiredTestValue(requiredTestValue(persistedRows[0]).pendingTurnRecovery).recoveryDispatch).toMatchObject({
          id: allocated.id,
          attempt: allocated.attempt,
          phase: 'started',
        })
        expect(requiredTestValue(requiredTestValue(requiredTestValue(persistedRows[0]).pendingTurnRecovery).recoveryDispatch).fallbackIntent).toBeUndefined()
        const persistedBoundary = requiredTestValue(persistedRows.find(row => row.id === allocated.id))
        expect(persistedBoundary).toMatchObject({
          type: 'user', hidden: true, content: admittedTurn?.message,
        })
        expect(persistedBoundary.internalOrigin).toBeUndefined()
        expect(persistedBoundary.content).not.toContain(`<${specializedMarker}`)
      } finally {
        releasePreparation.resolve()
        await dispatch?.catch(() => {})
      }
    },
  )

  it.each([
    ['browser_fallback', 'mcp__crm__lookup', 'automatic_browser_fallback'],
    ['structured_fallback', 'mcp__session__browser_tool', 'automatic_structured_fallback'],
  ] as const)(
    'persists cold sanitation of %s and cannot resurrect it on a second restart',
    async (fallbackKind, failedToolName, specializedMarker) => {
      const h = harness(); const managed = h.make(`routing-off-cold-${fallbackKind}`)
      setAutomaticToolFallback(h, true)
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        attempts: 0,
        stagnantAttempts: 0,
        leaseExpiresAt: Date.now() + 60_000,
      }
      expect(await h.runtime.enqueueAutomaticTurnRecovery(
        managed,
        'runtime_error',
        undefined,
        undefined,
        undefined,
        createAutonomyFallbackIntent(fallbackKind, failedToolName),
      )).toBe(true)
      const allocated = structuredClone(managed.pendingTurnRecovery!.recoveryDispatch!)
      expect(allocated.fallbackIntent).toEqual({ kind: fallbackKind, failedToolName })
      const queuedFallback = managed.messageQueue[0]!
      queuedFallback.messageId = allocated.id
      managed.messages.push({
        id: allocated.id,
        role: 'user',
        content: queuedFallback.message,
        timestamp: 2,
        hidden: true,
        isQueued: true,
        internalOrigin: { kind: 'browser-fallback' },
      })
      await h.save(managed)
      setAutomaticToolFallback(h, false)

      const firstCold = h.cold()
      const firstRestored = requiredTestValue(sessionRuntimeStateForTest(firstCold.runtime).sessions.get(managed.id))
      firstCold.runtime.processNextQueuedMessage = () => {}
      await firstCold.runtime.ensureMessagesLoaded(firstRestored)
      await firstCold.manager.flushSession(firstRestored.id)
      expect(firstRestored.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        id: allocated.id,
        attempt: allocated.attempt,
        phase: 'allocated',
      })
      expect(firstRestored.pendingTurnRecovery?.recoveryDispatch?.fallbackIntent).toBeUndefined()
      expect(firstRestored.messageQueue).toHaveLength(1)
      expect(firstRestored.messageQueue[0]?.messageId).toBe(allocated.id)
      expect(firstRestored.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
      expect(firstRestored.messages.find((message) => message.id === allocated.id)?.internalOrigin)
        .toBeUndefined()
      const firstPersistedRows = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
        .trim().split('\n').map(parseRecoveryJournalObservation)
      expect(requiredTestValue(requiredTestValue(firstPersistedRows[0]).pendingTurnRecovery).recoveryDispatch).toMatchObject({
        id: allocated.id,
        attempt: allocated.attempt,
        phase: 'allocated',
      })
      expect(requiredTestValue(requiredTestValue(requiredTestValue(firstPersistedRows[0]).pendingTurnRecovery).recoveryDispatch).fallbackIntent).toBeUndefined()
      const firstPersistedMessage = requiredTestValue(firstPersistedRows.find(row => row.id === allocated.id))
      expect(firstPersistedMessage).toMatchObject({
        type: 'user', hidden: true, isQueued: true,
      })
      expect(firstPersistedMessage.internalOrigin).toBeUndefined()
      expect(firstPersistedMessage.content).toContain('<automatic_turn_recovery')
      expect(firstPersistedMessage.content).not.toContain(`<${specializedMarker}`)
      expect(firstPersistedMessage.content).not.toContain(failedToolName)

      const secondCold = h.cold()
      const secondRestored = requiredTestValue(sessionRuntimeStateForTest(secondCold.runtime).sessions.get(managed.id))
      secondCold.runtime.processNextQueuedMessage = () => {}
      await secondCold.runtime.ensureMessagesLoaded(secondRestored)
      await secondCold.runtime.resumePendingTurnAfterRestart(secondRestored.id)
      expect(secondRestored.pendingTurnRecovery?.recoveryDispatch).toMatchObject({
        id: allocated.id,
        attempt: allocated.attempt,
        phase: 'allocated',
      })
      expect(secondRestored.pendingTurnRecovery?.recoveryDispatch?.fallbackIntent).toBeUndefined()
      expect(secondRestored.messageQueue).toHaveLength(1)
      expect(secondRestored.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
      expect(secondRestored.messageQueue[0]?.messageId).toBe(allocated.id)
      expect(secondRestored.messageQueue[0]?.message).toContain('<automatic_turn_recovery')
      expect(secondRestored.messageQueue[0]?.message).not.toContain(`<${specializedMarker}`)
      expect(secondRestored.messageQueue[0]?.message).not.toContain(failedToolName)
      expect(secondRestored.messages.find((message) => message.id === allocated.id)?.internalOrigin)
        .toBeUndefined()
    },
  )

  it('restarts a started fallback with persisted provider state through one detached clean continuation', async () => {
    const h = harness(); const managed = h.make('routing-off-started-provider-state')
    setAutomaticToolFallback(h, true)
    const allocatedAt = Date.now() - 3_000
    const startedAt = allocatedAt + 1_000
    const dispatchId = 'routing-off-started-provider-state-dispatch'
    const fallbackIntent = createAutonomyFallbackIntent(
      'structured_fallback',
      'mcp__session__browser_tool',
    )
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 1,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      lastCause: 'runtime_error',
      validationGaps: ['finish and verify the preserved objective'],
      recoveryDispatch: {
        schemaVersion: 1,
        id: dispatchId,
        attempt: 2,
        cause: 'runtime_error',
        origin: 'automatic',
        allocatedAt,
        phase: 'started',
        startedAt,
        preToolExecutionReceiptVersion: 1,
        fallbackIntent,
      },
    }
    const specializedPrompt = h.runtime.buildRecoveryDispatchMessage(
      managed,
      managed.pendingTurnRecovery,
      requiredTestValue(managed.pendingTurnRecovery.recoveryDispatch),
    )
    managed.messages.push({
      id: dispatchId,
      role: 'user',
      content: specializedPrompt,
      timestamp: startedAt + 1,
      hidden: true,
      internalOrigin: { kind: 'browser-fallback' },
    })
    managed.sdkSessionId = 'persisted-provider-session'
    managed.branchFromSdkSessionId = 'persisted-provider-parent'
    managed.branchFromSessionPath = '/fixture/provider-session.jsonl'
    managed.branchFromSdkCwd = '/fixture/worktree'
    managed.branchFromSdkTurnId = 'persisted-provider-turn'
    managed.branchContextStrategy = 'sdk-fork'
    managed.branchSeedApplied = false
    managed.providerContextBoundaryMessageId = managed.activeObjective!.userMessageId
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000,
      contextTokensBefore: 120_000,
      outcome: 'succeeded',
      objectiveRootId: managed.activeObjective!.userMessageId,
      providerContextBaselineTokens: 120_000,
    }
    await h.save(managed)
    setAutomaticToolFallback(h, false)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let scheduled = 0
    cold.runtime.processNextQueuedMessage = () => { scheduled++ }
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(scheduled).toBe(1)
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 1,
      cleanContextBoundaryMessageId: dispatchId,
      recoveryDispatch: {
        id: dispatchId,
        attempt: 2,
        cause: 'runtime_error',
        origin: 'automatic',
        phase: 'allocated',
      },
    })
    expect(restored.pendingTurnRecovery?.recoveryDispatch?.cleanContinuationId).toMatch(/^clean-continuation-v1-[a-f0-9]{24}$/)
    expect(requiredTestValue(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).fallbackIntent).toBeUndefined()
    expect(restored.messageQueue).toHaveLength(1)
    expect(restored.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
    expect(restored.messageQueue[0]?.options?.automaticRecovery).toMatchObject({
      dispatchId,
      dispatchAttempt: 2,
      dispatchOrigin: 'automatic',
    })
    expect(restored.messageQueue[0]?.message).toContain('<host_clean_recovery_continuation')
    expect(restored.messageQueue[0]?.message).not.toContain('<automatic_structured_fallback')
    expect(restored.messageQueue[0]?.message).not.toContain('mcp__session__browser_tool')
    expect(restored.messages.some((message: { id: string }) => message.id === dispatchId)).toBe(false)
    expect(restored.sdkSessionId).toBeUndefined()
    expect(restored.branchFromSdkSessionId).toBeUndefined()
    expect(restored.branchFromSessionPath).toBeUndefined()
    expect(restored.branchFromSdkCwd).toBeUndefined()
    expect(restored.branchFromSdkTurnId).toBeUndefined()
    expect(restored.branchContextStrategy).toBeUndefined()
    expect(restored.branchSeedApplied).toBe(true)
    expect(restored.providerContextBoundaryMessageId).toBe(dispatchId)
    expect(restored.contextCompactionAttempt).toBeUndefined()

    const persisted = parseRecoveryJournalObservation(
      requiredTestValue(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]),
    )
    expect<unknown>(persisted.pendingTurnRecovery).toEqual(restored.pendingTurnRecovery)
    expect(persisted.sdkSessionId).toBeUndefined()
    expect(persisted.branchFromSdkSessionId).toBeUndefined()
    expect(persisted.branchFromSessionPath).toBeUndefined()
    expect(persisted.branchFromSdkCwd).toBeUndefined()
    expect(persisted.branchFromSdkTurnId).toBeUndefined()
    expect(persisted.branchContextStrategy).toBeUndefined()
    expect(persisted.providerContextBoundaryMessageId).toBe(dispatchId)
    expect(persisted.contextCompactionAttempt).toBeUndefined()
  })

  it('spends a started fallback with provider output and allocates a new detached clean restart after OFF', async () => {
    const h = harness(); const managed = h.make('routing-off-started-provider-output')
    setAutomaticToolFallback(h, true)
    const allocatedAt = Date.now() - 4_000
    const startedAt = allocatedAt + 1_000
    const oldDispatchId = 'routing-off-started-provider-output-old-dispatch'
    const fallbackIntent = createAutonomyFallbackIntent(
      'browser_fallback',
      'mcp__crm__lookup',
    )
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 1,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      lastCause: 'runtime_error',
      continuationRequired: true,
      validationGaps: ['finish and verify the preserved objective'],
      recoveryDispatch: {
        schemaVersion: 1,
        id: oldDispatchId,
        attempt: 1,
        cause: 'runtime_error',
        origin: 'automatic',
        allocatedAt,
        phase: 'started',
        startedAt,
        preToolExecutionReceiptVersion: 1,
        fallbackIntent,
      },
    }
    const oldFallbackPrompt = h.runtime.buildRecoveryDispatchMessage(
      managed,
      managed.pendingTurnRecovery,
      requiredTestValue(managed.pendingTurnRecovery.recoveryDispatch),
    )
    managed.messages.push({
      id: oldDispatchId,
      role: 'user',
      content: oldFallbackPrompt,
      timestamp: startedAt + 1,
      hidden: true,
      internalOrigin: { kind: 'browser-fallback' },
    }, {
      id: 'persisted-provider-intermediate-output',
      role: 'assistant',
      content: 'The provider began the fallback but did not finish the objective.',
      timestamp: startedAt + 2,
      isIntermediate: true,
    })
    managed.sdkSessionId = 'persisted-output-provider-session'
    managed.branchFromSdkSessionId = 'persisted-output-provider-parent'
    managed.branchFromSessionPath = '/fixture/output-provider-session.jsonl'
    managed.branchFromSdkCwd = '/fixture/output-worktree'
    managed.branchFromSdkTurnId = 'persisted-output-provider-turn'
    managed.branchContextStrategy = 'sdk-fork'
    managed.branchSeedApplied = false
    managed.providerContextBoundaryMessageId = managed.activeObjective!.userMessageId
    managed.contextCompactionAttempt = {
      attemptedAt: allocatedAt - 1_000,
      contextTokensBefore: 120_000,
      outcome: 'succeeded',
      objectiveRootId: managed.activeObjective!.userMessageId,
      providerContextBaselineTokens: 120_000,
    }
    await h.save(managed)
    setAutomaticToolFallback(h, false)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let scheduled = 0
    cold.runtime.processNextQueuedMessage = () => { scheduled++ }
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(scheduled).toBe(1)
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      recoveryDispatch: {
        attempt: 2,
        cause: 'app_restart',
        origin: 'restart',
        phase: 'allocated',
      },
    })
    const newDispatch = requiredTestValue(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch)
    expect(newDispatch.cleanContinuationId).toMatch(/^clean-continuation-v1-[a-f0-9]{24}$/)
    expect(newDispatch.id).not.toBe(oldDispatchId)
    expect(newDispatch.fallbackIntent).toBeUndefined()
    expect(requiredTestValue(restored.pendingTurnRecovery).cleanContextBoundaryMessageId).toBe(newDispatch.id)
    expect(restored.messages.filter((message) => message.id === oldDispatchId)).toHaveLength(1)
    expect(restored.messages.find((message) => (
      message.id === 'persisted-provider-intermediate-output'
    ))).toMatchObject({ role: 'assistant', isIntermediate: true })
    expect(restored.messageQueue).toHaveLength(1)
    expect(restored.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
    expect(restored.messageQueue[0]?.options?.automaticRecovery).toMatchObject({
      dispatchId: newDispatch.id,
      dispatchAttempt: 2,
      dispatchOrigin: 'restart',
    })
    expect(restored.messageQueue[0]?.message).toContain('<host_clean_recovery_continuation')
    expect(restored.messageQueue[0]?.message).not.toContain('<automatic_browser_fallback')
    expect(restored.messageQueue[0]?.message).not.toContain('mcp__crm__lookup')
    expect(restored.sdkSessionId).toBeUndefined()
    expect(restored.branchFromSdkSessionId).toBeUndefined()
    expect(restored.branchFromSessionPath).toBeUndefined()
    expect(restored.branchFromSdkCwd).toBeUndefined()
    expect(restored.branchFromSdkTurnId).toBeUndefined()
    expect(restored.branchContextStrategy).toBeUndefined()
    expect(restored.branchSeedApplied).toBe(true)
    expect(restored.providerContextBoundaryMessageId).toBe(newDispatch.id)
    expect(restored.contextCompactionAttempt).toBeUndefined()
    const persistedRows = readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
    const persistedHeader = requiredTestValue(persistedRows[0])
    expect<unknown>(persistedHeader.pendingTurnRecovery).toEqual(restored.pendingTurnRecovery)
    expect(persistedHeader.sdkSessionId).toBeUndefined()
    expect(persistedHeader.branchFromSdkSessionId).toBeUndefined()
    expect(persistedHeader.branchFromSessionPath).toBeUndefined()
    expect(persistedHeader.branchFromSdkCwd).toBeUndefined()
    expect(persistedHeader.branchFromSdkTurnId).toBeUndefined()
    expect(persistedHeader.branchContextStrategy).toBeUndefined()
    expect(persistedHeader.providerContextBoundaryMessageId).toBe(newDispatch.id)
    expect(persistedHeader.contextCompactionAttempt).toBeUndefined()
    expect(persistedRows.filter(row => row.id === oldDispatchId)).toHaveLength(1)
    expect(persistedRows.find(row => row.id === 'persisted-provider-intermediate-output'))
      .toMatchObject({ type: 'assistant', isIntermediate: true })
  })
});
