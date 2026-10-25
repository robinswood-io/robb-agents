import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as config from "@craft-agent/shared/config";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { SessionManager } from "./SessionManager";
import { createPendingTurnRecovery } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, harness, managers, spies } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('persists an exhausted validated continuation as an interrupted Retry snapshot', async () => {
    const h = harness(); const managed = h.make('exhausted-objective-continuation')
    writeFileSync(join(h.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: h.workspace.id,
      name: h.workspace.name,
      slug: 'exhausted-objective-continuation',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxValidatedContinuationAttempts: 2 } },
    }))
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 2, stagnantAttempts: 0,
      lastCause: 'objective_continue',
      continuationWork: ['Run the final verification'],
      continuationOrigin: 'objective_continue',
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed, 'objective_continue', [], ['Run the final verification'],
    )).toBe(false)
    expect(managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
    managed.activeObjective!.terminalState = 'exhausted'
    managed.isProcessing = true
    managed.processingGeneration = 1
    await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)

    expect(managed.pendingTurnRecovery).toBeUndefined()
    const interruptedRecovery = managed.activeObjective?.interruptedTurnRecovery?.recovery
    expect(interruptedRecovery?.exhaustedAt).toBeNumber()
    expect(managed.activeObjective?.interruptedTurnRecovery).toMatchObject({
      objectiveId: `${managed.id}-user`,
      userMessageId: `${managed.id}-user`,
      recovery: {
        attempts: 2,
        lastCause: 'objective_continue',
        continuationWork: ['Run the final verification'],
        continuationOrigin: 'objective_continue',
      },
    })
    expect(h.events.some(event => event.type === 'typed_error'
      && event.error?.code === 'objective_validation_failed')).toBe(false)

    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    await cold.runtime.ensureMessagesLoaded(restored)
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(requiredTestValue(restored.activeObjective).interruptedTurnRecovery?.recovery).toMatchObject({
      attempts: 2, lastCause: 'objective_continue',
      continuationWork: ['Run the final verification'],
      continuationOrigin: 'objective_continue',
    })
    expect(requiredTestValue(restored.activeObjective).interruptedTurnRecovery?.recovery.exhaustedAt)
      .toBe(interruptedRecovery?.exhaustedAt)

    let retryBudget: Managed['pendingTurnRecovery']
    let retryPrompt = ''
    const agent = new ScriptedSessionAgent(restored.workspace, {
      async *chat(message: string) {
        retryBudget = structuredClone(restored.pendingTurnRecovery)
        retryPrompt = message
        yield { type: 'typed_error', error: { code: 'network_error', title: 'Fixture stop', message: 'stop', actions: [], canRetry: true } }
        yield { type: 'complete' }
      },
    })
    cold.runtime.getOrCreateAgent = async () => { restored.agent = agent; return agent }
    let dispatch: Promise<void> | undefined
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    expect(await cold.manager.retryTurn(restored.id, `${managed.id}-user`)).toEqual({ status: 'started' })
    await dispatch
    expect(retryBudget).toMatchObject({
      attempts: 2, exhaustedAt: expect.any(Number), lastCause: 'user_retry',
      continuationWork: ['Run the final verification'],
      continuationOrigin: 'objective_continue',
    })
    expect(retryPrompt).toContain('recovery event did not replace')
    expect(retryPrompt).toContain('Run the final verification')
  })

  it.each(['runtime_error', 'stream_ended', 'premature_final'] as const)(
    'moves an exhausted validated continuation into its live Retry snapshot after %s', async cause => {
      const h = harness(); const managed = h.make(`live-exhausted-${cause}`)
      const exhaustedAttempts = config.resolveAgentCostControlPolicy().recovery.maxAutomaticAttempts
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!, attempts: exhaustedAttempts, stagnantAttempts: 0,
        lastCause: 'objective_continue',
        continuationWork: ['Verify the installed candidate'],
        continuationOrigin: 'objective_continue',
      }
      expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, cause)).toBe(false)
      expect(managed.pendingTurnRecovery?.lastCause).toBe(cause)
      expect(managed.pendingTurnRecovery?.exhaustedAt).toBeNumber()
      expect(managed.pendingTurnRecovery?.continuationOrigin).toBe('objective_continue')
      managed.isProcessing = true
      managed.processingGeneration = 1

      await h.runtime.onProcessingStopped(managed.id, 'error', 1)

      expect(managed.pendingTurnRecovery).toBeUndefined()
      expect(managed.activeObjective).toMatchObject({
        terminalState: 'exhausted',
        interruptedTurnRecovery: {
          objectiveId: `${managed.id}-user`,
          userMessageId: `${managed.id}-user`,
          recovery: {
            lastCause: cause,
            exhaustedAt: expect.any(Number),
            continuationWork: ['Verify the installed candidate'],
            continuationOrigin: 'objective_continue',
          },
        },
      })
    },
  )

  it('preserves an authenticated automation root through live continuation exhaustion', async () => {
    const h = harness(); const managed = h.make('live-exhausted-automation')
    const exhaustedAttempts = config.resolveAgentCostControlPolicy().recovery.maxAutomaticAttempts
    managed.triggeredBy = { automationName: 'Daily verification', timestamp: 1 }
    managed.messages[0]!.internalOrigin = { kind: 'automation' }
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: exhaustedAttempts, stagnantAttempts: 0,
      lastCause: 'objective_continue', continuationWork: ['Verify the automation result'],
      continuationOrigin: 'objective_continue',
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'stream_ended')).toBe(false)
    managed.isProcessing = true
    managed.processingGeneration = 1

    await h.runtime.onProcessingStopped(managed.id, 'error', 1)

    expect(managed.pendingTurnRecovery).toBeUndefined()
    expect(managed.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      interruptedTurnRecovery: {
        objectiveId: `${managed.id}-user`,
        userMessageId: `${managed.id}-user`,
        recovery: {
          exhaustedAt: expect.any(Number),
          continuationWork: ['Verify the automation result'],
          continuationOrigin: 'objective_continue',
        },
      },
    })
  })

  it('does not invent a continuation snapshot from an unrelated exhausted premature final', async () => {
    const h = harness(); const managed = h.make('live-exhausted-unrelated-premature')
    const exhaustedAttempts = config.resolveAgentCostControlPolicy().recovery.maxAutomaticAttempts
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: exhaustedAttempts, stagnantAttempts: 0,
      lastCause: 'premature_final', continuationWork: ['Untrusted prose-derived work'],
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'premature_final')).toBe(false)
    managed.isProcessing = true
    managed.processingGeneration = 1

    await h.runtime.onProcessingStopped(managed.id, 'error', 1)

    expect(managed.activeObjective?.interruptedTurnRecovery).toBeUndefined()
    expect(managed.activeObjective?.terminalState).toBe('active')
    expect(managed.pendingTurnRecovery?.continuationOrigin).toBeUndefined()
  })

  it('finishes the interrupted-continuation snapshot transition during cold metadata hydration', async () => {
    const h = harness(); const managed = h.make('cold-exhausted-objective-continuation')
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 2, exhaustedAt: 10,
      lastCause: 'stream_ended',
      continuationWork: ['Verify the installed candidate'],
      continuationOrigin: 'objective_continue',
    }
    await h.save(managed)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = new SessionManager(); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)
    runtime.loadSessionsFromDisk()
    const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(managed.id))

    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      interruptedTurnRecovery: {
        objectiveId: `${managed.id}-user`,
        recovery: {
          attempts: 2, exhaustedAt: 10, lastCause: 'stream_ended',
          continuationWork: ['Verify the installed candidate'],
          continuationOrigin: 'objective_continue',
        },
      },
    })
    await restarted.flushSession(restored.id)
    const header = JSON.parse(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!)
    expect(header.pendingTurnRecovery).toBeUndefined()
    expect(header.activeObjective.interruptedTurnRecovery.recovery.continuationWork)
      .toEqual(['Verify the installed candidate'])
  })

  it('preserves an authenticated automation root during cold exhaustion hydration', async () => {
    const h = harness(); const managed = h.make('cold-exhausted-automation')
    managed.triggeredBy = { automationName: 'Daily verification', timestamp: 1 }
    managed.messages[0]!.internalOrigin = { kind: 'automation' }
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 2, exhaustedAt: 10,
      lastCause: 'stream_ended', continuationWork: ['Verify the automation result'],
      continuationOrigin: 'objective_continue',
    }
    await h.save(managed)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = new SessionManager(); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)

    runtime.loadSessionsFromDisk()
    const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(managed.id))

    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      interruptedTurnRecovery: {
        objectiveId: `${managed.id}-user`,
        userMessageId: `${managed.id}-user`,
        recovery: {
          exhaustedAt: 10,
          continuationWork: ['Verify the automation result'],
          continuationOrigin: 'objective_continue',
        },
      },
    })
  })

  it('revokes an exhausted objective A continuation during cold hydration instead of snapshotting it under B', async () => {
    const h = harness(); const managed = h.make('cold-exhausted-stale-objective')
    managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery('old-objective-A'),
      attempts: 2, exhaustedAt: 10, lastCause: 'stream_ended',
      continuationWork: ['Old objective A work'],
      continuationOrigin: 'objective_continue',
    }
    await h.save(managed)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = new SessionManager(); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)

    runtime.loadSessionsFromDisk()
    const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(managed.id))

    expect(restored.messagesLoaded).toBe(true)
    expect(requiredTestValue(restored.activeObjective).terminalState).toBe('active')
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(requiredTestValue(restored.activeObjective).interruptedTurnRecovery).toBeUndefined()
    expect(runtime.getInterruptedTurnRecovery(restored, `${managed.id}-user`)).toBeUndefined()
    await restarted.flushSession(restored.id)
    const header = JSON.parse(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!)
    expect(header.pendingTurnRecovery).toBeUndefined()
    expect(header.activeObjective.interruptedTurnRecovery).toBeUndefined()
  })
});
