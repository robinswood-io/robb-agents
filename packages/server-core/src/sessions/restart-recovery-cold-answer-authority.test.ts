import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { listSessions } from "@craft-agent/shared/sessions/storage";
import { createManagedSession } from "./SessionManager";
import { DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('lets an authenticated cold user_retry reactivate its terminal objective', async () => {
    const h = harness(); const managed = h.make('terminal-user-retry')
    managed.sessionStatus = 'todo'
    managed.activeObjective!.terminalState = 'exhausted'
    managed.activeObjective!.completedAt = 2
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      lastCause: 'user_retry',
      exhaustedAt: undefined,
      validationExhausted: undefined,
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const resumed: string[] = []
    cold.runtime.enqueueAutomaticTurnRecovery = async (session: Managed) => {
      resumed.push(session.id)
      expect(session.activeObjective?.terminalState).toBe('active')
      return false
    }
    await cold.runtime.resumePendingTurnsAfterRestart([restored.id])

    expect(resumed).toEqual([managed.id])
    expect(restored.activeObjective).toMatchObject({ terminalState: 'active' })
    expect(requiredTestValue(restored.activeObjective).completedAt).toBeUndefined()
  })

  it('lets an authenticated cold pending answer reactivate its terminal objective', async () => {
    const h = harness(); const managed = h.make('terminal-pending-answer')
    const questions = [{ id: 'scope', question: 'Which scope?', options: [{ id: 'saved', label: 'Saved' }] }]
    const answers = [{ questionId: 'scope', optionIds: ['saved'] }]
    const answerContent = USER_INPUT_ANSWER_MESSAGE_PREFIX
      + JSON.stringify({ requestId: 'saved-question', questions, answers })
    managed.sessionStatus = 'todo'
    managed.activeObjective!.terminalState = 'blocked_human'
    managed.activeObjective!.completedAt = 2
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      startedAt: Date.now() - DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS - 1_000,
      userMessageId: 'saved-answer',
      lastCause: 'objective_incomplete',
    }
    managed.messages.push({
      id: 'saved-answer', role: 'user',
      content: answerContent,
      timestamp: 3,
      hidden: true, isQueued: true, internalOrigin: { kind: 'user-input' },
    })
    managed.messageQueue = [{
      message: answerContent, messageId: 'saved-answer',
      options: { hidden: true, internalOrigin: { kind: 'user-input' } },
    }]
    managed.userInputRequests = [{
      id: 'saved-question', sessionId: managed.id, originWorkspaceId: managed.workspace.id,
      questions,
      status: 'answered', createdAt: 2, answeredAt: 3,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      responseMessageId: 'saved-answer', answers,
    }]
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const dequeues: string[] = []
    cold.runtime.processNextQueuedMessage = (sessionId: string) => {
      dequeues.push(sessionId)
      expect(restored.activeObjective?.terminalState).toBe('active')
    }
    await cold.runtime.resumePendingTurnsAfterRestart([restored.id])
    await tick(); await tick()

    expect(dequeues).toEqual([managed.id])
    expect(restored.activeObjective).toMatchObject({ terminalState: 'active' })
    expect(requiredTestValue(restored.activeObjective).completedAt).toBeUndefined()
  })

  it.each(['missing', 'duplicated', 'wrong-objective'] as const)(
    'revokes a terminal cold user_retry with %s provenance without starting a provider', async variant => {
      const h = harness(); const managed = h.make(`stale-terminal-retry-${variant}`)
      managed.sessionStatus = 'todo'
      managed.activeObjective!.terminalState = 'exhausted'
      managed.activeObjective!.completedAt = 2
      const staleId = `stale-anchor-${variant}`
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        userMessageId: staleId,
        lastCause: 'user_retry',
        exhaustedAt: undefined,
        validationExhausted: undefined,
      }
      if (variant === 'duplicated') {
        managed.activeObjective!.lastUserMessageId = staleId
        managed.messages.push(
          { id: staleId, role: 'user', content: 'Duplicate retry anchor.', timestamp: 2 },
          { id: staleId, role: 'user', content: 'Duplicate retry anchor.', timestamp: 3 },
        )
      } else if (variant === 'wrong-objective') {
        managed.messages.push({ id: staleId, role: 'user', content: 'Old objective anchor.', timestamp: 2 })
      }
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      let providerStarts = 0
      cold.runtime.getOrCreateAgent = async () => { providerStarts++; throw new Error('No provider expected') }
      sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.add(managed.id)
      sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.add(managed.id)
      await cold.runtime.resumePendingTurnAfterRestart(managed.id)

      expect(providerStarts).toBe(0)
      expect(restored.pendingTurnRecovery).toBeUndefined()
      expect(restored.activeObjective).toMatchObject({ terminalState: 'exhausted', completedAt: 2 })
      expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(managed.id)).toBe(false)
      expect(sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.has(managed.id)).toBe(false)
      expect(listSessions(h.rootPath).find(meta => meta.id === managed.id)?.pendingTurnRecovery).toBeUndefined()
    },
  )

  it('revokes a cold user_retry from an older objective even while the current objective is active', async () => {
    const h = harness(); const managed = h.make('stale-active-user-retry')
    managed.sessionStatus = 'todo'
    managed.messages.push({
      id: 'older-objective-anchor', role: 'user', content: 'An older objective.', timestamp: 2,
    })
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      userMessageId: 'older-objective-anchor',
      lastCause: 'user_retry',
      exhaustedAt: undefined,
      validationExhausted: undefined,
    }
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let providerStarts = 0
    cold.runtime.getOrCreateAgent = async () => { providerStarts++; throw new Error('No provider expected') }
    sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.add(managed.id)
    sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.add(managed.id)
    await cold.runtime.resumePendingTurnAfterRestart(managed.id)

    expect(providerStarts).toBe(0)
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.activeObjective?.terminalState).toBe('active')
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(managed.id)).toBe(false)
    expect(sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.has(managed.id)).toBe(false)
    expect(listSessions(h.rootPath).find(meta => meta.id === managed.id)?.pendingTurnRecovery).toBeUndefined()
  })

  it('does not reactivate a terminal objective from an already-consumed saved answer', async () => {
    const h = harness(); const managed = h.make('terminal-consumed-answer')
    managed.sessionStatus = 'todo'
    managed.activeObjective!.terminalState = 'blocked_human'
    managed.activeObjective!.completedAt = 2
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      userMessageId: 'consumed-answer',
      lastCause: 'objective_incomplete',
    }
    managed.messages.push({
      id: 'consumed-answer', role: 'user', content: 'Use the already-consumed scope.', timestamp: 3,
      hidden: true, isQueued: false, internalOrigin: { kind: 'user-input' },
    })
    managed.userInputRequests = [{
      id: 'consumed-question', sessionId: managed.id, originWorkspaceId: managed.workspace.id,
      questions: [{ id: 'scope', question: 'Which scope?', options: [{ id: 'saved', label: 'Saved' }] }],
      status: 'answered', createdAt: 2, answeredAt: 3,
      objectiveUserMessageId: managed.activeObjective!.userMessageId,
      responseMessageId: 'consumed-answer', answers: [{ questionId: 'scope', optionIds: ['saved'] }],
    }]
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let providerStarts = 0
    cold.runtime.getOrCreateAgent = async () => { providerStarts++; throw new Error('No provider expected') }
    sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.add(managed.id)
    sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.add(managed.id)
    await cold.runtime.resumePendingTurnAfterRestart(managed.id)

    expect(providerStarts).toBe(0)
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.activeObjective).toMatchObject({ terminalState: 'blocked_human', completedAt: 2 })
    expect(restored.messages.find((message: { id: string; isQueued?: boolean }) => message.id === 'consumed-answer')?.isQueued).toBe(false)
    expect(restored.messageQueue).toEqual([])
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(managed.id)).toBe(false)
    expect(sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.has(managed.id)).toBe(false)
    expect(listSessions(h.rootPath).find(meta => meta.id === managed.id)?.pendingTurnRecovery).toBeUndefined()
  })

  it('revalidates the exact managed instance after cold hydration before resuming', async () => {
    const h = harness(); const managed = h.make('replaced-during-hydration')
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const replacement = createManagedSession({ id: managed.id }, h.workspace as never, { messagesLoaded: true })
    let resumed = 0
    cold.runtime.ensureMessagesLoaded = async () => { sessionRuntimeStateForTest(cold.runtime).sessions.set(managed.id, replacement) }
    cold.runtime.enqueueAutomaticTurnRecovery = async () => { resumed++; return true }

    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(resumed).toBe(0)
    expect(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)).toBe(replacement)
  })

  it('re-fetches the exact managed instance in the scheduled cold inbox callback', async () => {
    const h = harness(); const managed = h.make('replaced-before-scheduled-dequeue')
    managed.pendingTurnRecovery = undefined
    managed.messages.push({ id: 'queued-human', role: 'user', content: 'Continue.', timestamp: 2, isQueued: true })
    await h.save(managed)
    const cold = h.cold(); const restored = sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id)
    const dequeues: string[] = []
    cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }

    await cold.runtime.ensureMessagesLoaded(requiredTestValue(restored))
    const replacement = createManagedSession({ id: managed.id }, h.workspace as never, { messagesLoaded: true })
    sessionRuntimeStateForTest(cold.runtime).sessions.set(managed.id, replacement)
    await tick(); await tick()

    expect(dequeues).toEqual([])
  })

  it('retains the cold auth downgrade capability in a closed session without dequeuing it', async () => {
    const h = harness(); const managed = h.make('closed-auth-human-continuation')
    managed.sessionStatus = 'done'
    managed.pendingTurnRecovery = undefined
    managed.pendingAuthRequestId = 'stale-auth'
    managed.messages.push({
      id: 'auth-message', role: 'auth-request', content: 'Credentials required', timestamp: 2,
      authRequestId: 'stale-auth', authRequestType: 'credential', authSourceSlug: 'source',
      authSourceName: 'Source', authStatus: 'pending', authCredentialMode: 'bearer',
    }, {
      id: 'queued-human', role: 'user', content: 'Continue after reopening.', timestamp: 3, isQueued: true,
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const dequeues: string[] = []
    cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
    await cold.runtime.ensureMessagesLoaded(restored)
    await tick(); await tick()

    expect(dequeues).toEqual([])
    expect(sessionRuntimeStateForTest(cold.runtime).coldAuthHumanContinuationSessions.has(restored)).toBe(true)
    expect(restored.pendingAuthRequest).toMatchObject({ requestId: 'stale-auth', type: 'credential' })
  })

  it('auto-resumes a queued human turn for an active non-terminal session after cold start', async () => {
    const h = harness(); const managed = h.make('active-human-continuation')
    managed.sessionStatus = 'in-progress'
    managed.pendingTurnRecovery = undefined
    managed.messages.push({
      id: 'queued-human', role: 'user', content: 'Continue the current objective.',
      timestamp: 2, isQueued: true,
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const dequeues: string[] = []
    cold.runtime.processNextQueuedMessage = (sessionId: string) => { dequeues.push(sessionId) }
    await cold.runtime.ensureMessagesLoaded(restored)
    await tick(); await tick()

    expect(dequeues).toEqual([managed.id])
    expect(restored.messageQueue.map((item: { messageId?: string }) => item.messageId)).toEqual(['queued-human'])
  })

  it('places a new human message behind an existing cold inbox before the scheduled dispatch runs', async () => {
    const h = harness(); const managed = h.make('fifo-new')
    managed.pendingTurnRecovery = undefined
    managed.messages.push({ id: 'older', role: 'user', content: 'Older instruction', timestamp: 2, isQueued: true })
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    // Freeze only the scheduled dispatch to inspect the actual sendMessage admission.
    cold.runtime.processNextQueuedMessage = () => {}
    let preparations = 0
    cold.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('No model call expected') }
    let accepted = ''
    await cold.manager.sendMessage(managed.id, 'Newer instruction', undefined, undefined, undefined, undefined, false, id => { accepted = id })
    expect(preparations).toBe(0)
    expect(restored.messageQueue.map((item) => item.messageId)).toEqual(['older', accepted])
    expect(listSessions(h.rootPath)[0]?.pendingQueuedMessageIds).toEqual(['older', accepted])
  })

  it('Stop cancels both a cold idle inbox and a dispatch already scheduled before the stop', async () => {
    const h = harness()
    for (const id of ['cold-stop', 'scheduled-stop']) {
      const managed = h.make(id); managed.pendingTurnRecovery = undefined
      managed.messages.push({ id: `${id}-queued`, role: 'user', content: 'Do this later', timestamp: 2, isQueued: true })
      await h.save(managed)
    }
    const cold = h.cold(); const calls: string[] = []
    cold.runtime.sendMessage = async (id: string) => { calls.push(id) }
    const scheduled = sessionRuntimeStateForTest(cold.runtime).sessions.get('scheduled-stop')
    await cold.runtime.ensureMessagesLoaded(requiredTestValue(scheduled))
    cold.runtime.processNextQueuedMessage('scheduled-stop')
    await Promise.all([cold.manager.cancelProcessing('cold-stop'), cold.manager.cancelProcessing('scheduled-stop')])
    await tick(); await tick()
    expect(calls).toEqual([])
    for (const id of ['cold-stop', 'scheduled-stop']) {
      const managed = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(id))
      expect(managed.messageQueue).toHaveLength(0)
      expect(managed.messages.some((message) => message.isQueued)).toBe(false)
      expect(listSessions(h.rootPath).find(meta => meta.id === id)?.pendingQueuedMessageIds).toEqual([])
    }
  })
});
