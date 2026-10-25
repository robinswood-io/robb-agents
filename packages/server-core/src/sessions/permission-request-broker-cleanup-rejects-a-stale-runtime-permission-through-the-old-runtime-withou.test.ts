import { objectiveReviewBinding } from "./objective-contract.ts";
import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { describe, expect, it, jest } from "bun:test";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { deferred, installActivePermissionWait, tick } from "./testing/permission-request-broker-cleanup-fixture.ts";

describe('privileged permission lifecycle cleanup', () => {
  it('rejects a stale runtime permission through the old runtime without touching the new wait', () => {
    const h = installActivePermissionWait()
    clearTimeout(h.metadata.timeout)
    sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.clear()
    const oldAgent = h.managed.agent
    const newRespondToPermission = jest.fn()
    h.managed.agent = { respondToPermission: newRespondToPermission, forceAbort: jest.fn() } as never
    h.managed.processingGeneration = 5
    h.managed.isProcessing = true
    h.managed.activeObjective = { ...h.managed.activeObjective!, terminalState: 'active' }
    h.managed.pendingTurnRecovery = {
      ...h.managed.pendingTurnRecovery!,
      waitingForPermission: {
        requestId: 'request-new',
        requestedAt: 5,
        toolName: 'current_mutation',
        toolUseId: 'current-call',
      },
    }
    const newTimeout = setTimeout(() => undefined, 60_000)
    newTimeout.unref?.()
    sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set('request-new', {
      sessionId: h.managed.id,
      type: 'mcp_mutation',
      toolName: 'current_mutation',
      toolUseId: 'current-call',
      processingGeneration: 5,
      objectiveId: 'user-a',
      runtimeAgent: h.managed.agent ?? undefined,
      requestedAt: 5,
      expiresAt: 60_005,
      request: {
        requestId: 'request-new',
        sessionId: h.managed.id,
        toolName: 'current_mutation',
        description: 'Current request',
        type: 'mcp_mutation',
      },
      timeout: newTimeout,
    })
    const eventsBefore = h.events.length

    expect(h.internals.rejectPermissionRequestOutsideActiveGeneration(h.managed, {
      requestId: 'request-old-runtime',
      toolUseId: 'old-call',
    }, oldAgent)).toBe(true)

    expect(h.respondToPermission).toHaveBeenCalledWith('request-old-runtime', false, false)
    expect(newRespondToPermission).not.toHaveBeenCalled()
    expect([...sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.keys()]).toEqual(['request-new'])
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-new',
      toolUseId: 'current-call',
    })
    expect(h.events).toHaveLength(eventsBefore)
  })

  it('does not tombstone a current call when a stale runtime reuses its tool id', async () => {
    const h = installActivePermissionWait()
    clearTimeout(h.metadata.timeout)
    sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.clear()
    const oldAgent = h.managed.agent
    const oldRespondToPermission = h.respondToPermission
    ;sessionRuntimeStateForTest(h.manager).runtimeProcessingGenerations.set(requiredTestValue(oldAgent), 4)
    const currentRespondToPermission = jest.fn()
    h.managed.agent = Object.assign(new ScriptedSessionAgent(h.managed.workspace), {
      respondToPermission: currentRespondToPermission,
      forceAbort: jest.fn(),
      getModel: () => 'fixture-model',
    })
    h.managed.processingGeneration = 5
    h.managed.messages.push({
      id: 'tool-current-shared',
      role: 'tool',
      content: 'Running current mutation...',
      timestamp: 5,
      toolName: 'current_mutation',
      toolUseId: 'call-shared',
      toolStatus: 'executing',
    })
    sessionRuntimeStateForTest(h.internals).checkpointToolStarts.set(h.managed, {
      generation: 5,
      calls: new Map([['call-shared', {
        objectiveId: 'user-a',
        objective: requiredTestValue(h.managed.activeObjective),
        acceptanceRevision: requiredTestValue(h.managed.activeObjective).acceptanceRevision ?? 'fixture-revision',
        acceptanceSha256: objectiveReviewBinding(requiredTestValue(h.managed.activeObjective)).acceptanceSha256,
        authorityEpoch: 0,
        toolName: 'current_mutation',
      }]]),
    })

    expect(h.internals.rejectPermissionRequestOutsideActiveGeneration(h.managed, {
      requestId: 'request-old-shared',
      toolUseId: 'call-shared',
    }, oldAgent)).toBe(true)
    expect(oldRespondToPermission).toHaveBeenCalledWith('request-old-shared', false, false)
    expect(currentRespondToPermission).not.toHaveBeenCalled()
    const currentTool = h.managed.messages.find(message => message.id === 'tool-current-shared')
    expect(currentTool?.toolStatus).toBe('executing')
    expect(currentTool?.toolResult).toBeUndefined()

    await h.internals.processEvent(h.managed, {
      type: 'tool_result',
      toolUseId: 'call-shared',
      toolName: 'current_mutation',
      result: '{"updated":true}',
      isError: false,
      executed: true,
    }, 5)
    expect(h.managed.messages.find(message => message.id === 'tool-current-shared')).toMatchObject({
      toolStatus: 'completed',
      toolExecuted: true,
      toolResult: '{"updated":true}',
    })
  })

  it('rejects a permission whose tool start belongs to the objective before a same-generation steer', () => {
    const h = installActivePermissionWait()
    clearTimeout(h.metadata.timeout)
    sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.clear()
    h.resolveApproval.mockClear()
    h.respondToPermission.mockClear()
    h.managed.messages.push({
      id: 'tool-old-objective',
      role: 'tool',
      content: 'Running old objective mutation...',
      timestamp: 4,
      toolName: 'old_objective_mutation',
      toolUseId: 'call-old-objective',
      toolStatus: 'executing',
    })
    sessionRuntimeStateForTest(h.internals).checkpointToolStarts.set(h.managed, {
      generation: 4,
      calls: new Map([['call-old-objective', {
        objectiveId: 'user-a',
        objective: requiredTestValue(h.managed.activeObjective),
        acceptanceRevision: requiredTestValue(h.managed.activeObjective).acceptanceRevision ?? 'fixture-revision',
        acceptanceSha256: objectiveReviewBinding(requiredTestValue(h.managed.activeObjective)).acceptanceSha256,
        authorityEpoch: 0,
        toolName: 'old_objective_mutation',
      }]]),
    })
    h.managed.activeObjective = {
      ...h.managed.activeObjective!,
      objectiveId: 'user-b',
      userMessageId: 'user-b',
      lastUserMessageId: 'user-b',
      terminalState: 'active',
    }
    h.managed.pendingTurnRecovery = {
      ...createPendingTurnRecovery('user-b', 5),
      waitingForPermission: {
        requestId: 'request-b',
        requestedAt: 5,
        toolName: 'current_mutation',
        toolUseId: 'current-call-b',
      },
    }
    const currentTimeout = setTimeout(() => undefined, 60_000)
    currentTimeout.unref?.()
    sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set('request-b', {
      sessionId: h.managed.id,
      type: 'mcp_mutation',
      toolName: 'current_mutation',
      toolUseId: 'current-call-b',
      processingGeneration: 4,
      objectiveId: 'user-b',
      runtimeAgent: h.managed.agent ?? undefined,
      requestedAt: 5,
      expiresAt: 60_005,
      request: {
        requestId: 'request-b',
        sessionId: h.managed.id,
        toolName: 'current_mutation',
        description: 'Current objective permission',
        type: 'mcp_mutation',
      },
      timeout: currentTimeout,
    })

    expect(h.internals.rejectPermissionRequestOutsideActiveGeneration(h.managed, {
      requestId: 'request-old-objective',
      toolUseId: 'call-old-objective',
    }, h.managed.agent)).toBe(true)
    expect(h.manager.respondToPermission(
      h.managed.id,
      'request-old-objective',
      true,
      false,
    )).toBe(false)

    expect(h.respondToPermission.mock.calls).toEqual([
      ['request-old-objective', false, false],
    ])
    expect(h.resolveApproval).not.toHaveBeenCalled()
    expect([...sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.keys()]).toEqual(['request-b'])
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-b',
      toolUseId: 'current-call-b',
    })
    expect(h.managed.activeObjective?.userMessageId).toBe('user-b')
    expect(h.managed.messages.find(message => message.toolUseId === 'call-old-objective')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
    })
    expect(h.events.some(event => event.type === 'permission_request'
      && (event.request as { requestId?: string } | undefined)?.requestId === 'request-old-objective')).toBe(false)
  })

  it('lets an on-time UI response win atomically over the later TTL callback', () => {
    const h = installActivePermissionWait()

    expect(h.manager.respondToPermission('session-a', 'request-a', true, false)).toBe(true)
    h.internals.expirePendingPermissionRequest('request-a')

    expect(h.respondToPermission).toHaveBeenCalledTimes(1)
    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', true, false)
    expect(h.managed.activeObjective?.terminalState).toBe('active')
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')?.toolStatus).toBe('executing')
  })

  it('rejects an expired UI response even when its delayed TTL callback has not run', () => {
    const h = installActivePermissionWait()
    h.metadata.expiresAt = Date.now()

    expect(h.manager.respondToPermission('session-a', 'request-a', true, false)).toBe(false)

    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', false, false)
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
    })
  })

  it('persists an explicit denial before a late Pi result and keeps the provider final', async () => {
    const h = installActivePermissionWait()

    expect(h.manager.respondToPermission('session-a', 'request-a', false, false)).toBe(true)
    await tick()
    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', false, false)
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })
    const deniedReceipt = h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')?.toolResult
    expect(h.events.filter(event => event.type === 'tool_result'
      && event.toolUseId === 'gmail-call-a')).toHaveLength(1)

    // Pi reports a denied pre-tool hook as an ordinary failed execution. That
    // late envelope must not replace the stronger host-observed non-execution
    // receipt, even if the provider stream then produces its useful final.
    await h.internals.processEvent(h.managed, {
      type: 'tool_result',
      toolUseId: 'gmail-call-a',
      toolName: 'gmail_send',
      result: 'Permission denied by user.',
      isError: true,
      executed: true,
    }, 4)
    await h.internals.processEvent(h.managed, {
      type: 'text_complete',
      text: 'The email was not sent because authorization was denied.',
      isIntermediate: false,
    }, 4)

    const deniedTool = h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')
    expect(deniedTool?.toolStatus).toBe('error')
    expect(deniedTool?.toolExecuted).toBe(false)
    expect(deniedTool?.isError).toBe(true)
    expect(deniedTool?.toolResult).toBe(deniedReceipt)
    expect(h.events.filter(event => event.type === 'tool_result'
      && event.toolUseId === 'gmail-call-a')).toHaveLength(1)
    await tick()
    expect(h.flushSession).toHaveBeenCalledWith('session-a')
    expect(h.managed.messages.some(message => message.role === 'assistant'
      && message.content === 'The email was not sent because authorization was denied.')).toBe(true)
  })

  it('materializes a receipt when denial races an in-flight tool start', async () => {
    const h = installActivePermissionWait()
    h.managed.messages = h.managed.messages.filter(message => message.toolUseId !== 'gmail-call-a')

    const start = h.internals.processEvent(h.managed, {
      type: 'tool_start',
      toolUseId: 'gmail-call-a',
      toolName: 'gmail_send',
      input: { to: 'recipient@example.com' },
    }, 4)
    expect(h.manager.respondToPermission('session-a', 'request-a', false, false)).toBe(true)
    await start
    await tick()
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })

    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', false, false)
    expect(h.managed.messages.filter(message => message.toolUseId === 'gmail-call-a')).toHaveLength(1)
    expect(h.events.some(event => event.type === 'tool_start'
      && event.toolUseId === 'gmail-call-a')).toBe(false)
  })

  it('flushes stopped permission receipts before releasing the provider wait', async () => {
    const h = installActivePermissionWait()
    const flushGate = deferred()
    h.internals.flushSession = jest.fn(() => flushGate.promise)

    const close = h.internals.closePendingPermissionRequestsForStop(h.managed, 4)
    expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.size).toBe(0)
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
    })
    expect(h.respondToPermission).not.toHaveBeenCalled()
    expect(h.internals.flushSession).toHaveBeenCalledWith('session-a')

    flushGate.resolve()
    await close
    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', false, false)
  })

  it('still persists and releases an explicit denial when renderer delivery fails', async () => {
    const h = installActivePermissionWait()
    const captureEvent = h.internals.sendEvent
    h.internals.sendEvent = event => {
      if (event.type === 'tool_result') throw new Error('renderer gone')
      captureEvent(event)
    }

    expect(h.manager.respondToPermission('session-a', 'request-a', false, false)).toBe(true)
    await tick()

    expect(h.flushSession).toHaveBeenCalledWith('session-a')
    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', false, false)
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
    })
  })

  it('re-enqueues a denied receipt when its first durability flush fails', async () => {
    const h = installActivePermissionWait()
    h.enqueuePersist.mockClear()
    const flushSession = jest.fn()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue(undefined)
    h.internals.flushSession = flushSession

    h.internals.denyPermissionRequestDuringShutdown(h.managed, {
      requestId: 'shutdown-flush-retry',
      toolName: 'gmail_send',
      toolUseId: 'gmail-call-a',
    }, h.managed.agent)
    await tick()

    expect(flushSession).toHaveBeenCalledTimes(1)
    expect(h.enqueuePersist).toHaveBeenCalledTimes(2)
    expect(h.respondToPermission).toHaveBeenCalledWith('shutdown-flush-retry', false, false)
    await h.internals.flushSession()
    expect(flushSession).toHaveBeenCalledTimes(2)
  })

  it('records and flushes a shutdown-time permission denial before releasing the provider', async () => {
    const h = installActivePermissionWait()
    clearTimeout(h.metadata.timeout)
    sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.clear()
    h.respondToPermission.mockClear()
    const flushGate = deferred()
    h.internals.flushSession = jest.fn(() => flushGate.promise)
    ;sessionRuntimeStateForTest(h.manager).shuttingDown = true

    h.internals.denyPermissionRequestDuringShutdown(h.managed, {
      requestId: 'shutdown-late',
      toolName: 'gmail_send',
      toolUseId: 'gmail-call-a',
    }, h.managed.agent)

    // The denial capability is registered synchronously, before persistence.
    // A provider result racing the durability fence cannot overwrite it.
    await h.internals.processEvent(h.managed, {
      type: 'tool_result',
      toolUseId: 'gmail-call-a',
      toolName: 'gmail_send',
      result: '{"sent":true}',
      isError: false,
      executed: true,
    }, 4)
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })
    expect(h.respondToPermission).not.toHaveBeenCalled()
    expect(h.internals.flushSession).toHaveBeenCalledWith('session-a')

    flushGate.resolve()
    await tick()
    expect(h.respondToPermission).toHaveBeenCalledWith('shutdown-late', false, false)
    expect(h.events.filter(event => event.type === 'tool_result'
      && event.toolUseId === 'gmail-call-a')).toHaveLength(1)
  })

  it('records non-execution before orderly shutdown disposes a waiting runtime', async () => {
    const h = installActivePermissionWait()

    await h.manager.cleanup()

    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', false, false)
    expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.size).toBe(0)
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })
  })
});
