import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Session } from '../../../shared/types'
import { initializeSessionsAtom, loadedSessionsAtom, refreshSessionsMetadataAtom, sessionAtomFamily } from '../sessions'
import { sessionPermissionRecoveryRequestsAtom } from '../session-permission-recovery'
import { useConversationPermissionRecoveries } from '../../context/AppShellContext'
import { projectConversation } from '../../../../../../packages/ui/src/components/chat/conversation-presentation'
import { processEvent } from '../../event-processor/processor'

function session(id: string, overrides: Partial<Session> = {}): Session {
  return { id, name: id, workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 1,
    isProcessing: false, messages: [], ...overrides }
}
function pending(recoveryRequired = true): NonNullable<Session['pendingTurnRecovery']> {
  return { userMessageId: 'accepted-user', startedAt: 1, attempts: 0,
    waitingForPermission: { requestId: 'permission-1', requestedAt: 2, toolName: 'Bash', recoveryRequired } }
}
function Probe() {
  const requests = useConversationPermissionRecoveries('parent')
  const presentation = projectConversation([{ id: 'accepted-user', role: 'user', content: 'Prepare report', timestamp: 1 }], {
    isProcessing: false, awaitingInput: requests.length > 0,
  })
  return <div data-state={presentation.progress?.state}>{requests.map(request =>
    <span key={request.sessionId} data-target={request.sessionId}>{request.sessionName}</span>)}</div>
}

describe('permission recovery after restart', () => {
  it('surfaces the parent and its paused grandchild from metadata without exposing unrelated requests', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('parent', { pendingTurnRecovery: pending() }),
      session('child', { parentSessionId: 'parent' }),
      session('grandchild', { parentSessionId: 'child', pendingTurnRecovery: pending() }),
      session('unrelated', { pendingTurnRecovery: pending() })])
    const html = renderToStaticMarkup(<Provider store={store}><Probe /></Provider>)
    expect(html).toContain('data-state="waiting"')
    expect(html).toContain('data-target="parent"')
    expect(html).toContain('data-target="grandchild"')
    expect(html).not.toContain('unrelated')
    expect(store.get(sessionAtomFamily('grandchild'))?.messages).toEqual([])
    expect(store.get(sessionPermissionRecoveryRequestsAtom).find(request => request.sessionId === 'grandchild')?.userMessageId)
      .toBe('accepted-user')
  })

  it('never creates a recovery action for a live permission dialog or an active runtime', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('live', { pendingTurnRecovery: pending(false) }),
      session('active', { isProcessing: true, pendingTurnRecovery: pending() })])
    expect(store.get(sessionPermissionRecoveryRequestsAtom)).toEqual([])
  })

  it('removes the old wait on an objective update without losing messages or granting permission', () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'parent', pendingTurnRecovery: pending(),
      messages: [{ id: 'accepted-user', role: 'user', content: 'Prepare report', timestamp: 1 }] })
    store.set(initializeSessionsAtom, [session('parent'), child])
    expect(store.get(sessionPermissionRecoveryRequestsAtom)).toHaveLength(1)
    const next = processEvent({ session: child, streaming: null }, {
      type: 'objective_changed', sessionId: 'child', activeObjective: null,
      pendingTurnRecovery: { userMessageId: 'accepted-user', startedAt: 1, attempts: 0, lastCause: 'user_retry' },
    })
    store.set(sessionAtomFamily('child'), next.state.session)
    expect(store.get(sessionPermissionRecoveryRequestsAtom)).toEqual([])
    expect(next.state.session.messages).toEqual(child.messages)
    expect(next.effects).toEqual([])
  })

  it('clears stale waits on reconnect even when the old transcript is retained', () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'parent', pendingTurnRecovery: pending(),
      messages: [{ id: 'accepted-user', role: 'user', content: 'Prepare report', timestamp: 1 }] })
    store.set(initializeSessionsAtom, [session('parent'), child])
    store.set(loadedSessionsAtom, new Set(['child']))
    store.set(refreshSessionsMetadataAtom, { sessions: [session('parent'), session('child', { parentSessionId: 'parent' })],
      loadedSessionIds: store.get(loadedSessionsAtom) })
    expect(store.get(sessionPermissionRecoveryRequestsAtom)).toEqual([])
    expect(store.get(sessionAtomFamily('child'))?.messages).toEqual(child.messages)
  })

  it('does not notify all conversations for unrelated tool streaming', () => {
    const store = createStore()
    const child = session('child', { pendingTurnRecovery: pending() })
    store.set(initializeSessionsAtom, [child])
    let updates = 0
    const unsubscribe = store.sub(sessionPermissionRecoveryRequestsAtom, () => { updates++ })
    const before = store.get(sessionPermissionRecoveryRequestsAtom)
    store.set(sessionAtomFamily('child'), { ...child, messages: [{ id: 'tool', role: 'tool', content: 'Internal event', timestamp: 3 }] })
    expect(store.get(sessionPermissionRecoveryRequestsAtom)).toBe(before)
    expect(updates).toBe(0)
    unsubscribe()
  })
})
