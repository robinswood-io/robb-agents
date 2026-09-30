import { describe, expect, it, jest } from 'bun:test'
import type { ExternalActionPolicy } from '@craft-agent/shared/workspaces'
import { SessionManager, createManagedSession } from './SessionManager.ts'

function injectSession(
  manager: SessionManager,
  id: string,
  workspaceId: string,
  processing: { value: boolean },
) {
  const managed = createManagedSession({ id }, {
    id: workspaceId,
    name: workspaceId,
    rootPath: `/tmp/${workspaceId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  const setExternalActionPolicy = jest.fn((_policy: ExternalActionPolicy) => undefined)
  managed.agent = {
    isProcessing: () => processing.value,
    setExternalActionPolicy,
  } as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return { managed, setExternalActionPolicy }
}

describe('workspace external-action policy runtime refresh', () => {
  it('updates idle agents in the selected workspace immediately', async () => {
    const manager = new SessionManager()
    const idle = injectSession(manager, 'idle', 'workspace-a', { value: false })
    const other = injectSession(manager, 'other', 'workspace-b', { value: false })

    await manager.refreshWorkspaceExternalActionPolicy('workspace-a', 'allow-in-execute')

    expect(idle.setExternalActionPolicy).toHaveBeenCalledWith('allow-in-execute')
    expect(other.setExternalActionPolicy).not.toHaveBeenCalled()
    expect(idle.managed.pendingExternalActionPolicy).toBeUndefined()
  })

  it('does not interrupt an active stream and applies the latest value once idle', async () => {
    const manager = new SessionManager()
    const processing = { value: true }
    const busy = injectSession(manager, 'busy', 'workspace-a', processing)

    await manager.refreshWorkspaceExternalActionPolicy('workspace-a', 'allow-in-execute')
    await manager.refreshWorkspaceExternalActionPolicy('workspace-a', 'confirm')

    expect(busy.setExternalActionPolicy).not.toHaveBeenCalled()
    expect(busy.managed.pendingExternalActionPolicy).toBe('confirm')

    processing.value = false
    const applied = (manager as unknown as {
      applyExternalActionPolicyToRuntime: (
        managed: typeof busy.managed,
        policy: ExternalActionPolicy,
        reason: string,
      ) => boolean
    }).applyExternalActionPolicyToRuntime(
      busy.managed,
      busy.managed.pendingExternalActionPolicy!,
      'test next turn',
    )

    expect(applied).toBe(true)
    expect(busy.setExternalActionPolicy).toHaveBeenCalledTimes(1)
    expect(busy.setExternalActionPolicy).toHaveBeenCalledWith('confirm')
    expect(busy.managed.pendingExternalActionPolicy).toBeUndefined()
  })
})
