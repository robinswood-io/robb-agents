import { describe, expect, it, jest } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager.ts'

function harness() {
  const manager = new SessionManager()
  const managed = createManagedSession({ id: 'session-a' }, {
    id: 'workspace-a',
    name: 'Workspace A',
    rootPath: '/tmp/workspace-a',
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const respondToPermission = jest.fn()
  managed.agent = { respondToPermission } as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(managed.id, managed)

  const resolveApproval = jest.fn(() => ({ ok: true }))
  ;(manager as unknown as { privilegedExecutionBroker: unknown }).privilegedExecutionBroker = {
    resolveApproval,
  }

  const timeout = setTimeout(() => undefined, 60_000)
  timeout.unref?.()
  const metadata = {
    sessionId: managed.id,
    type: 'admin_approval' as const,
    commandHash: 'hash-a',
    toolName: 'Bash',
    requestedAt: 1,
    expiresAt: 2,
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

  return { manager, managed, respondToPermission, resolveApproval }
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
})
