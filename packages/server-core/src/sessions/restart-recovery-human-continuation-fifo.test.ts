import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionManagerForTest, type SessionSendArguments } from "./testing/private-runtime-access.ts";
import { permissionMetadataFixture } from "./testing/permission-metadata.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as config from "@craft-agent/shared/config";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { SessionManager } from "./SessionManager";
import { createAutonomyFallbackIntent } from "./autonomy-browser-fallback";
import { cleanupRestartRecovery, deferred, enableAutomaticToolFallback, harness, managers, spies, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('keeps the last Retry-funded allocation resumable during real cold metadata hydration', async () => {
    const h = harness(); const managed = h.make('cold-allocated-explicit-retry-continuation')
    const now = Date.now()
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 4,
      exhaustedAt: now - 10_000,
      lastCause: 'app_restart',
      continuationWork: ['Verify the installed candidate'],
      continuationOrigin: 'objective_continue',
      explicitRetryAllowances: [{
        schemaVersion: 1,
        id: 'explicit-retry-grant',
        objectiveId: managed.activeObjective!.objectiveId!,
        userMessageId: managed.pendingTurnRecovery!.userMessageId,
        authorizedAt: now - 5_000,
        attemptBaseline: 2,
        maxAttempts: 2,
        leaseExpiresAt: now + 60_000,
        attempts: 2,
        lastProgressFingerprint: 'validation-state',
        semanticProgressFingerprint: 'semantic-state',
        stagnantAttempts: 0,
      }],
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'last-allocated-retry-pass',
        attempt: 5,
        cause: 'app_restart',
        origin: 'restart',
        allocatedAt: now - 1_000,
        phase: 'allocated',
      },
    }
    await h.save(managed)
    spies.push(spyOn(config, 'getWorkspaces').mockReturnValue([h.workspace] as never))
    const restarted = withSessionOperationsForTest(new SessionManager()); managers.push(restarted)
    const runtime = sessionManagerForTest(restarted)
    runtime.sendEvent = (event) => h.events.push(event)
    const scheduled = deferred(); let starts = 0
    runtime.processNextQueuedMessage = (id: string) => {
      if (id === managed.id) { starts++; scheduled.resolve() }
    }

    runtime.loadSessionsFromDisk()
    const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(managed.id))
    // Cold metadata reconciliation is synchronous. It must not archive a
    // committed allocation merely because the Retry grant spent its last pass.
    expect(requiredTestValue(restored.activeObjective).terminalState).toBe('active')
    expect(requiredTestValue(restored.activeObjective).interruptedTurnRecovery).toBeUndefined()
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 4,
      exhaustedAt: managed.pendingTurnRecovery.exhaustedAt,
      continuationWork: ['Verify the installed candidate'],
      explicitRetryAllowances: [{ id: 'explicit-retry-grant', attempts: 2, maxAttempts: 2 }],
      recoveryDispatch: {
        id: 'last-allocated-retry-pass',
        attempt: 5,
        cause: 'app_restart',
        origin: 'restart',
        phase: 'allocated',
      },
    })

    await scheduled.promise
    expect(starts).toBe(1)
    expect(restored.messageQueue).toHaveLength(1)
    expect(restored.messageQueue[0]?.options?.automaticRecovery).toMatchObject({
      dispatchId: 'last-allocated-retry-pass',
      dispatchAttempt: 5,
      dispatchOrigin: 'restart',
    })
    expect(requiredTestValue(restored.pendingTurnRecovery).attempts).toBe(4)
  })

  it.each(['tool_checkpoint', 'objective_incomplete', 'evidence_gate', 'premature_final', 'app_restart'])(
    'lets a durable human FIFO replace %s recovery without a nudge or another automatic attempt', async cause => {
      const h = harness(); const managed = h.make(`human-first-${cause}`)
      managed.isProcessing = true
      managed.messages.push(...['first', 'second'].map((id, index) => ({ id, role: 'user' as const,
        content: 'Continue l’objectif en cours avec la même cible.', timestamp: index + 2, isQueued: true })))
      managed.messageQueue.push(...managed.messages.slice(1).map(message => ({ message: message.content, messageId: message.id })))
      managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 2,
        validationGaps: ['previous diagnostic'], lastCause: 'tool_checkpoint' }
      const before = structuredClone(managed.pendingTurnRecovery)
      const objective = structuredClone(managed.activeObjective)
      const messages = structuredClone(managed.messages)
      const gaps = cause === 'objective_incomplete' || cause === 'evidence_gate' ? ['current diagnostic'] : undefined
      await h.save(managed)
      h.events.length = 0
      expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, cause, gaps)).toBe(true)
      expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, cause, gaps)).toBe(true)
      expect(managed.messageQueue.map(item => item.messageId)).toEqual(['first', 'second'])
      expect(managed.pendingTurnRecovery).toEqual({ ...before, validationGaps: gaps ?? before.validationGaps })
      expect(managed.activeObjective).toEqual(objective)
      expect(managed.messages).toEqual(messages)
      expect(h.events.every(event => event.type === 'objective_changed')).toBe(true)
      const stored = JSON.parse(readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8').split('\n')[0]!)
      expect(stored.pendingTurnRecovery).toEqual(managed.pendingTurnRecovery)
      expect(stored.pendingQueuedMessageIds).toEqual(['first', 'second'])
    },
  )

  it.each(['during-allocation-flush', 'after-allocation-flush'] as const)(
    'revokes an allocated fallback for a later accepted human turn %s', async arrival => {
      const h = harness(); const managed = h.make(`fallback-human-priority-${arrival}`)
      enableAutomaticToolFallback(h)
      managed.isProcessing = true
      managed.processingGeneration = 1
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
        leaseExpiresAt: Date.now() + 60_000,
      }
      const originalFlush = h.manager.flushSession.bind(h.manager)
      const entered = deferred(); const releaseAllocation = deferred()
      if (arrival === 'during-allocation-flush') {
        let held = false
        h.manager.flushSession = async id => {
          if (!held) { held = true; entered.resolve(); await releaseAllocation.promise }
          await originalFlush(id)
        }
      }
      const intent = createAutonomyFallbackIntent('browser_fallback', 'mcp__crm__lookup')
      const allocation = h.runtime.enqueueAutomaticTurnRecovery(
        managed, 'runtime_error', undefined, undefined, undefined, intent,
      ) as Promise<boolean>
      if (arrival === 'during-allocation-flush') await entered.promise
      else expect(await allocation).toBe(true)

      const human = {
        id: `human-${arrival}`, role: 'user' as const, timestamp: 3, isQueued: true,
        content: 'Nouvel objectif : explique le résultat sans reprendre l’ancien fallback.',
      }
      managed.messages.push(human)
      managed.messageQueue.push({ message: human.content, messageId: human.id })
      h.runtime.persistSession(managed)
      if (arrival === 'during-allocation-flush') {
        releaseAllocation.resolve()
        expect(await allocation).toBe(true)
      }
      await originalFlush(managed.id)

      const allocatedDispatchId = managed.pendingTurnRecovery!.recoveryDispatch!.id
      expect(managed.messageQueue[0]?.options?.automaticRecovery?.dispatchId).toBe(allocatedDispatchId)
      expect(managed.messageQueue[1]?.messageId).toBe(human.id)
      const preparing = deferred(); const releaseAgent = deferred()
      let preparations = 0; let dispatch: Promise<void> | undefined; let dispatchedArgs: SessionSendArguments | undefined
      h.runtime.getOrCreateAgent = async () => {
        preparations++; preparing.resolve(); await releaseAgent.promise
        throw new Error('Synthetic human provider boundary')
      }
      const send = h.manager.sendMessage.bind(h.manager)
      h.manager.sendMessage = (...args) => {
        dispatchedArgs = args
        dispatch = send(...args)
        return dispatch
      }

      try {
        await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)
        await preparing.promise
        expect(preparations).toBe(1)
        expect(requiredTestValue<SessionSendArguments>(dispatchedArgs)[5]).toBe(human.id)
        expect(requiredTestValue<SessionSendArguments>(dispatchedArgs)[4]?.automaticRecovery).toBeUndefined()
        expect(managed.messageQueue.some(item => item.options?.automaticRecovery)).toBe(false)
        expect(managed.activeObjective?.userMessageId).toBe(human.id)
        expect(managed.pendingTurnRecovery).toMatchObject({ userMessageId: human.id, attempts: 0 })
        expect(managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
        const header = JSON.parse(readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8').split('\n')[0]!)
        expect(header.pendingTurnRecovery).toMatchObject({ userMessageId: human.id, attempts: 0 })
        expect(header.pendingTurnRecovery.recoveryDispatch).toBeUndefined()
      } finally {
        releaseAgent.resolve()
        await dispatch?.catch(() => {})
      }
    },
  )

  it('removes only the obsolete fallback while preserving an earlier agent delivery FIFO', async () => {
    const h = harness(); const managed = h.make('fallback-human-agent-fifo')
    enableAutomaticToolFallback(h)
    managed.isProcessing = true
    managed.processingGeneration = 1
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, attempts: 0, stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
    }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(
      managed,
      'runtime_error',
      undefined,
      undefined,
      undefined,
      createAutonomyFallbackIntent('browser_fallback', 'mcp__crm__lookup'),
    )).toBe(true)
    const deliveryOrigin = {
      kind: 'spawned-session' as const,
      senderSessionId: managed.parentSessionId ?? managed.id,
    }
    managed.messages.push({
      id: 'preserved-agent-delivery', role: 'user', timestamp: 3, isQueued: true,
      content: 'preserved-agent-delivery', internalOrigin: deliveryOrigin,
    })
    const delivery = {
      messageId: 'preserved-agent-delivery', message: 'preserved-agent-delivery',
      options: { internalOrigin: deliveryOrigin },
    }
    managed.messageQueue.push(delivery)
    managed.messages.push({
      id: 'later-human', role: 'user', timestamp: 4, isQueued: true,
      content: 'Nouvel objectif humain.',
    })
    managed.messageQueue.push({ messageId: 'later-human', message: 'Nouvel objectif humain.' })
    const starts: string[] = []
    h.runtime.sendMessage = async (...args) => { starts.push(requiredTestValue(args[5])) }

    await h.runtime.onProcessingStopped(managed.id, 'interrupted', 1)
    await tick()

    expect(starts).toEqual(['preserved-agent-delivery'])
    expect(managed.messageQueue).toEqual([{ messageId: 'later-human', message: 'Nouvel objectif humain.' }])
    expect(managed.messages.find(message => message.id === delivery.messageId)?.isQueued).toBe(true)
    expect(managed.pendingTurnRecovery).toMatchObject({ attempts: 1 })
    expect(managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
  })

  it.each(['continuation', 'explicit-new-objective', 'validation-exhausted', 'missing-recovery'])(
    'dispatches the oldest accepted human through the real stopped-turn/send path after a checkpoint (%s)', async mode => {
    const h = harness(); const managed = h.make('checkpoint-human-dispatch')
    managed.isProcessing = true
    managed.messages.push({ id: 'preserved-proof', role: 'tool', content: 'Already observed', timestamp: 2,
      toolName: 'Read', toolInput: { path: '/tmp/existing-result' }, toolResult: 'Already observed', toolStatus: 'completed', toolExecuted: true })
    const queued = { id: 'oldest-human', role: 'user' as const, timestamp: 3, isQueued: true,
      content: mode === 'explicit-new-objective' ? 'Nouvel objectif : explique la formation de la pluie.'
        : 'Continue l’objectif en cours avec la même cible.' }
    managed.messages.push(queued)
    managed.messageQueue.push({ message: queued.content, messageId: queued.id })
    if (mode === 'validation-exhausted') managed.pendingTurnRecovery = { ...managed.pendingTurnRecovery!,
      validationExhausted: true, exhaustedAt: 5, validationGaps: ['Preserved failure'], lastCause: 'objective_incomplete' }
    if (mode === 'missing-recovery') managed.pendingTurnRecovery = undefined
    const beforeObjective = structuredClone(managed.activeObjective)
    const beforeRecovery = structuredClone(managed.pendingTurnRecovery)
    const beforeIds = managed.messages.map(message => message.id)
    const preparing = deferred(); const releaseAgent = deferred()
    let preparations = 0, dispatch: Promise<void> | undefined
    h.runtime.getOrCreateAgent = async () => { preparations++; preparing.resolve(); await releaseAgent.promise; throw new Error('Synthetic provider boundary') }
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'tool_checkpoint')).toBe(true)
    await h.runtime.onProcessingStopped(managed.id, 'interrupted')
    await preparing.promise
    expect(preparations).toBe(1)
    expect(managed.lastSentMessage).toBe(queued.content)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.map(message => message.id)).toEqual(beforeIds)
    expect(managed.messages.find(message => message.id === queued.id)?.isQueued).toBe(false)
    if (mode === 'explicit-new-objective') {
      expect(managed.activeObjective?.userMessageId).toBe(queued.id)
      expect(managed.pendingTurnRecovery).toMatchObject({ userMessageId: queued.id, attempts: 0 })
      expect(managed.pendingTurnRecovery?.validationExhausted).toBeUndefined()
    } else {
      expect(managed.pendingTurnRecovery).toMatchObject({ ...beforeRecovery, userMessageId: queued.id })
      if (mode === 'missing-recovery') expect(managed.pendingTurnRecovery?.attempts).toBe(0)
      expect(managed.activeObjective).toMatchObject({ userMessageId: beforeObjective!.userMessageId, terminalState: 'active',
        budgetBaselineUsd: beforeObjective!.budgetBaselineUsd, tokenBaseline: beforeObjective!.tokenBaseline })
    }
    expect(sessionRuntimeStateForTest(h.runtime).queuedMessageDispatches.has(managed.id)).toBe(false)
    releaseAgent.resolve(); await dispatch; await h.manager.cleanup()
  })

  it.each(['tool_checkpoint', 'objective_incomplete', 'evidence_gate', 'premature_final', 'app_restart'])(
    'admits a durable human continuation without requiring an automatic recovery marker (%s)', async cause => {
      const h = harness(); const managed = h.make(`human-without-marker-${cause}`)
      managed.pendingTurnRecovery = undefined
      managed.isProcessing = true
      managed.messages.push({ id: 'queued-human', role: 'user', content: 'Continue the same objective.', timestamp: 2, isQueued: true })
      managed.messageQueue.push({ message: 'Continue the same objective.', messageId: 'queued-human' })
      const before = structuredClone({ objective: managed.activeObjective, messages: managed.messages, queue: managed.messageQueue })
      expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, cause, ['Preserved evidence must still be checked'])).toBe(true)
      expect(managed.pendingTurnRecovery).toBeUndefined()
      expect({ objective: managed.activeObjective, messages: managed.messages, queue: managed.messageQueue }).toEqual(before)
      expect(h.events).toEqual([])
      for (const block of ['question', 'permission', 'auth', 'stop', 'shutdown']) {
        if (block === 'question') managed.userInputRequests = [{ status: 'pending', sessionId: managed.id, createdAt: 1 }] as never
        if (block === 'permission') sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.set('approval', permissionMetadataFixture(managed.id))
        if (block === 'auth') managed.pendingAuthRequestId = 'auth'
        if (block === 'stop') managed.stopRequested = true
        if (block === 'shutdown') sessionRuntimeStateForTest(h.runtime).shuttingDown = true
        expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, cause)).toBe(false)
        expect(managed.pendingTurnRecovery).toBeUndefined()
        expect(managed.messageQueue).toEqual(before.queue)
        managed.userInputRequests = undefined; sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.clear()
        managed.pendingAuthRequestId = undefined; managed.stopRequested = false; sessionRuntimeStateForTest(h.runtime).shuttingDown = false
      }
      managed.messages.at(-1)!.hidden = true
      expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, cause)).toBe(false)
      expect(managed.pendingTurnRecovery).toBeUndefined()
    },
  )

  it('does not treat hidden, unaccepted, mismatched or agent-delivery entries as a human continuation', async () => {
    for (const variant of ['hidden', 'internal', 'delivery', 'unaccepted', 'pending', 'missing-id', 'missing-message', 'text-mismatch', 'hidden-options', 'recovery-options']) {
      const h = harness(); const managed = h.make(`not-human-${variant}`)
      Object.assign(managed.pendingTurnRecovery!, { attempts: 0, stagnantAttempts: 0 })
      const message = { id: 'candidate', role: 'user' as const, timestamp: 2, content: 'Untrusted continuation', isQueued: true,
        ...(variant === 'hidden' ? { hidden: true } : {}), ...(variant === 'pending' ? { isPending: true } : {}),
        ...(variant === 'internal' ? { internalOrigin: { kind: 'agent-message' as const, senderSessionId: 'child' } } : {}),
        ...(variant === 'delivery' ? { agentDelivery: { id: 'delivery', status: 'queued' as const, attempts: 0 } } : {}),
      }
      if (variant === 'unaccepted') message.isQueued = false
      if (variant !== 'missing-message') managed.messages.push(message)
      managed.messageQueue.push({ message: variant === 'text-mismatch' ? 'Different request' : message.content,
        messageId: variant === 'missing-id' ? undefined : message.id,
        options: variant === 'hidden-options' ? { hidden: true } : variant === 'recovery-options'
          ? { automaticRecovery: { originalUserMessageId: 'another-root', cause: 'app_restart' } } : undefined })
      const attempts = managed.pendingTurnRecovery!.attempts
      expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'tool_checkpoint')).toBe(true)
      expect(managed.pendingTurnRecovery!.attempts).toBe(attempts + 1)
      expect(managed.messageQueue).toHaveLength(2)
      expect(managed.messageQueue[0]!.options?.automaticRecovery?.cause).toBe('tool_checkpoint')
    }
  })

  it('keeps an earlier agent delivery in FIFO and never bypasses decisions or Stop to consume the human queue', async () => {
    const h = harness(); const managed = h.make('mixed-inbox')
    managed.messages.push({ id: 'report', role: 'user', content: 'Saved child result', hidden: true, isQueued: true, timestamp: 2,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child', deliveryId: 'delivery' } },
    { id: 'human', role: 'user', content: 'Continue the same objective.', isQueued: true, timestamp: 3 })
    managed.messageQueue.push({ message: 'Saved child result', messageId: 'report', options: { hidden: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child', deliveryId: 'delivery' } } },
    { message: 'Continue the same objective.', messageId: 'human' })
    const before = structuredClone(managed.pendingTurnRecovery)
    expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'objective_incomplete')).toBe(true)
    expect(managed.messageQueue.map(item => item.messageId)).toEqual(['report', 'human'])
    expect(managed.pendingTurnRecovery).toEqual(before)
    let starts = 0
    h.manager.sendMessage = async () => { starts++ }
    for (const decision of ['question', 'permission', 'auth', 'stop']) {
      if (decision === 'question') managed.userInputRequests = [{ status: 'pending', sessionId: managed.id, createdAt: 1 }] as never
      if (decision === 'permission') sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.set('approval', permissionMetadataFixture(managed.id))
      if (decision === 'auth') managed.pendingAuthRequestId = 'auth'
      if (decision === 'stop') managed.stopRequested = true
      expect(await h.runtime.enqueueAutomaticTurnRecovery(managed, 'tool_checkpoint')).toBe(false)
      h.runtime.processNextQueuedMessage(managed.id); await tick()
      expect(starts).toBe(0)
      expect(managed.pendingTurnRecovery).toEqual(before)
      managed.userInputRequests = undefined; sessionRuntimeStateForTest(h.runtime).pendingPermissionRequests.clear(); managed.pendingAuthRequestId = undefined; managed.stopRequested = false
    }
    await h.manager.cancelProcessing(managed.id)
    h.runtime.processNextQueuedMessage(managed.id); await tick()
    expect(starts).toBe(0)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.some(message => message.isQueued)).toBe(false)
  })
});
