import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Message, UserInputRequest } from '@craft-agent/core/types'
import type { Session } from '../../../shared/types'
import type { AgentEvent } from '../../event-processor/types'
import { processEvent } from '../../event-processor/processor'
import { initializeSessionsAtom, refreshSessionsMetadataAtom, sessionAtomFamily, updateSessionAtom } from '../sessions'
import { conversationAgentActivityAtom } from '../session-journey-activity'

function session(id: string, overrides: Partial<Session> = {}): Session {
  return { id, name: id, workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 1,
    isProcessing: false, messages: [], ...overrides }
}
const commentary = (id: string, timestamp: number, content: string): Message => ({
  id, timestamp, content, role: 'assistant', isIntermediate: true,
})
function receive(store: ReturnType<typeof createStore>, event: AgentEvent) {
  store.set(updateSessionAtom, event.sessionId, current => current
    ? processEvent({ session: current, streaming: null }, event).state.session : current)
}

describe('delegated journey activity in the parent conversation', () => {
  it('updates after a child answer resumes, commentary and tool events without changing the child count or parent transcript', () => {
    const store = createStore()
    const parent = session('parent', { messages: [commentary('old-parent', 1, 'Je prépare le plan initial.')] })
    const request: UserInputRequest = { id: 'question', sessionId: 'child', originWorkspaceId: 'workspace',
      status: 'answered', createdAt: 2, answeredAt: 3, questions: [{ id: 'q', question: 'Quel public ?' }],
      answers: [{ questionId: 'q', optionIds: [], text: 'Les lecteurs réguliers' }] }
    store.set(initializeSessionsAtom, [parent, session('child', { parentSessionId: 'parent', name: 'Analyse des lecteurs' })])
    const activity = conversationAgentActivityAtom('parent')
    let updates = 0
    const unsubscribe = store.sub(activity, () => { updates++ })
    receive(store, { type: 'user_input_changed', sessionId: 'parent', requests: [request] })
    receive(store, { type: 'user_message', sessionId: 'child', status: 'processing', message: {
      id: 'answer', timestamp: 3, role: 'user', content: 'Recorded answer', hidden: true,
    } })
    expect(store.get(activity).activeCount).toBe(1)
    const resumed = store.get(activity)
    receive(store, { type: 'text_complete', sessionId: 'child', messageId: 'commentary', timestamp: 4,
      text: 'Je rapproche les réponses avec les statistiques de lecture.', isIntermediate: true })
    expect(store.get(activity)).not.toBe(resumed)
    expect(store.get(activity).latest?.activity.title).toBe('Je rapproche les réponses avec les statistiques de lecture.')
    receive(store, { type: 'tool_start', sessionId: 'child', toolUseId: 'read', toolName: 'Read', timestamp: 5,
      toolIntent: 'Comparer les résultats de septembre', toolInput: { secret: 'PRIVATE_TOOL_INPUT' } })
    expect(store.get(activity).activeCount).toBe(1)
    expect(store.get(activity).latest?.activity.detail).toBe('Comparer les résultats de septembre')
    expect(store.get(activity).latest?.activity.observedAt).toBe(5)
    receive(store, { type: 'tool_result', sessionId: 'child', toolUseId: 'read', timestamp: 6, result: 'PRIVATE_TOOL_RESULT' })
    expect(store.get(activity).latest?.activity.detail).toBeUndefined()
    expect(JSON.stringify(store.get(activity))).not.toContain('PRIVATE_')
    receive(store, { type: 'complete', sessionId: 'child', reason: 'complete' })
    expect(store.get(activity)).toEqual({ activeCount: 0, latest: undefined })
    expect(store.get(sessionAtomFamily('parent'))?.messages).toEqual(parent.messages)
    expect(store.get(sessionAtomFamily('parent'))?.isProcessing).toBe(false)
    expect(updates).toBeGreaterThanOrEqual(5)
    unsubscribe()
  })

  it('selects the latest observed active descendant, and changes agents even when their count stays the same', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('parent'),
      session('child-a', { parentSessionId: 'parent', isProcessing: true,
        messages: [commentary('a', 2, 'Je rassemble les factures.')] }),
      session('child-b', { parentSessionId: 'parent' }),
      session('grandchild', { parentSessionId: 'child-b', isProcessing: true, name: 'Vérification des montants',
        messages: [commentary('b', 4, 'Je vérifie les montants du rapport.')] }),
      session('unrelated', { isProcessing: true, messages: [commentary('other', 99, 'UNRELATED_PRIVATE_ACTIVITY')] })])
    const activity = conversationAgentActivityAtom('parent')
    expect(store.get(activity).activeCount).toBe(2)
    expect(store.get(activity).latest?.sessionId).toBe('grandchild')
    store.set(updateSessionAtom, 'grandchild', current => ({ ...current!, isProcessing: false }))
    expect(store.get(activity).latest?.sessionId).toBe('child-a')
    const before = store.get(activity)
    // Reconnect supplies the same count with a different active child.
    store.set(refreshSessionsMetadataAtom, { sessions: [session('parent'),
      session('child-a', { parentSessionId: 'parent' }),
      session('child-b', { parentSessionId: 'parent', isProcessing: true,
        messages: [commentary('c', 7, 'Je rapproche les tableaux de synthèse.')] })], loadedSessionIds: new Set<string>() })
    expect(store.get(activity).activeCount).toBe(before.activeCount)
    expect(store.get(activity)).not.toBe(before)
    expect(store.get(activity).latest?.sessionId).toBe('child-b')
    expect(JSON.stringify(store.get(activity))).not.toContain('UNRELATED_')
  })

  it('clears active status on reconnect while retaining loaded history', () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'parent', isProcessing: true,
      messages: [commentary('old', 2, 'Je vérifie les derniers chiffres.')] })
    store.set(initializeSessionsAtom, [session('parent'), child])
    const activity = conversationAgentActivityAtom('parent')
    expect(store.get(activity).activeCount).toBe(1)
    store.set(refreshSessionsMetadataAtom, { sessions: [session('parent'), session('child', { parentSessionId: 'parent' })],
      loadedSessionIds: new Set(['child']) })
    expect(store.get(activity).activeCount).toBe(0)
    expect(store.get(activity).latest).toBeUndefined()
    expect(store.get(sessionAtomFamily('child'))?.messages).toEqual(child.messages)
  })

  it('uses an honest metadata-only fallback without hydrating histories', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('parent'), session('child', {
      parentSessionId: 'parent', name: 'Lecture des documents', isProcessing: true,
    })])
    expect(store.get(conversationAgentActivityAtom('parent'))).toEqual({ activeCount: 1,
      latest: { sessionId: 'child', sessionName: 'Lecture des documents', activity: { completedSteps: 0, totalSteps: 0 } } })
    expect(store.get(sessionAtomFamily('child'))?.messages).toEqual([])
  })

  it('bounds safe names and ignores hidden, internal and streaming content when picking current activity', () => {
    const store = createStore()
    store.set(initializeSessionsAtom, [session('parent'), session('child', {
      parentSessionId: 'parent', isProcessing: true, name: 'Vérification token=SECRET_NAME',
      messages: [commentary('public', 2, 'Je compare le rapport avec les pièces justificatives.'),
        { ...commentary('hidden', 3, 'HIDDEN_DATA'), hidden: true },
        { ...commentary('internal', 4, 'INTERNAL_DATA'), internalOrigin: { kind: 'agent-message', senderSessionId: 'other' } },
        { ...commentary('stream', 5, 'PARTIAL_DATA'), isStreaming: true }],
    })])
    const activity = store.get(conversationAgentActivityAtom('parent'))
    expect(activity.latest?.activity.observedAt).toBe(2)
    expect(activity.latest?.activity.title).toBe('Je compare le rapport avec les pièces justificatives.')
    for (const secret of ['SECRET_NAME', 'HIDDEN_DATA', 'INTERNAL_DATA', 'PARTIAL_DATA']) expect(JSON.stringify(activity)).not.toContain(secret)
  })

  it('does not notify a parent about unrelated messages or unchanged partial streams', () => {
    const store = createStore()
    const child = session('child', { parentSessionId: 'parent', isProcessing: true,
      messages: [commentary('public', 2, 'Je lis les résultats du questionnaire.')] })
    store.set(initializeSessionsAtom, [session('parent'), child, session('unrelated', { isProcessing: true })])
    const activity = conversationAgentActivityAtom('parent')
    let updates = 0
    const unsubscribe = store.sub(activity, () => { updates++ })
    const before = store.get(activity)
    store.set(updateSessionAtom, 'unrelated', current => ({ ...current!, messages: [commentary('other', 10, 'Other activity')] }))
    store.set(updateSessionAtom, 'child', current => ({ ...current!, messages: [...current!.messages,
      { ...commentary('stream', 11, 'Partial stream'), isStreaming: true }] }))
    expect(store.get(activity)).toBe(before)
    expect(updates).toBe(0)
    unsubscribe()
  })
})
