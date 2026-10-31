import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from "@craft-agent/core";
import { createPendingTurnRecovery } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, deferred, harness, queueMachine, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('bounded automatic admission', () => {
  it('admits at most eight restart runtimes, retains the rest, and wakes once capacity is released', async () => {
    const h = harness(); const sessions = Array.from({ length: 12 }, (_, i) => h.make(`bounded-${i}`))
    const admitted: string[] = []
    h.runtime.enqueueAutomaticTurnRecovery = async (managed: Managed) => { admitted.push(managed.id); managed.isProcessing = true; return true }
    await h.runtime.resumePendingTurnsAfterRestart(sessions.map(session => session.id))
    expect(admitted).toEqual(sessions.slice(0, 8).map(session => session.id))
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.size).toBe(4)
    const released = requiredTestValue(sessions[0])
    released.pendingTurnRecovery = undefined; h.runtime.setProcessing(released, false)
    h.runtime.scheduleDeferredAutomaticSessions(); h.runtime.scheduleDeferredAutomaticSessions()
    for (let i = 0; i < 4; i++) await tick()
    expect(admitted).toEqual(sessions.slice(0, 9).map(session => session.id))
    expect(sessions.filter(session => session.isProcessing)).toHaveLength(8)
  })

  it('starts a persisted child before its waiting parent without reserving all slots for ancestors', async () => {
    const h = harness(); const root = h.make('waiting-root'); const child = h.make('waiting-child', root.id)
    const admitted: string[] = []
    h.runtime.enqueueAutomaticTurnRecovery = async (managed: Managed) => { admitted.push(managed.id); managed.isProcessing = true; return true }
    await h.runtime.resumePendingTurnsAfterRestart([root.id, child.id])
    expect(admitted[0]).toBe(child.id)
    expect(admitted).toContain(root.id)
  })

  it('retains ninety children behind the root decision before hydration or budget consumption', async () => {
    const h = harness(); const root = h.make('decision-root')
    root.userInputRequests = [{ sessionId: root.id, status: 'pending', objectiveUserMessageId: root.activeObjective!.userMessageId }] as never
    const children = Array.from({ length: 90 }, (_, i) => h.make(`held-${i}`, root.id))
    let hydrated = 0, admitted = 0
    h.runtime.ensureMessagesLoaded = async () => { hydrated++ }
    h.runtime.enqueueAutomaticTurnRecovery = async () => { admitted++; return true }
    await h.runtime.resumePendingTurnsAfterRestart(children.map(session => session.id))
    expect(hydrated).toBe(0); expect(admitted).toBe(0)
    expect(sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.size).toBe(0)
    expect(children.every(session => session.pendingTurnRecovery?.attempts === 2)).toBe(true)
  })

  it('terminalizes an orphaned started recovery when its parent objective is already terminal', async () => {
    const h = harness()
    const parent = h.make('terminal-recovery-parent')
    const child = h.make('frosty-recovery-child', parent.id)
    const answerQuestions = [{ id: 'scope', question: 'Which scope?', options: [{ id: 'saved', label: 'Saved' }] }]
    const answerSelections = [{ questionId: 'scope', optionIds: ['saved'] }]
    parent.activeObjective!.terminalState = 'complete_verified'
    parent.activeObjective!.completedAt = 20
    parent.pendingTurnRecovery = undefined
    child.sessionStatus = 'in-progress'
    child.activeObjective!.lastUserMessageId = `${child.id}-latest-human`
    child.messages.push({
      id: `${child.id}-latest-human`, role: 'user', content: 'Keep the completed work and finish safely.', timestamp: 2,
    }, {
      id: `${child.id}-hidden-answer`, role: 'user',
      content: USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({
        requestId: `${child.id}-request`, questions: answerQuestions, answers: answerSelections,
      }),
      timestamp: 3,
      hidden: true, internalOrigin: { kind: 'user-input' },
    })
    child.userInputRequests = [{
      id: `${child.id}-request`, sessionId: child.id, originWorkspaceId: child.workspace.id,
      questions: answerQuestions,
      status: 'answered', createdAt: 2, answeredAt: 3,
      objectiveUserMessageId: child.activeObjective!.userMessageId,
      responseMessageId: `${child.id}-hidden-answer`, answers: answerSelections,
    }]
    child.pendingTurnRecovery = {
      ...child.pendingTurnRecovery!,
      userMessageId: `${child.id}-hidden-answer`,
      attempts: 1,
      lastCause: 'objective_incomplete',
      continuationRequired: true,
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'started-before-parent-closed',
        attempt: 1,
        cause: 'objective_incomplete',
        origin: 'automatic',
        allocatedAt: 10,
        phase: 'started',
        startedAt: 11,
      },
    }
    const recovery = structuredClone(child.pendingTurnRecovery)
    await h.save(parent)
    await h.save(child)

    const cold = h.cold()
    const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(child.id))
    let providerStarts = 0
    cold.runtime.sendMessage = async () => { providerStarts++ }

    await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(providerStarts).toBe(0)
    expect<unknown>(restored.activeObjective).toMatchObject({
      terminalState: 'blocked_policy',
      completedAt: (expect.any(Number) as unknown),
      interruptedTurnRecovery: {
        objectiveId: `${child.id}-user`,
        userMessageId: `${child.id}-latest-human`,
        recovery,
      },
    })
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(restored.id)).toBe(false)
    expect(sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.has(restored.id)).toBe(false)
    expect(restored.sessionStatus).not.toBe('in-progress')
    expect(h.events.filter(event => event.type === 'complete' && event.sessionId === restored.id)).toHaveLength(1)
    expect(h.events.some(event => event.type === 'info' && event.sessionId === restored.id
      && event.message.includes('no longer valid'))).toBe(true)
  })

  it('revokes a cold recovery from objective A instead of exposing it through objective B Retry', async () => {
    const h = harness()
    const parent = h.make('stale-recovery-parent')
    const child = h.make('stale-recovery-child', parent.id)
    parent.activeObjective!.terminalState = 'complete_verified'
    parent.pendingTurnRecovery = undefined
    child.pendingTurnRecovery = {
      ...createPendingTurnRecovery('old-objective-A'),
      attempts: 4,
      lastCause: 'objective_continue',
      continuationRequired: true,
      continuationOrigin: 'objective_continue',
      continuationWork: ['Old objective A work'],
    }
    await h.save(parent)
    await h.save(child)

    const cold = h.cold()
    const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(child.id))
    let providerStarts = 0
    cold.runtime.sendMessage = async () => { providerStarts++ }

    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(providerStarts).toBe(0)
    expect(restored.activeObjective).toMatchObject({ terminalState: 'blocked_policy' })
    expect(requiredTestValue(restored.activeObjective).interruptedTurnRecovery).toBeUndefined()
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(cold.runtime.getInterruptedTurnRecovery(restored, `${child.id}-user`)).toBeUndefined()
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(restored.id)).toBe(false)
    expect(sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.has(restored.id)).toBe(false)
    expect(h.events.some(event => event.type === 'info' && event.sessionId === restored.id
      && event.message.includes('stale recovery authority was revoked'))).toBe(true)
  })

  it('does not let a pre-terminalization cold inbox callback re-admit retained machine context', async () => {
    const h = harness()
    const parent = h.make('terminal-machine-parent')
    const child = h.make('pending-machine-child', parent.id)
    parent.activeObjective!.terminalState = 'complete_verified'
    parent.pendingTurnRecovery = undefined
    queueMachine(child, 'retained-machine-delivery')
    await h.save(parent)
    await h.save(child)

    const cold = h.cold()
    const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(child.id))
    let providerStarts = 0
    cold.runtime.sendMessage = async () => { providerStarts++ }

    await cold.runtime.resumePendingTurnAfterRestart(restored.id)
    for (let index = 0; index < 3; index += 1) await tick()

    expect(providerStarts).toBe(0)
    expect(requiredTestValue(restored.activeObjective).terminalState).toBe('blocked_policy')
    expect(restored.pendingTurnRecovery).toBeUndefined()
    expect(restored.messageQueue.map((item) => item.messageId)).toEqual(['retained-machine-delivery'])
    expect(restored.messages.find((message) => message.id === 'retained-machine-delivery')?.isQueued).toBe(true)
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(restored.id)).toBe(false)
    expect(sessionRuntimeStateForTest(cold.runtime).automaticAdmissionReservations.has(restored.id)).toBe(false)
  })

  it('reconciles a cold terminal machine inbox without consuming its retained Retry context', async () => {
    const h = harness()
    const target = h.make('cold-terminal-machine-inbox')
    target.activeObjective!.terminalState = 'complete_verified'
    target.activeObjective!.completedAt = 20
    target.pendingTurnRecovery = undefined
    target.sessionStatus = 'in-progress'
    queueMachine(target, 'retained-review-delivery')
    await h.save(target)

    const cold = h.cold()
    const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(target.id))
    let providerStarts = 0
    cold.runtime.sendMessage = async () => { providerStarts++ }
    const completed = deferred()
    cold.manager.onSessionComplete(event => {
      if (event.sessionId === restored.id) completed.resolve()
    })
    await cold.runtime.ensureMessagesLoaded(restored)
    await completed.promise

    expect(providerStarts).toBe(0)
    expect(requiredTestValue(restored.activeObjective).terminalState).toBe('complete_verified')
    expect(restored.messageQueue.map((item) => item.messageId)).toEqual(['retained-review-delivery'])
    expect(restored.messages.find((message) => message.id === 'retained-review-delivery')?.isQueued).toBe(true)
    expect(sessionRuntimeStateForTest(cold.runtime).deferredAutomaticSessions.has(restored.id)).toBe(false)
    expect(restored.sessionStatus).not.toBe('in-progress')
    expect(h.events.filter(event => event.type === 'complete' && event.sessionId === restored.id)).toHaveLength(1)

    const secondCold = h.cold()
    const secondRestored = requiredTestValue(sessionRuntimeStateForTest(secondCold.runtime).sessions.get(target.id))
    secondCold.runtime.sendMessage = async () => { providerStarts++ }
    await secondCold.runtime.ensureMessagesLoaded(secondRestored)
    for (let index = 0; index < 3; index += 1) await tick()

    expect(providerStarts).toBe(0)
    expect(secondRestored.messageQueue.map((item) => item.messageId)).toEqual(['retained-review-delivery'])
    expect(h.events.filter(event => event.type === 'complete' && event.sessionId === secondRestored.id)).toHaveLength(1)
  })

  it('keeps an exhausted target machine inbox stopped when real answers wake its question ancestors', async () => {
    const h = harness(); const root = h.make('security-root'); const target = h.make('quick-cliff-exhausted', root.id)
    const child = h.make('review-with-question', target.id)
    target.activeObjective!.terminalState = 'exhausted'
    Object.assign(target.pendingTurnRecovery!, { attempts: 5, exhaustedAt: 10, validationExhausted: true, lastCause: 'evidence_gate' })
    const item = queueMachine(target, 'old-broad-glass-delivery')
    const saved = target.messages.find(message => message.id === item.messageId)!
    saved.hidden = true; saved.agentDelivery = { id: 'original-delivery', status: 'queued', attempts: 0 }
    const before = structuredClone({ recovery: target.pendingTurnRecovery, objective: target.activeObjective, messages: target.messages })
    const question = await h.manager.requestUserInput(child.id, [{ id: 'scope', question: 'Which existing scope?', options: [{ id: 'same', label: 'Same scope' }] }])
    const dispatches: string[] = []
    // Keep the durable question API, ancestry wake and queue admission real;
    // replace only the provider-facing delivery, acknowledging the child answer.
    h.runtime.sendMessage = async (...args) => { dispatches.push(args[0]); args[7]?.(requiredTestValue(args[5])) }
    h.runtime.processNextQueuedMessage(target.id); expect(dispatches).toEqual([])
    await h.manager.respondToUserInput(child.id, { requestId: question.requestId, answers: [{ questionId: 'scope', optionIds: ['same'] }] })
    for (let index = 0; index < 4; index++) await tick()
    expect(dispatches).toEqual([child.id])
    expect(target.messageQueue[0]).toBe(item)
    expect(target.isProcessing).toBe(false)
    expect({ recovery: target.pendingTurnRecovery, objective: target.activeObjective, messages: target.messages }).toEqual(before)
    expect(sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.has(target.id)).toBe(false)
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.has(target.id)).toBe(true)
  })
});
