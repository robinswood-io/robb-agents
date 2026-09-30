import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core/types'
import { SessionManager, createManagedSession } from './SessionManager'

describe('pending auth in lightweight session snapshots', () => {
  it('includes only the current pending request while keeping the transcript unloaded in the DTO', () => {
    const managed = createManagedSession({ id: 'auth-child', parentSessionId: 'parent' }, {
      id: 'auth-workspace', name: 'Auth workspace', rootPath: '/tmp/auth-request-snapshot', createdAt: 1,
    } as never, { messagesLoaded: true })
    const pending: Message = {
      id: 'auth-message', role: 'auth-request', content: 'Connect Drive', timestamp: 2,
      authRequestId: 'oauth-current', authRequestType: 'oauth', authSourceSlug: 'drive', authSourceName: 'Drive', authStatus: 'pending',
    }
    managed.messages = [
      { ...pending, id: 'old-auth', authRequestId: 'oauth-old' },
      pending,
      { id: 'internal-tool', role: 'tool', content: 'Private internal tool output', timestamp: 3 },
    ]
    managed.pendingAuthRequestId = 'oauth-current'
    const manager = new SessionManager()
    const internals = manager as unknown as { sessions: Map<string, typeof managed> }
    internals.sessions.set(managed.id, managed)

    const reloaded = manager.getSessions(managed.workspace.id)[0]!
    expect(reloaded.parentSessionId).toBe('parent')
    expect(reloaded.messages).toEqual([])
    expect(reloaded.pendingAuthRequestMessage).toEqual(pending)

    pending.authStatus = 'completed'
    expect(manager.getSessions(managed.workspace.id)[0]?.pendingAuthRequestMessage).toBeUndefined()
    pending.authStatus = 'pending'
    managed.pendingAuthRequestId = undefined
    expect(manager.getSessions(managed.workspace.id)[0]?.pendingAuthRequestMessage).toBeUndefined()
  })
})
