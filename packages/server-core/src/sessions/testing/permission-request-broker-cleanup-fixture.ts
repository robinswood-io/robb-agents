import { sessionManagerForTest } from "./private-runtime-access.ts";
import { withSessionOperationsForTest } from './session-operation-access.ts';
import { ScriptedSessionAgent } from "./scripted-session-agent.ts";
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { jest } from "bun:test";
import { SessionManager, createManagedSession } from "../SessionManager.ts";
import { createPendingTurnRecovery } from "../turn-recovery.ts";



export function harness() {
  const manager = withSessionOperationsForTest(new SessionManager())
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    slug: 'workspace-a',
    rootPath: '/tmp/workspace-a',
    createdAt: 1,
  }, { messagesLoaded: true })
  const respondToPermission = jest.fn()
  const forceAbort = jest.fn()
  managed.agent = Object.assign(new ScriptedSessionAgent(managed.workspace), { respondToPermission, forceAbort, getModel: () => 'fixture-model', dispose: jest.fn() })
  ;sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)

  const resolveApproval = jest.fn(() => ({ ok: true }))
  const auditEvent = jest.fn()
  ;sessionRuntimeStateForTest(manager).privilegedExecutionBroker.resolveApproval = resolveApproval
  sessionRuntimeStateForTest(manager).privilegedExecutionBroker.auditEvent = auditEvent

  const timeout = setTimeout(() => undefined, 60_000)
  timeout.unref?.()
  const requestedAt = Date.now()
  const metadata = {
    sessionId: managed.id,
    type: 'admin_approval' as const,
    commandHash: 'hash-a',
    toolName: 'Bash',
    processingGeneration: 0,
    runtimeAgent: managed.agent ?? undefined,
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
  ;sessionRuntimeStateForTest(manager).pendingPermissionRequests.set('request-a', metadata)

  return { manager, managed, respondToPermission, forceAbort, resolveApproval, metadata }
}


export function installActivePermissionWait() {
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
  const internals = sessionManagerForTest(manager)
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


export const tick = () => new Promise<void>(resolve => setImmediate(resolve))

export const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
