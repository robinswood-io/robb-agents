import { type SessionSendArguments } from "./testing/private-runtime-access.ts";
import { permissionMetadataFixture } from "./testing/permission-metadata.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanupRestartRecovery, type Managed, deferred, harness, queueMachine, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('bounded automatic admission', () => {
  it('does not treat a spawned-session inbox index as human authority after hydration', async () => {
    const h = harness(); let parent = h.make('chain-root')
    for (let depth = 1; depth <= 5; depth++) parent = h.make(`chain-${depth}`, parent.id)
    queueMachine(parent, 'delegation'); await h.save(parent)
    for (const session of sessionRuntimeStateForTest(h.runtime).sessions.values()) if (session !== parent) await h.save(session)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(parent.id))
    expect(restored.pendingQueuedMessageIds).toEqual(['delegation'])
    expect(restored.pendingAgentDeliveryIds ?? []).toEqual([])
    let starts = 0; cold.runtime.sendMessage = async () => { starts++ }
    await cold.runtime.resumePendingTurnAfterRestart(parent.id)
    await tick(); await tick()
    expect(starts).toBe(0)
    expect(restored.messageQueue.map((item) => item.messageId)).toEqual(['delegation'])
  })

  it('admits only the accepted human behind a held machine delivery, preserving that delivery and attachments', async () => {
    const h = harness(); const parent = h.make('mixed-parent'); const child = h.make('mixed-child', parent.id)
    parent.activeObjective!.terminalState = 'exhausted'
    const first = queueMachine(child)
    child.activeObjective!.terminalState = 'exhausted'
    child.messages.push({ id: 'human', role: 'user', content: 'New objective: explain the result.', timestamp: 3, isQueued: true })
    child.messageQueue.push({ messageId: 'human', message: 'New objective: explain the result.' })
    h.runtime.grantLiveDirectHumanContinuation(child, 'human')
    const starts: string[] = []; h.runtime.sendMessage = async (...args) => { starts.push(requiredTestValue(args[5])) }
    h.runtime.processNextQueuedMessage(child.id); await tick()
    expect(starts).toEqual(['human'])
    expect(child.messageQueue).toEqual([first])
    expect(child.messages.find(message => message.id === 'machine')?.isQueued).toBe(true)
  })

  it('admits the actual new human on an exhausted target and retains its older machine inbox', async () => {
    const h = harness(); const parent = h.make('active-parent'); const target = h.make('exhausted-target', parent.id)
    target.activeObjective!.terminalState = 'exhausted'
    const machine = queueMachine(target)
    target.messages.push({ id: 'new-human-objective', role: 'user', content: 'New objective: explain this result.', timestamp: 3, isQueued: true })
    target.messageQueue.push({ messageId: 'new-human-objective', message: 'New objective: explain this result.' })
    h.runtime.grantLiveDirectHumanContinuation(target, 'new-human-objective')
    const dispatches: string[] = []; h.runtime.sendMessage = async (...args) => { dispatches.push(requiredTestValue(args[5])) }
    h.runtime.processNextQueuedMessage(target.id); await tick()
    expect(dispatches).toEqual(['new-human-objective'])
    expect(target.messageQueue[0]).toBe(machine)
    expect(target.pendingTurnRecovery?.attempts).toBe(2)
  })

  it('retries the original anchor explicitly while leaving a terminal target machine inbox intact', async () => {
    const h = harness(); const target = h.make('terminal-machine-retry'); target.activeObjective!.terminalState = 'exhausted'
    Object.assign(target.pendingTurnRecovery!, { exhaustedAt: 10, validationExhausted: true, attempts: 5 })
    const item = queueMachine(target, 'retained-machine'); const recovery = structuredClone(target.pendingTurnRecovery!)
    const entered = deferred(), release = deferred(); let dispatch: Promise<void> | undefined; let received: SessionSendArguments | undefined
    h.runtime.getOrCreateAgent = async () => { entered.resolve(); await release.promise; throw new Error('Fixture provider boundary') }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { received = args; dispatch = send(...args); return dispatch }
    expect(await h.manager.retryTurn(target.id, `${target.id}-user`)).toEqual({ status: 'started' })
    await entered.promise
    expect(requiredTestValue<SessionSendArguments>(received)[5]).toBe(`${target.id}-user`)
    expect(requiredTestValue<SessionSendArguments>(received)[4]?.automaticRecovery?.cause).toBe('user_retry')
    expect(requiredTestValue<SessionSendArguments>(received)[1]).not.toBe(item.message)
    expect(target.messageQueue[0]).toBe(item)
    expect(target.messages.find(message => message.id === item.messageId)?.isQueued).toBe(true)
    expect(target.activeObjective).toMatchObject({ terminalState: 'active' })
    expect(target.pendingTurnRecovery).toMatchObject({ attempts: recovery.attempts, validationExhausted: true, lastCause: 'user_retry' })
    release.resolve(); await dispatch; await h.manager.cleanup()
  })

  it.each([1, 2])('a completed Stop cancels a terminal inbox Retry during hydration %s', async hydrationIndex => {
    const h = harness(); const target = h.make(`terminal-retry-stop-${hydrationIndex}`)
    target.activeObjective!.terminalState = 'exhausted'; queueMachine(target, 'cancelled-machine')
    const entered = deferred(), release = deferred(); let hydrations = 0, preparations = 0
    h.runtime.ensureMessagesLoaded = async () => { if (++hydrations === hydrationIndex) { entered.resolve(); await release.promise } }
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare after Stop') }
    const retry = h.manager.retryTurn(target.id, `${target.id}-user`).then(() => undefined, (error: unknown) => error)
    await entered.promise; await h.manager.cancelProcessing(target.id)
    release.resolve(); const error = await retry
    expect(error).toBeInstanceOf(Error)
    expect(preparations).toBe(0); expect(target.messageQueue).toEqual([])
    expect(target.pendingTurnRecovery).toBeUndefined()
    expect(target.messages.find(message => message.id === 'cancelled-machine')?.isQueued).toBe(false)
  })

  it.each(['human', 'question', 'permission', 'auth', 'spoofed-origin'])('revalidates a terminal inbox Retry when %s arrives during dispatch hydration', async change => {
    const h = harness(); const target = h.make(`terminal-retry-race-${change}`)
    target.activeObjective!.terminalState = 'exhausted'; const item = queueMachine(target)
    const entered = deferred(), release = deferred(); let hydrations = 0, preparations = 0
    h.runtime.ensureMessagesLoaded = async () => { if (++hydrations === 2) { entered.resolve(); await release.promise } }
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare') }
    const retry = h.manager.retryTurn(target.id, `${target.id}-user`).then(() => undefined, (error: unknown) => error)
    await entered.promise
    if (change === 'human') {
      target.messages.push({ id: 'new-human', role: 'user', content: 'Change the objective.', timestamp: 3, isQueued: true })
      target.messageQueue.push({ messageId: 'new-human', message: 'Change the objective.' })
    }
    if (change === 'question') target.userInputRequests = [{ status: 'pending', sessionId: target.id }] as never
    if (change === 'permission') sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.set('new-permission', permissionMetadataFixture(target.id))
    if (change === 'auth') target.pendingAuthRequestId = 'new-auth'
    if (change === 'spoofed-origin') item.options = { internalOrigin: { ...item.options.internalOrigin, senderSessionId: 'different-sender' } }
    release.resolve(); const error = await retry
    expect(error).toBeInstanceOf(Error); expect(preparations).toBe(0)
    expect(target.messageQueue[0]).toBe(item); expect(target.activeObjective?.terminalState).toBe('exhausted')
    expect(target.pendingTurnRecovery?.attempts).toBe(2)
    sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.clear()
  })

  it('refuses a terminal inbox Retry if a human joins the FIFO before its durable acknowledgement', async () => {
    const h = harness(); const target = h.make('terminal-retry-before-ack')
    target.activeObjective!.terminalState = 'exhausted'; const item = queueMachine(target)
    const beforeRecovery = structuredClone(target.pendingTurnRecovery)
    const entered = deferred(), release = deferred(); let flushes = 0, preparations = 0
    h.runtime.beginAutomaticSessionStatusLifecycle = async () => {}
    const flush = h.manager.flushSession.bind(h.manager)
    h.manager.flushSession = async id => { if (++flushes === 1) { entered.resolve(); await release.promise } await flush(id) }
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare') }
    const retry = h.manager.retryTurn(target.id, `${target.id}-user`).then(() => undefined, (error: unknown) => error)
    await entered.promise
    target.messages.push({ id: 'new-human', role: 'user', content: 'Change the objective.', timestamp: 3, isQueued: true })
    target.messageQueue.push({ messageId: 'new-human', message: 'Change the objective.' })
    release.resolve(); const error = await retry
    expect(error).toBeInstanceOf(Error); expect(preparations).toBe(0)
    expect(target.messageQueue).toHaveLength(2); expect(target.messageQueue[0]).toBe(item)
    expect(target.activeObjective?.terminalState).toBe('exhausted')
    expect(target.pendingTurnRecovery).toEqual(beforeRecovery)
  })

  it('restores the same FIFO item when an ancestor decision arrives after reservation', async () => {
    const h = harness(); const parent = h.make('race-parent'); const child = h.make('race-child', parent.id)
    const item = queueMachine(child)
    let starts = 0; h.runtime.sendMessage = async () => { starts++ }
    h.runtime.processNextQueuedMessage(child.id)
    parent.pendingAuthRequestId = 'new-auth'
    await tick()
    expect(starts).toBe(0); expect(child.messageQueue[0]).toBe(item)
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.size).toBe(0)
    expect(sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.size).toBe(0)
    parent.pendingAuthRequestId = undefined
    h.runtime.scheduleDeferredAutomaticSessions(); h.runtime.scheduleDeferredAutomaticSessions()
    await tick(); await tick(); await tick()
    expect(starts).toBe(1)
  })

  it('keeps a wake arriving during another recovery hydration and releases direct-call reservations', async () => {
    const h = harness(); const parent = h.make('wake-parent'); const child = h.make('wake-child', parent.id); const other = h.make('wake-other')
    parent.pendingAuthRequestId = 'auth'
    const entered = deferred(), release = deferred(); const starts: string[] = []
    h.runtime.ensureMessagesLoaded = async (managed: Managed) => { if (managed === other) { entered.resolve(); await release.promise } }
    h.runtime.enqueueAutomaticTurnRecovery = async (managed: Managed) => { starts.push(managed.id); managed.isProcessing = true; return true }
    const draining = h.runtime.resumePendingTurnsAfterRestart([child.id, other.id])
    await entered.promise; parent.pendingAuthRequestId = undefined
    h.runtime.scheduleDeferredAutomaticSessions(); await tick()
    release.resolve(); await draining; await tick(); await tick()
    expect(starts.filter(id => id === child.id)).toHaveLength(1)
    const terminal = h.make('direct-exhausted'); terminal.activeObjective!.terminalState = 'exhausted'
    Object.assign(terminal.pendingTurnRecovery!, { exhaustedAt: 3, validationExhausted: true })
    await h.runtime.resumePendingTurnAfterRestart(terminal.id)
    expect(sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.has(terminal.id)).toBe(false)
  })
});
