import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { listSessions } from "@craft-agent/shared/sessions/storage";
import { cleanupRestartRecovery, type Managed, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('keeps a newly acknowledged user message dispatchable if shutdown happens before its turn marker', async () => {
    const h = harness(); const managed = h.make('new-ack')
    managed.messages = []; managed.activeObjective = undefined; managed.pendingTurnRecovery = undefined
    let cleanup: Promise<void> | undefined
    let acknowledged = ''
    h.runtime.getOrCreateAgent = async () => { throw new Error('Must not start while closing') }
    await h.manager.sendMessage(managed.id, 'Explain without tools.', undefined, undefined, undefined, undefined, false, id => {
      acknowledged = id
      const header = listSessions(h.rootPath)[0]!
      expect(header.pendingQueuedMessageIds).toEqual([id])
      cleanup = h.manager.cleanup()
    })
    await cleanup
    expect(acknowledged).not.toBe('')
    const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
    const calls: string[] = []
    cold.runtime.sendMessage = async (...args) => { calls.push(requiredTestValue(args[5])) }
    await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
    await tick(); await tick()
    expect(calls).toEqual([acknowledged])
  })

  it('does not resume Stop, exhausted validation, pending questions, permissions or authentication; an independent sibling can resume', async () => {
    const h = harness()
    const stopped = h.make('stopped'); stopped.pendingTurnRecovery = undefined
    const exhausted = h.make('exhausted'); exhausted.activeObjective!.terminalState = 'exhausted'
    Object.assign(exhausted.pendingTurnRecovery!, { exhaustedAt: 3, validationExhausted: true, validationGaps: ['check missing'] })
    const parent = h.make('parent'); const child = h.make('question', 'parent')
    child.userInputRequests = [{ id: 'question-id', sessionId: child.id, originWorkspaceId: h.workspace.id,
      objectiveId: child.activeObjective!.objectiveId, status: 'pending', questions: [], createdAt: 2 } as never]
    const permission = h.make('permission')
    permission.pendingTurnRecovery!.waitingForPermission = { requestId: 'approval', requestedAt: 2, toolName: 'Bash' }
    const auth = h.make('auth')
    auth.messages.push({ id: 'auth-message', role: 'auth-request', content: 'Credentials required', timestamp: 2,
      authRequestId: 'auth-id', authRequestType: 'credential', authSourceSlug: 'source', authSourceName: 'Source', authStatus: 'pending', authCredentialMode: 'bearer' })
    const sibling = h.make('sibling', 'parent')
    for (const session of [stopped, exhausted, parent, child, permission, auth, sibling]) await h.save(session)
    const cold = h.cold(); const resumed: string[] = []
    cold.runtime.enqueueAutomaticTurnRecovery = async (session: Managed) => { resumed.push(session.id); return false }
    await cold.runtime.resumePendingTurnsAfterRestart([...sessionRuntimeStateForTest(cold.runtime).sessions.keys()])
    expect(resumed).toEqual(['sibling'])
    expect(requiredTestValue(requiredTestValue(requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get('permission')).pendingTurnRecovery).waitingForPermission).recoveryRequired).toBe(true)
    expect(requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get('auth')).pendingAuthRequest).toMatchObject({ requestId: 'auth-id', type: 'credential', sourceSlug: 'source', mode: 'bearer' })
    expect(requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get('exhausted')).pendingTurnRecovery).toEqual(exhausted.pendingTurnRecovery)
  })

  it('reserves one restart attempt when concurrent callers reach an async recovery boundary', async () => {
    const h = harness(); const managed = h.make('concurrent'); await h.save(managed)
    const paused = deferred(); let attempts = 0
    h.runtime.enqueueAutomaticTurnRecovery = async () => { attempts++; await paused.promise; return false }
    const first = h.runtime.resumePendingTurnAfterRestart(managed.id)
    const second = h.runtime.resumePendingTurnAfterRestart(managed.id)
    await tick(); expect(attempts).toBe(1)
    paused.resolve(); await Promise.all([first, second])
    expect(attempts).toBe(1)
  })

  it('requires an explicit retry after a restored permission wait and can deliver its already-saved FIFO without granting it', async () => {
    const h = harness(); const managed = h.make('permission-inbox')
    managed.pendingTurnRecovery!.waitingForPermission = { requestId: 'old-permission', requestedAt: 1, toolName: 'Bash', recoveryRequired: true }
    managed.messages.push({ id: 'followup', role: 'user', content: 'Keep the existing destination.', timestamp: 2, isQueued: true })
    managed.messageQueue.push({ messageId: 'followup', message: 'Keep the existing destination.' })
    const calls: unknown[][] = []
    h.manager.sendMessage = async (...args) => { calls.push(args); requiredTestValue(args[7])('followup') }
    h.runtime.processNextQueuedMessage(managed.id); await tick()
    expect(calls).toHaveLength(0)
    expect(await h.manager.retryTurn(managed.id, `${managed.id}-user`)).toEqual({ status: 'started' })
    expect(calls[0]?.[5]).toBe('followup')
    expect(calls[0]?.[1]).toBe('Keep the existing destination.')
    expect(managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
    expect(sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.size).toBe(0)
    expect(managed.messages).toHaveLength(2)
  })

  it('restores the obsolete permission marker and FIFO on a failed durable retry acknowledgement', async () => {
    const h = harness(); const managed = h.make('permission-rollback')
    managed.pendingTurnRecovery!.waitingForPermission = { requestId: 'old-permission', requestedAt: 1, toolName: 'Bash', recoveryRequired: true }
    managed.messages.push({ id: 'followup', role: 'user', content: 'Keep the target.', timestamp: 2, isQueued: true })
    managed.messageQueue.push({ messageId: 'followup', message: 'Keep the target.' })
    const marker = structuredClone(managed.pendingTurnRecovery)
    h.manager.sendMessage = async () => { throw new Error('ENOSPC') }
    await expect(h.manager.retryTurn(managed.id, `${managed.id}-user`)).rejects.toThrow('ENOSPC')
    expect(managed.pendingTurnRecovery).toEqual(marker)
    expect(managed.messageQueue.map(item => item.messageId)).toEqual(['followup'])
    expect(managed.messages.find(message => message.id === 'followup')?.isQueued).toBe(true)
    expect(managed.isProcessing).toBe(false)
  })

  it('retries a transient deferred-scheduler failure with backoff and no external wake', async () => {
    const h = harness(); const managed = h.make('scheduler-backoff')
    sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.add(managed.id)
    let attempts = 0
    h.runtime.resumePendingTurnAfterRestart = async () => {
      attempts++
      if (attempts === 1) throw new Error('transient scheduler fault')
      sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.delete(managed.id)
    }

    await h.runtime.drainDeferredAutomaticSessions()
    expect(attempts).toBe(1)
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.has(managed.id)).toBe(true)
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticRetryTimers.has(managed.id)).toBe(true)
    await Bun.sleep(350)
    await tick(); await tick()
    expect(attempts).toBe(2)
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.has(managed.id)).toBe(false)
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticRetryTimers.has(managed.id)).toBe(false)
  })
});
