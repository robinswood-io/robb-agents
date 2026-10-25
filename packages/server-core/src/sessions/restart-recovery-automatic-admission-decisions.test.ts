import { ScriptedSessionAgent, completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { permissionMetadataFixture } from "./testing/permission-metadata.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { cleanupRestartRecovery, deferred, harness, queueMachine, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('bounded automatic admission', () => {
  it('surfaces an exhausted invalid final after restart as a durable typed validation failure', async () => {
    process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT = '1'
    const h = harness(); const managed = h.make('restart-invalid-final-exhausted')
    managed.activeObjective!.requiresExecutionEvidence = true
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 7,
      validationGaps: ['stale diagnostic'],
    }
    managed.messages.push({
      id: 'unverified-final', role: 'assistant', timestamp: 2,
      content: 'The requested implementation is complete.',
    })
    await h.save(managed)
    h.events.length = 0

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    const diagnostic = 'missing structured objective outcome receipt'
    expect(requiredTestValue(restored.activeObjective).terminalState).toBe('exhausted')
    expect(restored.pendingTurnRecovery).toMatchObject({
      exhaustedAt: expect.any(Number), validationExhausted: true,
      lastCause: 'objective_incomplete', validationGaps: expect.arrayContaining([diagnostic]),
    })
    expect(restored.messages.at(-1)).toMatchObject({
      role: 'error', errorCode: 'objective_validation_failed',
      errorTitle: 'Completion could not be verified', errorCanRetry: true,
      errorDetails: expect.arrayContaining([diagnostic]),
    })
    expect(h.events.findLast(event => event.type === 'typed_error')).toMatchObject({
      sessionId: managed.id,
      error: {
        code: 'objective_validation_failed', canRetry: true,
        details: expect.arrayContaining([diagnostic]),
      },
    })
    expect(h.events.some(event => event.type === 'error')).toBe(false)

    const persisted = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(persisted.at(-1)).toMatchObject({
      type: 'error', errorCode: 'objective_validation_failed',
      errorDetails: expect.arrayContaining([diagnostic]), errorCanRetry: true,
    })
  })

  it('keeps non-validation restart exhaustion on the generic error surface', async () => {
    const h = harness(); const managed = h.make('restart-generic-exhausted')
    managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 7 }
    await h.save(managed)
    h.events.length = 0

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(restored.messages.at(-1)).toMatchObject({ role: 'error' })
    expect(restored.messages.at(-1)?.errorCode).toBeUndefined()
    expect(h.events.some(event => event.type === 'typed_error')).toBe(false)
    expect(h.events.findLast(event => event.type === 'error')).toMatchObject({ sessionId: managed.id })
  })

  it('reserves pending spawns synchronously and rejects depth, decisions and the fifth family runtime', async () => {
    const h = harness(); const root = h.make('spawn-root'); root.isProcessing = true
    const tokens = Array.from({ length: 3 }, () => h.runtime.reserveSpawnAdmission(root))
    expect(() => h.runtime.reserveSpawnAdmission(root)).toThrow('root_capacity')
    tokens.forEach(token => sessionRuntimeStateForTest(h.runtime).pendingSpawnRoots.delete(token))
    root.pendingAuthRequestId = 'auth'; expect(() => h.runtime.reserveSpawnAdmission(root)).toThrow('decision')
    root.pendingAuthRequestId = undefined
    let parent = root; for (let depth = 1; depth <= 4; depth++) parent = h.make(`spawn-depth-${depth}`, parent.id)
    expect(() => h.runtime.reserveSpawnAdmission(parent)).toThrow('depth')
    expect(sessionRuntimeStateForTest(h.runtime).pendingSpawnRoots.size).toBe(0)
  })

  it('retains a rejected final behind a new ancestor decision without declaring exhaustion, then wakes once', async () => {
    process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT = '1'
    const h = harness(); const parent = h.make('final-parent'); const child = h.make('final-child', parent.id)
    child.activeObjective!.requiresExecutionEvidence = true
    Object.assign(child.pendingTurnRecovery!, { attempts: 0, stagnantAttempts: 0 })
    const before = structuredClone(child.pendingTurnRecovery!)
    let chats = 0
    const agent = completeSessionAgentFixture(h.workspace, { getModel: () => 'fixture-model', getSessionId: () => null, setAllSources: () => {}, isProcessing: () => false,
      dispose: () => {},
      async *chat(): ReturnType<ScriptedSessionAgent['chat']> {
        chats++; parent.pendingAuthRequestId = 'opened-during-child-turn'
        yield { type: 'text_complete', text: 'The implementation is complete.', isIntermediate: false }
        yield { type: 'complete' }
      } })
    h.runtime.getOrCreateAgent = async () => { child.agent = agent as never; return agent }
    await h.manager.sendMessage(child.id, 'Check the preserved result.', undefined, undefined,
      { hidden: true, automaticRecovery: { originalUserMessageId: child.pendingTurnRecovery!.userMessageId, cause: 'app_restart' } })
    expect(chats).toBe(1)
    expect(child.activeObjective?.terminalState).toBe('active')
    expect(child.pendingTurnRecovery).toMatchObject({ attempts: before.attempts, stagnantAttempts: before.stagnantAttempts, continuationRequired: true })
    expect(child.pendingTurnRecovery?.validationGaps?.length).toBeGreaterThan(0)
    expect(child.pendingTurnRecovery?.exhaustedAt).toBeUndefined()
    expect(h.events.some(event => event.type === 'typed_error' && event.error?.code === 'objective_validation_failed')).toBe(false)
    expect(sessionRuntimeStateForTest(h.runtime).deferredAutomaticSessions.has(child.id)).toBe(true)
    expect(child.messageQueue).toHaveLength(0)
    const entered = deferred(), release = deferred(); let preparations = 0; let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => { preparations++; entered.resolve(); await release.promise; throw new Error('Fixture preparation boundary') }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    parent.pendingAuthRequestId = undefined
    h.runtime.scheduleDeferredAutomaticSessions(); h.runtime.scheduleDeferredAutomaticSessions()
    await entered.promise
    expect(preparations).toBe(1)
    expect(child.pendingTurnRecovery?.attempts).toBe(before.attempts + 1)
    release.resolve(); await dispatch; await h.manager.cleanup()
  })

  it('rechecks an ancestor after SDK preparation and retains the exact delivery without spending an attempt', async () => {
    const h = harness(); const parent = h.make('prepare-parent'); const child = h.make('prepare-child', parent.id)
    const item = queueMachine(child)
    const saved = child.messages.find(message => message.id === item.messageId)!
    saved.agentDelivery = { id: 'delivery-id', status: 'queued', attempts: 0 }
    const entered = deferred(), release = deferred(); let chats = 0; let dispatch: Promise<void> | undefined
    const agent = completeSessionAgentFixture(h.workspace, { getModel: () => 'fixture', async *chat(): ReturnType<ScriptedSessionAgent['chat']> { chats++; yield { type: 'complete' } }, setAllSources: () => {} })
    h.runtime.getOrCreateAgent = async () => { entered.resolve(); await release.promise; child.agent = agent as never; return agent }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    h.runtime.processNextQueuedMessage(child.id); await entered.promise
    parent.pendingAuthRequestId = 'new-auth'; release.resolve(); await dispatch
    expect(chats).toBe(0); expect(child.isProcessing).toBe(false)
    expect(saved.agentDelivery).toMatchObject({ attempts: 0, status: 'queued' })
    expect(child.messageQueue[0]).toMatchObject(item)
    expect(saved.isQueued).toBe(true)
    expect(sessionRuntimeStateForTest(h.runtime).automaticAdmissionReservations.size).toBe(0)
    expect(h.events.some(event => event.type === 'error' || event.type === 'typed_error')).toBe(false)
  })

  it('admits an explicit permission-inbox Retry at full automatic capacity without granting a permission', async () => {
    const h = harness(); const managed = h.make('permission-capacity')
    for (let index = 0; index < 8; index++) h.make(`occupied-${index}`).isProcessing = true
    managed.pendingTurnRecovery!.waitingForPermission = { requestId: 'old', requestedAt: 1, toolName: 'Bash', recoveryRequired: true }
    queueMachine(managed, 'permission-inbox-delivery')
    const entered = deferred(), release = deferred(); let preparations = 0; let dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => { preparations++; entered.resolve(); await release.promise; throw new Error('Fixture provider boundary') }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    expect(await h.manager.retryTurn(managed.id, `${managed.id}-user`)).toEqual({ status: 'started' })
    await entered.promise
    expect(preparations).toBe(1); expect(managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
    expect(sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.size).toBe(0)
    expect(sessionRuntimeStateForTest(h.runtime).permissionInboxRetryDispatches.size).toBe(0)
    release.resolve(); await dispatch; await h.manager.cleanup()
  })

  it('does not lend a concurrent Retry authority to an unrelated automatic dispatch token', async () => {
    const h = harness(); const parent = h.make('token-parent'); const child = h.make('token-child', parent.id)
    const item = queueMachine(child); child.messageQueue.shift()
    const token = Symbol('automatic-dispatch'); sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.set(child.id, token)
    sessionRuntimeStateForTest(h.runtime).retryTurnsInFlight.set(child.id, Promise.resolve({ status: 'started' }))
    parent.pendingAuthRequestId = 'new-parent-auth'
    let starts = 0; h.runtime.getOrCreateAgent = async () => { starts++; throw new Error('Must not prepare') }
    await h.manager.sendMessage(child.id, item.message, undefined, item.storedAttachments, item.options, item.messageId,
      false, undefined, undefined, token, item)
    expect(starts).toBe(0); expect(child.messageQueue[0]).toBe(item)
    expect(child.pendingTurnRecovery?.attempts).toBe(2)
    sessionRuntimeStateForTest(h.runtime).retryTurnsInFlight.delete(child.id)
  })

  it('never rolls back a completed Stop when a permission-inbox Retry was awaiting hydration', async () => {
    const h = harness(); const managed = h.make('permission-retry-stop')
    managed.pendingTurnRecovery!.waitingForPermission = { requestId: 'old', requestedAt: 1, toolName: 'Bash', recoveryRequired: true }
    queueMachine(managed, 'cancelled-delivery')
    const entered = deferred(), release = deferred(); let hydrations = 0, preparations = 0
    h.runtime.ensureMessagesLoaded = async () => { if (++hydrations === 2) { entered.resolve(); await release.promise } }
    h.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Must not prepare after Stop') }
    const retry = h.manager.retryTurn(managed.id, `${managed.id}-user`).then(() => undefined, error => error)
    await entered.promise
    await h.manager.cancelProcessing(managed.id)
    const stoppedGeneration = managed.processingGeneration
    expect(managed.messageQueue).toEqual([]); expect(managed.pendingTurnRecovery).toBeUndefined()
    release.resolve(); await retry
    expect(preparations).toBe(0)
    expect(managed.processingGeneration).toBe(stoppedGeneration)
    expect(managed.messageQueue).toEqual([])
    expect(managed.pendingTurnRecovery).toBeUndefined()
    expect(managed.messages.find(message => message.id === 'cancelled-delivery')?.isQueued).toBe(false)
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.size).toBe(0)
    expect(sessionRuntimeStateForTest(h.runtime).permissionInboxRetryDispatches.size).toBe(0)
  })

  it.each(['permission', 'auth'] as const)('wakes held descendants after a real %s resolution while the parent stays active', async kind => {
    const h = harness(); const parent = h.make(`resolve-${kind}-parent`); const child = h.make(`resolve-${kind}-child`, parent.id)
    parent.isProcessing = true; queueMachine(child)
    const sent: string[] = []; h.runtime.sendMessage = async (id: string) => { sent.push(id) }
    const responses: boolean[] = []
    if (kind === 'permission') {
      const requestedAt = Date.now()
      parent.pendingTurnRecovery!.waitingForPermission = { requestId: 'decision', requestedAt, toolName: 'Bash' }
      parent.agent = { respondToPermission: (_id: string, allowed: boolean) => responses.push(allowed) } as never
      sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.set('decision', {
        sessionId: parent.id,
        requestedAt,
        expiresAt: requestedAt + 60_000,
        toolName: 'Bash',
        processingGeneration: parent.processingGeneration,
        objectiveId: parent.activeObjective?.objectiveId ?? parent.activeObjective?.userMessageId,
        runtimeAgent: parent.agent ?? undefined,
        request: { requestId: 'decision', sessionId: parent.id, toolName: 'Bash', description: 'Offline decision' },
        timeout: permissionMetadataFixture(parent.id).timeout,
      })
    } else {
      parent.pendingAuthRequestId = 'decision'
      parent.pendingAuthRequest = {
        type: 'oauth', requestId: 'decision', sessionId: parent.id,
        sourceSlug: 'fixture', sourceName: 'Fixture',
      }
      parent.messages.push({ id: 'auth-question', role: 'auth-request', content: 'Authenticate', timestamp: 2,
        authRequestId: 'decision', authStatus: 'pending' })
    }
    h.runtime.processNextQueuedMessage(child.id); expect(sent).toEqual([])
    if (kind === 'permission') expect(h.manager.respondToPermission(parent.id, 'decision', false, false)).toBe(true)
    else await h.manager.completeAuthRequest(parent.id, { requestId: 'decision', sourceSlug: 'fixture', success: false, cancelled: true } as never)
    for (let index = 0; index < 4; index++) await tick()
    expect(sent.filter(id => id === child.id)).toHaveLength(1)
    expect(parent.isProcessing).toBe(true)
    expect(responses).toEqual(kind === 'permission' ? [false] : [])
    expect(sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.size).toBe(0)
  })
});
