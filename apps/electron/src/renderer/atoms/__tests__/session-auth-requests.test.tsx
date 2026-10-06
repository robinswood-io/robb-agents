import { describe, expect, it } from 'bun:test'
import { createStore, Provider } from 'jotai'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Message, Session } from '../../../shared/types'
import { initializeSessionsAtom, refreshSessionsMetadataAtom, loadedSessionsAtom, sessionAtomFamily } from '../sessions'
import { pendingSessionAuthRequestsAtom } from '../session-auth-requests'
import { processEvent } from '../../event-processor/processor'
import { usePendingDescendantAuthRequests } from '../../context/AppShellContext'
import { projectConversation } from '../../../../../../packages/ui/src/components/chat/conversation-presentation'

const authMessage: Message = {
  id: 'auth-message', role: 'auth-request', content: 'Connect Drive', timestamp: 2,
  authRequestId: 'oauth-1', authRequestType: 'oauth', authSourceSlug: 'drive', authSourceName: 'Drive', authStatus: 'pending',
}
function session(id: string, overrides: Partial<Session> = {}): Session {
  return { id, workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 1, isProcessing: false, messages: [], ...overrides }
}
function PendingAuthProbe() {
  const requests = usePendingDescendantAuthRequests('parent')
  const presentation = projectConversation([{ id: 'user', role: 'user', content: 'Prepare report', timestamp: 1 }], {
    isProcessing: false, awaitingInput: requests.length > 0,
  })
  return <div data-state={presentation.progress?.state}>{requests.map(request =>
    <span key={request.message.id} data-session-id={request.sessionId}>{request.message.authSourceName}</span>)}</div>
}

describe('delegated auth request relay', () => {
  it('shows OAuth emitted in a paused child in its idle parent, keeping the child response target', () => {
    const store = createStore()
    const parent = session('parent')
    const child = session('child', { parentSessionId: 'parent', isProcessing: true })
    store.set(initializeSessionsAtom, [parent, child])
    const requested = processEvent({ session: child, streaming: null }, {
      type: 'auth_request', sessionId: 'child', message: authMessage,
      request: { type: 'oauth', requestId: 'oauth-1', sessionId: 'child', sourceSlug: 'drive', sourceName: 'Drive' },
    })
    store.set(sessionAtomFamily('child'), requested.state.session)
    expect(requested.state.session.isProcessing).toBe(false)
    expect(requested.effects).toEqual([])
    expect(store.get(pendingSessionAuthRequestsAtom)).toEqual([{ sessionId: 'child', message: authMessage }])
    const html = renderToStaticMarkup(<Provider store={store}><PendingAuthProbe /></Provider>)
    expect(html).toContain('data-state="waiting"')
    expect(html).toContain('data-session-id="child"')
    expect(html).toContain('Drive')
    expect(store.get(sessionAtomFamily('parent'))?.messages).toEqual([])

    const completed = processEvent(requested.state, { type: 'auth_completed', sessionId: 'child', requestId: 'oauth-1', success: true })
    store.set(sessionAtomFamily('child'), completed.state.session)
    expect(store.get(pendingSessionAuthRequestsAtom)).toEqual([])
    expect(completed.state.session.pendingAuthRequestMessage).toBeUndefined()
  })

  it('restores the pending card from lightweight session metadata and clears it without loading a transcript', () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'parent', pendingAuthRequestMessage: authMessage })
    store.set(initializeSessionsAtom, [session('parent'), child])
    expect(store.get(pendingSessionAuthRequestsAtom)).toEqual([{ sessionId: 'child', message: authMessage }])
    expect(store.get(sessionAtomFamily('child'))?.messages).toEqual([])
    const completed = processEvent({ session: child, streaming: null }, { type: 'auth_completed', sessionId: 'child', requestId: 'oauth-1', success: false, cancelled: true })
    store.set(sessionAtomFamily('child'), completed.state.session)
    expect(store.get(pendingSessionAuthRequestsAtom)).toEqual([])
  })

  it('ignores unrelated child streaming and does not duplicate a snapshot already present in history', () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'parent', pendingAuthRequestMessage: authMessage, messages: [authMessage] })
    store.set(initializeSessionsAtom, [session('parent'), child])
    let updates = 0
    const unsubscribe = store.sub(pendingSessionAuthRequestsAtom, () => { updates += 1 })
    const before = store.get(pendingSessionAuthRequestsAtom)
    store.set(sessionAtomFamily('child'), { ...child, messages: [...child.messages, { id: 'tool', role: 'tool', content: 'Technical progress', timestamp: 3 }] })
    expect(store.get(pendingSessionAuthRequestsAtom)).toBe(before)
    expect(before).toHaveLength(1)
    expect(updates).toBe(0)
    unsubscribe()
  })

  it('removes a stale auth card when a reconnect snapshot no longer has a runtime request', () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'parent', pendingAuthRequestMessage: authMessage, messages: [authMessage] })
    store.set(initializeSessionsAtom, [session('parent'), child])
    store.set(loadedSessionsAtom, new Set(['child']))
    expect(store.get(pendingSessionAuthRequestsAtom)).toHaveLength(1)
    store.set(refreshSessionsMetadataAtom, {
      sessions: [session('parent'), session('child', { parentSessionId: 'parent' })],
      loadedSessionIds: store.get(loadedSessionsAtom),
    })
    expect(store.get(pendingSessionAuthRequestsAtom)).toEqual([])
    expect(store.get(sessionAtomFamily('child'))?.messages).toEqual([authMessage])
  })
})
