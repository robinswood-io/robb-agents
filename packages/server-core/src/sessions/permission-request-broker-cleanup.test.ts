import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { describe, expect, it } from "bun:test";
import { deferred, harness, installActivePermissionWait, tick } from "./testing/permission-request-broker-cleanup-fixture.ts";

describe('privileged permission lifecycle cleanup', () => {
  it('denies and removes the broker request when the UI permission expires', () => {
    const { manager, respondToPermission, resolveApproval } = harness()

    ;(manager as unknown as { expirePendingPermissionRequest: (id: string) => void })
      .expirePendingPermissionRequest('request-a')

    expect(resolveApproval).toHaveBeenCalledWith('request-a', false, {
      expectedCommandHash: 'hash-a',
      expectedSessionId: 'session-a',
    })
    expect(respondToPermission).toHaveBeenCalledWith('request-a', false, false)
  })

  it('denies and removes the broker request when its session is cleared', () => {
    const { manager, respondToPermission, resolveApproval } = harness()

    ;(manager as unknown as { clearPendingPermissionRequestsForSession: (id: string) => void })
      .clearPendingPermissionRequestsForSession('session-a')

    expect(resolveApproval).toHaveBeenCalledWith('request-a', false, {
      expectedCommandHash: 'hash-a',
      expectedSessionId: 'session-a',
    })
    expect(respondToPermission).toHaveBeenCalledWith('request-a', false, false)
  })

  it('stores the bounded admin approval window received from the permission response', () => {
    const h = installActivePermissionWait()

    expect(h.manager.respondToPermission('session-a', 'request-a', true, false, {
      rememberForMinutes: 10,
    })).toBe(true)

    const approvals = sessionRuntimeStateForTest(h.manager).adminRememberApprovals
    expect([...approvals.values()]).toEqual([{
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
      sourceRequestId: 'request-a',
    }])
    const approval = [...approvals.values()][0]!
    expect(approval.expiresAt - approval.createdAt).toBe(10 * 60 * 1000)
    expect(h.resolveApproval).toHaveBeenCalledWith('request-a', true, {
      expectedCommandHash: 'hash-a',
      expectedSessionId: 'session-a',
    })
  })

  it('terminalizes an expired live permission as a blocked, non-executed, explicitly retryable handoff', async () => {
    const h = installActivePermissionWait()

    h.internals.expirePendingPermissionRequest('request-a')
    await tick()

    expect(h.respondToPermission).toHaveBeenCalledTimes(1)
    expect(h.respondToPermission).toHaveBeenCalledWith('request-a', false, false)
    expect(h.managed.isProcessing).toBe(false)
    expect(h.managed.sessionStatus).toBe('blocked')
    expect(h.managed.activeObjective?.terminalState).toBe('blocked_human')
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-a',
      toolUseId: 'gmail-call-a',
      recoveryRequired: true,
    })
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-other')?.toolStatus).toBe('executing')
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolUseId: 'gmail-call-a',
      executed: false,
      isError: true,
    }))
    expect(h.cleanupCalls()).toBe(1)
    expect(await h.internals.enqueueAutomaticTurnRecovery(h.managed, 'runtime_error')).toBe(false)

    // Expiry owns the map deletion. A duplicate timer or a late UI click can
    // neither deny twice nor resurrect/approve the obsolete provider request.
    h.internals.expirePendingPermissionRequest('request-a')
    expect(h.manager.respondToPermission('session-a', 'request-a', true, false)).toBe(false)
    expect(h.respondToPermission).toHaveBeenCalledTimes(1)
    expect(h.managed.sessionStatus).toBe('blocked')
  })

  it('keeps the host non-execution receipt when the provider emits a late result for the expired call', async () => {
    const h = installActivePermissionWait()

    h.internals.expirePendingPermissionRequest('request-a')
    await h.internals.processEvent(h.managed, {
      type: 'tool_result',
      toolUseId: 'gmail-call-a',
      toolName: 'gmail_send',
      result: 'Permission denied by user.',
      isError: true,
      executed: true,
    }, 4)

    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })
    expect(h.events.filter(event => event.type === 'tool_result'
      && event.toolUseId === 'gmail-call-a')).toHaveLength(1)
  })

  it('drops a late tool start from the generation closed by permission expiry', async () => {
    const h = installActivePermissionWait()

    h.internals.expirePendingPermissionRequest('request-a')
    await h.internals.processEvent(h.managed, {
      type: 'tool_start',
      toolUseId: 'gmail-call-late',
      toolName: 'gmail_send',
      input: { to: 'recipient@example.com' },
    }, 4)

    expect(h.managed.messages.some(message => message.toolUseId === 'gmail-call-late')).toBe(false)
    expect(h.events.some(event => event.type === 'tool_start'
      && event.toolUseId === 'gmail-call-late')).toBe(false)
  })

  it('denies a late permission callback without replacing the explicit Retry handoff', async () => {
    const h = installActivePermissionWait()

    h.internals.expirePendingPermissionRequest('request-a')
    const eventsAfterExpiry = h.events.length
    expect(h.internals.rejectPermissionRequestOutsideActiveGeneration(h.managed, {
      requestId: 'request-late',
      toolUseId: 'gmail-call-late',
    }, h.managed.agent)).toBe(true)

    expect(h.respondToPermission).toHaveBeenNthCalledWith(1, 'request-a', false, false)
    expect(h.respondToPermission).toHaveBeenNthCalledWith(2, 'request-late', false, false)
    expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.has('request-late')).toBe(false)
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-a',
      toolUseId: 'gmail-call-a',
      recoveryRequired: true,
    })
    expect(h.events).toHaveLength(eventsAfterExpiry + 1)
    expect(h.events.at(-1)).toMatchObject({
      type: 'tool_result',
      toolUseId: 'gmail-call-late',
      executed: false,
      isError: true,
    })
    expect(h.manager.respondToPermission('session-a', 'request-late', true, false)).toBe(false)
    expect(h.respondToPermission).toHaveBeenCalledTimes(2)
  })

  it('keeps a pre-expiry tool start non-executed when its permission and result both arrive late', async () => {
    const h = installActivePermissionWait()
    h.managed.messages.push({
      id: 'tool-x',
      role: 'tool',
      content: 'Running late mutation...',
      timestamp: 4,
      toolName: 'late_mutation',
      toolUseId: 'late-call-x',
      toolStatus: 'executing',
    })

    h.internals.expirePendingPermissionRequest('request-a')
    expect(h.internals.rejectPermissionRequestOutsideActiveGeneration(h.managed, {
      requestId: 'request-x',
      toolUseId: 'late-call-x',
    }, h.managed.agent)).toBe(true)
    await h.internals.processEvent(h.managed, {
      type: 'tool_result',
      toolUseId: 'late-call-x',
      toolName: 'late_mutation',
      result: 'Permission denied by user.',
      isError: true,
      executed: true,
    }, 4)

    expect(h.managed.messages.find(message => message.toolUseId === 'late-call-x')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })
    expect(h.events.filter(event => event.type === 'tool_result'
      && event.toolUseId === 'late-call-x')).toHaveLength(1)
    expect(h.managed.activeObjective?.terminalState).toBe('blocked_human')
  })

  it('lets Stop abort the runtime during expiry cleanup without erasing the explicit Retry handoff', async () => {
    const h = installActivePermissionWait()
    const cleanupEntered = deferred()
    const releaseCleanup = deferred()
    h.internals.onProcessingStopped = async () => {
      cleanupEntered.resolve()
      await releaseCleanup.promise
      h.managed.isProcessing = false
      h.managed.stopRequested = false
      h.managed.sessionStatus = 'blocked'
    }

    h.internals.expirePendingPermissionRequest('request-a')
    await cleanupEntered.promise
    expect(h.managed.isProcessing).toBe(true)

    await h.manager.cancelProcessing(h.managed.id)
    expect(h.forceAbort).toHaveBeenCalledTimes(1)
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-a',
      recoveryRequired: true,
    })
    expect(h.managed.activeObjective?.terminalState).toBe('blocked_human')

    releaseCleanup.resolve()
    await tick()
    expect(h.managed.isProcessing).toBe(false)
    expect(h.managed.sessionStatus).toBe('blocked')
  })

  it('closes every pending permission in the expired generation so Retry is immediately unblocked', async () => {
    const h = installActivePermissionWait()
    const addPending = (requestId: string, toolUseId: string, expiresAt: number) => {
      h.managed.messages.push({
        id: `tool-${requestId}`,
        role: 'tool',
        content: `Running ${requestId}...`,
        timestamp: expiresAt,
        toolName: 'external_mutation',
        toolUseId,
        toolStatus: 'executing',
      })
      const timeout = setTimeout(() => undefined, expiresAt)
      timeout.unref?.()
      sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set(requestId, {
        sessionId: h.managed.id,
        type: 'admin_approval',
        commandHash: `hash-${requestId}`,
        toolName: 'external_mutation',
        toolUseId,
        processingGeneration: 4,
        objectiveId: 'user-a',
        runtimeAgent: h.managed.agent ?? undefined,
        requestedAt: 2,
        expiresAt,
        request: {
          requestId,
          sessionId: h.managed.id,
          toolName: 'external_mutation',
          description: requestId,
          type: 'admin_approval',
        },
        timeout,
      })
    }
    addPending('request-b', 'external-call-b', 3_600_000)
    addPending('request-c', 'external-call-c', 60_000)
    h.managed.pendingTurnRecovery = {
      ...h.managed.pendingTurnRecovery!,
      waitingForPermission: {
        requestId: 'request-c',
        requestedAt: 2,
        toolName: 'external_mutation',
        toolUseId: 'external-call-c',
      },
    }

    h.internals.expirePendingPermissionRequest('request-a')
    await tick()

    expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.size).toBe(0)
    expect(h.respondToPermission.mock.calls).toEqual([
      ['request-a', false, false],
      ['request-b', false, false],
      ['request-c', false, false],
    ])
    for (const toolUseId of ['gmail-call-a', 'external-call-b', 'external-call-c']) {
      expect(h.managed.messages.find(message => message.toolUseId === toolUseId)).toMatchObject({
        toolStatus: 'error',
        toolExecuted: false,
        isError: true,
      })
    }
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-a',
      recoveryRequired: true,
    })
    expect(() => h.internals.assertRetryTurnUnblocked(h.managed)).not.toThrow()

    // Cleared heterogeneous TTL callbacks are idempotent: no second broker or
    // provider resolution can fire after Retry becomes available.
    h.internals.expirePendingPermissionRequest('request-b')
    h.internals.expirePendingPermissionRequest('request-c')
    expect(h.respondToPermission).toHaveBeenCalledTimes(3)
    expect(h.resolveApproval).toHaveBeenCalledTimes(3)
  })

  it('keeps the exact late result of approved B after concurrent permission A expires', async () => {
    const h = installActivePermissionWait()
    h.managed.messages.push({
      id: 'tool-b',
      role: 'tool',
      content: 'Running calendar mutation...',
      timestamp: 4,
      toolName: 'calendar_update',
      toolUseId: 'calendar-call-b',
      toolStatus: 'executing',
    })
    h.managed.pendingTurnRecovery = {
      ...h.managed.pendingTurnRecovery!,
      waitingForPermission: {
        requestId: 'request-b',
        requestedAt: 2,
        toolName: 'calendar_update',
        toolUseId: 'calendar-call-b',
      },
    }
    const timeout = setTimeout(() => undefined, 60_000)
    timeout.unref?.()
    sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set('request-b', {
      sessionId: h.managed.id,
      type: 'mcp_mutation',
      toolName: 'calendar_update',
      toolUseId: 'calendar-call-b',
      processingGeneration: 4,
      objectiveId: 'user-a',
      runtimeAgent: h.managed.agent ?? undefined,
      requestedAt: 2,
      expiresAt: Date.now() + 60_000,
      request: {
        requestId: 'request-b',
        sessionId: h.managed.id,
        toolName: 'calendar_update',
        description: 'Update the calendar',
        type: 'mcp_mutation',
      },
      timeout,
    })

    expect(h.manager.respondToPermission(h.managed.id, 'request-b', true, false)).toBe(true)
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
    h.internals.expirePendingPermissionRequest('request-a')
    await tick()
    await h.internals.processEvent(h.managed, {
      type: 'tool_result',
      toolUseId: 'calendar-call-b',
      toolName: 'calendar_update',
      result: '{"updated":true}',
      isError: false,
      executed: true,
    }, 4)

    expect(h.respondToPermission).toHaveBeenNthCalledWith(1, 'request-b', true, false)
    expect(h.respondToPermission).toHaveBeenNthCalledWith(2, 'request-a', false, false)
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
    })
    expect(h.managed.messages.find(message => message.toolUseId === 'calendar-call-b')).toMatchObject({
      toolStatus: 'completed',
      toolExecuted: true,
      isError: false,
      toolResult: '{"updated":true}',
    })
    expect(h.managed.activeObjective?.terminalState).toBe('blocked_human')
    expect(h.managed.sessionStatus).toBe('blocked')
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-a',
      toolUseId: 'gmail-call-a',
      recoveryRequired: true,
    })
    expect(await h.internals.enqueueAutomaticTurnRecovery(h.managed, 'runtime_error')).toBe(false)
  })

  it('closes the active permission before Stop aborts and rejects a later approval click', async () => {
    const h = installActivePermissionWait()

    await h.manager.cancelProcessing(h.managed.id)
    expect(h.forceAbort).toHaveBeenCalledTimes(1)
    expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.size).toBe(0)
    expect(h.respondToPermission.mock.calls).toEqual([['request-a', false, false]])
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
    })

    expect(h.manager.respondToPermission(h.managed.id, 'request-a', true, false)).toBe(false)
    expect(h.respondToPermission.mock.calls).toEqual([['request-a', false, false]])
  })
});
