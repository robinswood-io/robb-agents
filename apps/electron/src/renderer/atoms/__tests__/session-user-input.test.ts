import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { UserInputRequest } from '@craft-agent/core/types'
import type { Session } from '../../../shared/types'
import { processEvent } from '../../event-processor/processor'
import { mergeUserInputRequests } from '../../lib/user-input-state'
import { sessionAtomFamily, sessionMetaMapAtom, initializeSessionsAtom, refreshSessionsMetadataAtom, syncSessionsToAtomsAtom, ensureSessionMessagesLoadedAtom } from '../sessions'

const pending: UserInputRequest = {
  id: 'input-request', sessionId: 'input-child', originWorkspaceId: 'workspace-input', status: 'pending', createdAt: 1,
  questions: [{ id: 'q', question: 'Quel public ?' }],
}
const answered: UserInputRequest = { ...pending, status: 'answered', answeredAt: 3, answers: [{ questionId: 'q', optionIds: [], text: 'Les lecteurs réguliers' }] }
const session = (id: string, request = pending): Session => ({ id, workspaceId: 'workspace-input', workspaceName: 'Workspace', lastMessageAt: 1, messages: [], isProcessing: false, userInputRequests: [request] })
const originalWindow = globalThis.window
afterEach(() => { globalThis.window = originalWindow })

describe('persisted user question snapshots', () => {
  it('receives a child question in the parent without marking parallel work idle', () => {
    const state = { session: { ...session('input-parent'), isProcessing: true }, streaming: { content: 'ongoing', turnId: 'turn' } }
    const updated = processEvent(state, { type: 'user_input_changed', sessionId: 'input-parent', requests: [pending] })
    expect(updated.state.session.userInputRequests?.[0]?.sessionId).toBe('input-child')
    expect(updated.state.session.isProcessing).toBe(true)
    expect(updated.state.streaming).toBe(state.streaming)
    expect(updated.effects).toEqual([])
  })

  it('never reopens an answer or drops newer requests due to an older snapshot', () => {
    expect(mergeUserInputRequests([answered], [pending])).toEqual([answered])
    expect(mergeUserInputRequests([answered], [])).toEqual([answered])
    expect(mergeUserInputRequests([pending], [])).toEqual([pending])
    expect(mergeUserInputRequests([pending], [{ ...pending, status: 'cancelled' }])[0]?.status).toBe('cancelled')
    const cancelled = { ...answered, status: 'cancelled' as const, answeredAt: 4 }
    expect(mergeUserInputRequests([answered], [cancelled])).toEqual([cancelled])
    expect(mergeUserInputRequests([cancelled], [answered])).toEqual([cancelled])
  })

  it('restores pending DTO questions before messages load and preserves answered state on refresh/sync', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('input-refresh')])
    expect(store.get(sessionAtomFamily('input-refresh'))?.messages).toEqual([])
    expect(store.get(sessionMetaMapAtom).get('input-refresh')?.hasPendingUserInput).toBe(true)
    store.set(sessionAtomFamily('input-refresh'), session('input-refresh', answered))
    store.set(refreshSessionsMetadataAtom, { sessions: [session('input-refresh')], loadedSessionIds: new Set<string>() })
    expect(store.get(sessionAtomFamily('input-refresh'))?.userInputRequests).toEqual([answered])
    expect(store.get(sessionMetaMapAtom).get('input-refresh')?.hasPendingUserInput).toBe(false)
    store.set(syncSessionsToAtomsAtom, [session('input-refresh')])
    expect(store.get(sessionAtomFamily('input-refresh'))?.userInputRequests).toEqual([answered])
    expect(store.get(sessionMetaMapAtom).get('input-refresh')?.hasPendingUserInput).toBe(false)
  })

  it('preserves an answer received while an older history response is in flight', async () => {
    const store = createStore()
    let resolve!: (value: Session) => void
    globalThis.window = { electronAPI: { getSessionMessages: () => new Promise<Session>(done => { resolve = done }) } } as unknown as typeof window
    store.set(sessionAtomFamily('input-load'), session('input-load'))
    const loading = store.set(ensureSessionMessagesLoadedAtom, 'input-load')
    store.set(sessionAtomFamily('input-load'), session('input-load', answered))
    resolve(session('input-load'))
    expect((await loading)?.userInputRequests).toEqual([answered])
  })
})
