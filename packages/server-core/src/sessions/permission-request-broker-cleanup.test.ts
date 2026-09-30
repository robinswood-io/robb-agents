import { describe, expect, it, jest } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createPendingTurnRecovery } from './turn-recovery.ts'

function harness() {
  const manager = new SessionManager()
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: '/tmp/workspace-a',
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const respondToPermission = jest.fn()
  const forceAbort = jest.fn()
  managed.agent = { respondToPermission, forceAbort, getModel: () => 'fixture-model', dispose: jest.fn() } as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

  const resolveApproval = jest.fn(() => ({ ok: true }))
  const auditEvent = jest.fn()
  ;(manager as unknown as { privilegedExecutionBroker: unknown }).privilegedExecutionBroker = {
    resolveApproval,
    auditEvent,
  }

  const timeout = setTimeout(() => undefined, 60_000)
  timeout.unref?.()
  const requestedAt = Date.now()
  const metadata = {
    sessionId: managed.id,
    type: 'admin_approval' as const,
    commandHash: 'hash-a',
    toolName: 'Bash',
    processingGeneration: 0,
    runtimeAgent: managed.agent,
    requestedAt,
    expiresAt: requestedAt + 60_000,
    request: {
      requestId: 'request-a',
      sessionId: managed.id,
      toolName: 'Bash',
      description: 'Install',
      type: 'admin_approval' as const,
    },
    timeout,
  }
  ;(manager as unknown as { pendingPermissionRequests: Map<string, unknown> })
    .pendingPermissionRequests.set('request-a', metadata)

  return { manager, managed, respondToPermission, forceAbort, resolveApproval, metadata }
}

function installActivePermissionWait() {
  const result = harness()
  const { manager, managed, metadata } = result
  const events: Array<Record<string, unknown>> = []
  managed.messages = [
    { id: 'user-a', role: 'user', content: 'Send the approved message.', timestamp: 1 },
    { id: 'tool-a', role: 'tool', content: 'Running gmail_send...', timestamp: 2,
      toolName: 'gmail_send', toolUseId: 'gmail-call-a', toolStatus: 'executing' },
    { id: 'tool-other', role: 'tool', content: 'Running another tool...', timestamp: 3,
      toolName: 'gmail_send', toolUseId: 'gmail-call-other', toolStatus: 'executing' },
  ]
  managed.activeObjective = {
    schemaVersion: 1,
    objectiveId: 'user-a',
    userMessageId: 'user-a',
    lastUserMessageId: 'user-a',
    startedAt: 1,
    budgetBaselineUsd: 0,
    tokenBaseline: 0,
    continuationCount: 0,
    orchestrationMode: 'mission',
    risk: 'high-stakes',
    requiresExecutionEvidence: true,
    completionCriteria: ['requested-outcome-delivered'],
    terminalState: 'active',
  }
  managed.pendingTurnRecovery = {
    ...createPendingTurnRecovery('user-a', 1),
    waitingForPermission: {
      requestId: 'request-a',
      requestedAt: 1,
      toolName: 'gmail_send',
      toolUseId: 'gmail-call-a',
    },
  }
  managed.isProcessing = true
  managed.processingGeneration = 4
  managed.sessionStatus = 'in-progress'
  managed.turnLifecycleManagedStatus = 'in-progress'
  Object.assign(metadata, {
    toolName: 'gmail_send',
    toolUseId: 'gmail-call-a',
    processingGeneration: 4,
    objectiveId: 'user-a',
  })
  const internals = manager as unknown as {
    enqueuePersist: () => void
    flushSession: () => Promise<void>
    sendEvent: (event: Record<string, unknown>) => void
    emitExecutionTelemetry: () => void
    finishAutomaticSessionStatusLifecycle: (session: typeof managed) => Promise<void>
    reconcileRecoveredTerminalStatus: () => Promise<boolean>
    onProcessingStopped: (sessionId: string, reason: string, generation: number) => Promise<void>
    enqueueAutomaticTurnRecovery: (session: typeof managed, cause: 'runtime_error') => Promise<boolean>
    processEvent: (session: typeof managed, event: Record<string, unknown>, generation?: number) => Promise<void>
    rejectPermissionRequestOutsideActiveGeneration: (
      session: typeof managed,
      request: { requestId: string; toolUseId?: string },
      runtimeAgent: typeof managed.agent,
    ) => boolean
    denyPermissionRequestDuringShutdown: (
      session: typeof managed,
      request: { requestId: string; toolName?: string; toolUseId?: string },
      runtimeAgent: typeof managed.agent,
    ) => void
    assertRetryTurnUnblocked: (session: typeof managed, allowPermissionInbox?: boolean) => void
    checkpointToolStarts: WeakMap<typeof managed, {
      generation: number
      calls: Map<string, { objectiveId: string; toolName: string }>
    }>
    pendingPermissionRequests: Map<string, unknown>
    expirePendingPermissionRequest: (id: string) => void
    closePendingPermissionRequestsForStop: (
      session: typeof managed,
      generation: number,
    ) => Promise<void>
  }
  const enqueuePersist = jest.fn()
  internals.enqueuePersist = enqueuePersist
  const flushSession = jest.fn(async () => {})
  internals.flushSession = flushSession
  internals.sendEvent = event => events.push(event)
  internals.emitExecutionTelemetry = () => {}
  internals.finishAutomaticSessionStatusLifecycle = async session => {
    session.turnLifecycleManagedStatus = undefined
    session.sessionStatus = 'blocked'
    events.push({ type: 'session_status_changed', sessionId: session.id, sessionStatus: 'blocked' })
  }
  internals.reconcileRecoveredTerminalStatus = async () => false
  let cleanupCalls = 0
  internals.onProcessingStopped = async (_sessionId, _reason, _generation) => {
    cleanupCalls++
    managed.isProcessing = false
    managed.sessionStatus = 'blocked'
    managed.turnLifecycleManagedStatus = undefined
  }
  return { ...result, events, internals, flushSession, enqueuePersist, cleanupCalls: () => cleanupCalls }
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

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

    const approvals = (h.manager as unknown as {
      adminRememberApprovals: Map<string, {
        createdAt: number
        expiresAt: number
        sourceRequestId: string
      }>
    }).adminRememberApprovals
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
    expect(h.internals.pendingPermissionRequests.has('request-late')).toBe(false)
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
      h.internals.pendingPermissionRequests.set(requestId, {
        sessionId: h.managed.id,
        type: 'admin_approval',
        commandHash: `hash-${requestId}`,
        toolName: 'external_mutation',
        toolUseId,
        processingGeneration: 4,
        objectiveId: 'user-a',
        runtimeAgent: h.managed.agent,
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

    expect(h.internals.pendingPermissionRequests.size).toBe(0)
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
    h.internals.pendingPermissionRequests.set('request-b', {
      sessionId: h.managed.id,
      type: 'mcp_mutation',
      toolName: 'calendar_update',
      toolUseId: 'calendar-call-b',
      processingGeneration: 4,
      objectiveId: 'user-a',
      runtimeAgent: h.managed.agent,
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
    expect(h.internals.pendingPermissionRequests.size).toBe(0)
    expect(h.respondToPermission.mock.calls).toEqual([['request-a', false, false]])
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
    })

    expect(h.manager.respondToPermission(h.managed.id, 'request-a', true, false)).toBe(false)
    expect(h.respondToPermission.mock.calls).toEqual([['request-a', false, false]])
  })

  it('rejects a stale runtime permission through the old runtime without touching the new wait', () => {
    const h = installActivePermissionWait()
    clearTimeout(h.metadata.timeout)
    h.internals.pendingPermissionRequests.clear()
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
    h.internals.pendingPermissionRequests.set('request-new', {
      sessionId: h.managed.id,
      type: 'mcp_mutation',
      toolName: 'current_mutation',
      toolUseId: 'current-call',
      processingGeneration: 5,
      objectiveId: 'user-a',
      runtimeAgent: h.managed.agent,
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
    expect([...h.internals.pendingPermissionRequests.keys()]).toEqual(['request-new'])
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'request-new',
      toolUseId: 'current-call',
    })
    expect(h.events).toHaveLength(eventsBefore)
  })

  it('does not tombstone a current call when a stale runtime reuses its tool id', async () => {
    const h = installActivePermissionWait()
    clearTimeout(h.metadata.timeout)
    h.internals.pendingPermissionRequests.clear()
    const oldAgent = h.managed.agent
    const oldRespondToPermission = h.respondToPermission
    ;(h.manager as unknown as { runtimeProcessingGenerations: WeakMap<object, number> })
      .runtimeProcessingGenerations.set(oldAgent as object, 4)
    const currentRespondToPermission = jest.fn()
    h.managed.agent = {
      respondToPermission: currentRespondToPermission,
      forceAbort: jest.fn(),
      getModel: () => 'fixture-model',
    } as never
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
    h.internals.checkpointToolStarts.set(h.managed, {
      generation: 5,
      calls: new Map([['call-shared', {
        objectiveId: 'user-a',
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
    h.internals.pendingPermissionRequests.clear()
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
    h.internals.checkpointToolStarts.set(h.managed, {
      generation: 4,
      calls: new Map([['call-old-objective', {
        objectiveId: 'user-a',
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
    h.internals.pendingPermissionRequests.set('request-b', {
      sessionId: h.managed.id,
      type: 'mcp_mutation',
      toolName: 'current_mutation',
      toolUseId: 'current-call-b',
      processingGeneration: 4,
      objectiveId: 'user-b',
      runtimeAgent: h.managed.agent,
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
    expect([...h.internals.pendingPermissionRequests.keys()]).toEqual(['request-b'])
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
    expect(h.internals.pendingPermissionRequests.size).toBe(0)
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
    h.internals.pendingPermissionRequests.clear()
    h.respondToPermission.mockClear()
    const flushGate = deferred()
    h.internals.flushSession = jest.fn(() => flushGate.promise)
    ;(h.manager as unknown as { shuttingDown: boolean }).shuttingDown = true

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
    expect(h.internals.pendingPermissionRequests.size).toBe(0)
    expect(h.managed.messages.find(message => message.toolUseId === 'gmail-call-a')).toMatchObject({
      toolStatus: 'error',
      toolExecuted: false,
      isError: true,
      toolResult: expect.stringContaining('not executed'),
    })
  })
})
