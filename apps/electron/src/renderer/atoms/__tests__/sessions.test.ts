import { afterEach, describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import type { Message, Session } from '../../../shared/types'
import { handleTextComplete } from '../../event-processor/handlers/text'
import { getSessionProcessingRevision, markSessionProcessingState } from '../../lib/session-processing-state'
import { projectConversation } from '../../../../../../packages/ui/src/components/chat/conversation-presentation'
import {
  sessionAtomFamily,
  sessionMetaMapAtom,
  sessionIdsAtom,
  loadedSessionsAtom,
  ensureSessionMessagesLoadedAtom,
  forceSessionMessagesReloadAtom,
  refreshSessionsMetadataAtom,
  initializeSessionsAtom,
  replaceLoadedSessionAtom,
  extractSessionMeta,
} from '../sessions'

function msg(id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    role,
    content: `content:${id}`,
    timestamp: Date.now(),
  }
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: overrides.id ?? 'session-1',
    workspaceId: overrides.workspaceId ?? 'workspace-1',
    messages: overrides.messages ?? [],
    permissionMode: overrides.permissionMode ?? 'ask',
    supportsBranching: overrides.supportsBranching ?? true,
    ...overrides,
  } as Session
}

describe('session metadata projection', () => {
  it('uses terminal objective truth instead of stale lifecycle status', () => {
    const verified = extractSessionMeta(makeSession({
      sessionStatus: 'needs-review',
      activeObjective: { terminalState: 'complete_verified' } as NonNullable<Session['activeObjective']>,
    }))
    const exhausted = extractSessionMeta(makeSession({
      sessionStatus: 'in-progress',
      activeObjective: { terminalState: 'exhausted' } as NonNullable<Session['activeObjective']>,
    }))

    expect(verified.sessionStatus).toBe('done')
    expect(exhausted.sessionStatus).toBe('needs-review')
  })

  it('retains host delegation lineage for fail-closed child visibility', () => {
    const delegation = {
      rootSessionId: 'root', rootObjectiveId: 'objective', parentObjectiveId: 'objective',
      depth: 1, role: 'worker' as const,
    }
    expect(extractSessionMeta(makeSession({ delegation })).delegation).toEqual(delegation)
  })

  it('projects pending authentication into lightweight child activity metadata', () => {
    const pendingAuthRequestMessage = msg('auth-request')
    expect(extractSessionMeta(makeSession({ pendingAuthRequestMessage })).hasPendingAuth).toBe(true)
    expect(extractSessionMeta(makeSession()).hasPendingAuth).toBe(false)
  })
})

describe('session message loading atoms', () => {
  const originalWindow = globalThis.window

  function deferredLoad(id: string, messages: Message[], isProcessing = true) {
    const store = createStore()
    let resolve!: (session: Session) => void
    globalThis.window = { electronAPI: { getSessionMessages: () => new Promise<Session>(done => { resolve = done }) } } as unknown as typeof window
    store.set(sessionAtomFamily(id), makeSession({ id, messages, isProcessing, hasUnread: false }))
    const result = store.set(ensureSessionMessagesLoadedAtom, id)
    return { store, resolve, result }
  }

  it.each([[false, true], [true, false]] as const)('reconciles an unchanged local processing=%s from the fresh server snapshot=%s', async (initial, server) => {
    const id = `processing-snapshot-${initial}`
    const { store, resolve, result } = deferredLoad(id, [], initial)
    store.set(sessionMetaMapAtom, new Map([[id, { id, workspaceId: 'workspace-1', isProcessing: initial, hasUnread: false }]]))
    resolve(makeSession({ id, isProcessing: server, messages: [msg('history')] }))
    const loaded = await result
    expect(loaded?.isProcessing).toBe(server)
    expect(store.get(sessionAtomFamily(id))?.isProcessing).toBe(server)
    expect(store.get(sessionMetaMapAtom).get(id)?.isProcessing).toBe(server)
    expect(store.get(sessionMetaMapAtom).get(id)?.hasUnread).toBe(false)
  })

  it('accepts fresh processing state while preserving unrelated optimistic UI changes', async () => {
    const id = 'processing-snapshot-ui-change'
    const { store, resolve, result } = deferredLoad(id, [], false)
    store.set(sessionAtomFamily(id), { ...store.get(sessionAtomFamily(id))!, isFlagged: true, hasUnread: false })
    resolve(makeSession({ id, isProcessing: true, isFlagged: false, hasUnread: true, messages: [msg('history')] }))
    const loaded = await result
    expect(loaded).toMatchObject({ isProcessing: true, isFlagged: true, hasUnread: false })
  })

  it('does not revive processing after start then Stop while the snapshot is in flight', async () => {
    const id = 'processing-start-stop-race'
    const { store, resolve, result } = deferredLoad(id, [], false)
    store.set(sessionAtomFamily(id), markSessionProcessingState({ ...store.get(sessionAtomFamily(id))!, isProcessing: true }))
    store.set(sessionAtomFamily(id), markSessionProcessingState({ ...store.get(sessionAtomFamily(id))!, isProcessing: false }))
    resolve(makeSession({ id, isProcessing: true, messages: [msg('history')] }))
    expect((await result)?.isProcessing).toBe(false)
  })

  it('keeps an explicit same-value Stop after a missed startup signal', async () => {
    const id = 'processing-same-value-stop'
    const { store, resolve, result } = deferredLoad(id, [], false)
    store.set(sessionAtomFamily(id), markSessionProcessingState({ ...store.get(sessionAtomFamily(id))!, isProcessing: false }))
    resolve(makeSession({ id, isProcessing: true, messages: [msg('history')] }))
    expect((await result)?.isProcessing).toBe(false)
  })

  it('retains processing revision across spreads without serializing or mutating it', () => {
    const session = makeSession({ isProcessing: false })
    const marked = markSessionProcessingState(session)
    expect(marked).not.toBe(session)
    expect(getSessionProcessingRevision(session)).toBe(0)
    expect(getSessionProcessingRevision(marked)).toBeGreaterThan(0)
    expect(getSessionProcessingRevision({ ...marked, hasUnread: false })).toBe(getSessionProcessingRevision(marked))
    expect(getSessionProcessingRevision(markSessionProcessingState(marked))).toBeGreaterThan(getSessionProcessingRevision(marked))
    expect(JSON.stringify(marked)).toBe(JSON.stringify(session))
    expect(getSessionProcessingRevision(JSON.parse(JSON.stringify(marked)))).toBe(0)
  })

  it('does not stop a newly started turn when an idle snapshot was already loading', async () => {
    const id = 'processing-start-race'
    const { store, resolve, result } = deferredLoad(id, [], false)
    store.set(sessionAtomFamily(id), { ...store.get(sessionAtomFamily(id))!, isProcessing: true })
    resolve(makeSession({ id, isProcessing: false, messages: [msg('history')] }))
    expect((await result)?.isProcessing).toBe(true)
  })

  it('keeps the processing state of a newer forced load when the older request resolves last', async () => {
    const id = 'processing-overlapping-loads'
    const store = createStore()
    const resolvers: Array<(session: Session) => void> = []
    globalThis.window = { electronAPI: { getSessionMessages: () => new Promise<Session>(resolve => resolvers.push(resolve)) } } as unknown as typeof window
    store.set(sessionAtomFamily(id), makeSession({ id, isProcessing: false }))
    const older = store.set(ensureSessionMessagesLoadedAtom, id)
    const newer = store.set(forceSessionMessagesReloadAtom, id)
    resolvers[1]!(makeSession({ id, isProcessing: false, messages: [msg('new-history')] }))
    await newer
    resolvers[0]!(makeSession({ id, isProcessing: true, messages: [msg('old-history')] }))
    expect((await older)?.isProcessing).toBe(false)
    expect(store.get(sessionAtomFamily(id))?.isProcessing).toBe(false)
  })

  it.each(['replace', 'initialize', 'refresh'] as const)('does not lose Stop ordering after a full %s snapshot replacement', async (kind) => {
    const id = `processing-replacement-${kind}`
    const store = createStore()
    store.set(initializeSessionsAtom, [makeSession({ id, isProcessing: false })])
    const before = getSessionProcessingRevision(store.get(sessionAtomFamily(id)))
    let resolve!: (session: Session) => void
    globalThis.window = { electronAPI: { getSessionMessages: () => new Promise<Session>(done => { resolve = done }) } } as unknown as typeof window
    const result = store.set(ensureSessionMessagesLoadedAtom, id)
    store.set(sessionAtomFamily(id), markSessionProcessingState({ ...store.get(sessionAtomFamily(id))!, isProcessing: false }))
    const fresh = makeSession({ id, isProcessing: false, messages: [msg('replacement-history')] })
    if (kind === 'replace') store.set(replaceLoadedSessionAtom, fresh)
    else if (kind === 'initialize') store.set(initializeSessionsAtom, [fresh])
    else store.set(refreshSessionsMetadataAtom, { sessions: [fresh], loadedSessionIds: new Set<string>() })
    expect(getSessionProcessingRevision(store.get(sessionAtomFamily(id)))).toBeGreaterThan(before)
    resolve(makeSession({ id, isProcessing: true, messages: [msg('older-history')] }))
    expect((await result)?.isProcessing).toBe(false)
  })

  it('hydrates full cold history when a tool starts before the request resolves', async () => {
    const id = 'cold-stream-race'
    const { store, resolve, result } = deferredLoad(id, [])
    const liveTool = { ...msg('local-tool', 'tool'), toolUseId: 'call-live', toolStatus: 'executing' as const, timestamp: 3 }
    store.set(sessionAtomFamily(id), makeSession({ id, isProcessing: true, hasUnread: false, messages: [liveTool] }))
    resolve(makeSession({ id, messages: [{ ...msg('human-history'), timestamp: 1 }, { ...msg('old-answer', 'assistant'), timestamp: 2 }] }))
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['human-history', 'old-answer', 'local-tool'])
    expect(loaded?.isProcessing).toBe(true)
    expect(loaded?.hasUnread).toBe(false)
    expect(store.get(loadedSessionsAtom).has(id)).toBe(true)
  })

  it('merges a live tool result by toolUseId and keeps the canonical history id', async () => {
    const id = 'tool-result-race'
    const tool = { ...msg('temporary-tool', 'tool'), toolUseId: 'call-result', toolStatus: 'executing' as const, timestamp: 2 }
    const { store, resolve, result } = deferredLoad(id, [tool])
    const final = { ...msg('new-final', 'assistant'), timestamp: 4 }
    store.set(sessionAtomFamily(id), makeSession({ id, isProcessing: false, messages: [
      { ...tool, toolStatus: 'completed', toolResult: 'real result', toolExecuted: true }, final,
    ] }))
    store.set(sessionMetaMapAtom, new Map([[id, { id, workspaceId: 'workspace-1', lastFinalMessageId: final.id }]]))
    resolve(makeSession({ id, messages: [{ ...msg('history'), timestamp: 1 }, { ...tool, id: 'canonical-tool' }, { ...msg('old-final', 'assistant'), timestamp: 3 }] }))
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['history', 'canonical-tool', 'old-final', 'new-final'])
    expect(loaded?.messages.find(message => message.toolUseId === tool.toolUseId)).toMatchObject({ id: 'canonical-tool', toolStatus: 'completed', toolResult: 'real result', toolExecuted: true })
    expect(loaded?.isProcessing).toBe(false)
    expect(store.get(sessionMetaMapAtom).get(id)?.lastFinalMessageId).toBe('new-final')
  })

  it('replaces a temporary stream with the matching final without merging other parents or completed comments', async () => {
    const id = 'stream-final-race'
    const stream = { ...msg('temporary-stream', 'assistant'), turnId: 'turn-one', content: 'complete', isStreaming: true, isPending: true, timestamp: 4 }
    const { store, resolve, result } = deferredLoad(id, [stream])
    const final = { ...stream, id: 'canonical-final', content: 'complete response', isStreaming: false, isPending: false }
    const comment = { ...final, id: 'comment', content: 'earlier comment', isIntermediate: true, timestamp: 2 }
    const child = { ...final, id: 'child-final', parentToolUseId: 'child', timestamp: 3 }
    resolve(makeSession({ id, messages: [{ ...msg('history'), timestamp: 1 }, comment, child, final] }))
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['history', 'comment', 'child-final', 'canonical-final'])
    expect(loaded?.messages[3]).toMatchObject({ content: 'complete response', isStreaming: false, isPending: false })
  })

  it('keeps the authoritative final received while an older streaming snapshot is loading', async () => {
    const id = 'live-final-race'
    const stream = { ...msg('local-stream', 'assistant'), turnId: 'turn-two', content: 'final', isStreaming: true, isPending: true, timestamp: 2 }
    const { store, resolve, result } = deferredLoad(id, [stream])
    store.set(sessionAtomFamily(id), makeSession({ id, isProcessing: false, messages: [{ ...stream, id: 'live-final', content: 'final received', isStreaming: false, isPending: false }] }))
    resolve(makeSession({ id, messages: [{ ...msg('history'), timestamp: 1 }, { ...stream, id: 'snapshot-stream' }] }))
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['history', 'live-final'])
    expect(loaded?.messages[1]).toMatchObject({ content: 'final received', isStreaming: false, isPending: false })
  })

  it('keeps a live demoted report visible when hydration returns its older stream', async () => {
    const id = 'live-rejected-final-race'
    const human = { ...msg('human'), timestamp: 1 }
    const stream = { ...msg('local-stream', 'assistant'), turnId: 'turn', content: 'Rapport', isStreaming: true, isPending: true, timestamp: 2 }
    const { store, resolve, result } = deferredLoad(id, [human, stream])
    const completed = handleTextComplete({ session: store.get(sessionAtomFamily(id))!, streaming: null }, {
      type: 'text_complete', sessionId: id, turnId: 'turn', messageId: 'canonical-report',
      text: 'Rapport rédigé, validation incomplète.', isIntermediate: true, timestamp: 2,
      objectiveOutcome: null, objectiveOutcomeError: 'malformed objective outcome receipt',
    }).session
    store.set(sessionAtomFamily(id), { ...completed, isProcessing: false })
    resolve(makeSession({ id, messages: [human, { ...stream, id: 'disk-stream' }] }))
    const loaded = (await result)!
    expect(loaded.messages.map(message => message.id)).toEqual(['human', 'canonical-report'])
    expect(loaded.messages[1]?.objectiveOutcomeError).toBe('malformed objective outcome receipt')
    const presentation = projectConversation(loaded.messages, loaded)
    expect(presentation.turns.flatMap(turn => turn.type === 'assistant' && turn.response ? [turn.response.text] : []))
      .toEqual(['Rapport rédigé, validation incomplète.'])
    expect(presentation.outcome?.state).toBe('unverified')
  })

  it('restores persisted receipt metadata and the same readable report on a cold history load', async () => {
    const id = 'persisted-rejected-final'
    const { resolve, result } = deferredLoad(id, [], false)
    resolve(makeSession({ id, isProcessing: false, messages: [
      { ...msg('human'), timestamp: 1 },
      { ...msg('report', 'assistant'), timestamp: 2, content: 'Document à vérifier.', isIntermediate: true,
        objectiveOutcomeError: 'malformed objective outcome receipt' },
    ] }))
    const loaded = (await result)!
    const presentation = projectConversation(loaded.messages, loaded)
    expect(presentation.turns.flatMap(turn => turn.type === 'assistant' && turn.response ? [turn.response.text] : []))
      .toEqual(['Document à vérifier.'])
    expect(presentation.outcome?.state).toBe('unverified')
  })

  it('keeps an exhausted hydrated report after a terminal error without validating its model receipt', async () => {
    const id = 'persisted-exhausted-final'
    const { store, resolve, result } = deferredLoad(id, [], false)
    const activeObjective: NonNullable<Session['activeObjective']> = {
      schemaVersion: 1, userMessageId: 'human', objectiveId: 'human', lastUserMessageId: 'human',
      originalText: 'Préparer le rapport.', startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0,
      continuationCount: 5, orchestrationMode: 'mission', risk: 'standard', terminalState: 'exhausted', completionCriteria: [],
    }
    store.set(sessionAtomFamily(id), { ...store.get(sessionAtomFamily(id))!, activeObjective })
    resolve(makeSession({ id, isProcessing: false, activeObjective, messages: [
      { ...msg('human'), timestamp: 1 },
      { ...msg('report', 'assistant'), timestamp: 2, content: 'Document rédigé.', isIntermediate: true,
        objectiveOutcome: { state: 'complete_verified', criteria: [], remainingWork: [], blocker: null } },
      { ...msg('failure', 'error'), timestamp: 3, content: 'Objective validation exhausted' },
    ] }))
    const loaded = (await result)!
    const presentation = projectConversation(loaded.messages, loaded)
    expect(presentation.turns.flatMap(turn => turn.type === 'assistant' && turn.response ? [turn.response.text] : []))
      .toEqual(['Document rédigé.'])
    expect(presentation.outcome).toMatchObject({ state: 'failed', hasFinalResponse: true, retryUserMessageId: 'human' })
  })

  it('does not resurrect a receipt error cleared live while an older final is loading', async () => {
    const id = 'cleared-outcome-race'
    const oldReport = { ...msg('report', 'assistant'), turnId: 'turn', timestamp: 2, objectiveOutcomeError: 'old extraction error' }
    const { store, resolve, result } = deferredLoad(id, [oldReport], false)
    const updated = handleTextComplete({ session: store.get(sessionAtomFamily(id))!, streaming: null }, {
      type: 'text_complete', sessionId: id, turnId: 'turn', messageId: 'report', text: oldReport.content,
      objectiveOutcome: null, objectiveOutcomeError: null, timestamp: 2,
    }).session
    store.set(sessionAtomFamily(id), updated)
    resolve(makeSession({ id, messages: [{ ...msg('human'), timestamp: 1 }, oldReport] }))
    const loaded = (await result)!
    expect(loaded.messages[1]?.objectiveOutcomeError).toBeUndefined()
  })

  it('preserves an authentication update received during loading without duplicating its request', async () => {
    const id = 'auth-result-race'
    const auth = { ...msg('local-auth', 'auth-request'), authRequestId: 'auth-one', authStatus: 'pending' as const, timestamp: 2 }
    const { store, resolve, result } = deferredLoad(id, [auth], false)
    store.set(sessionAtomFamily(id), makeSession({ id, isProcessing: false, messages: [{ ...auth, authStatus: 'completed' }] }))
    resolve(makeSession({ id, messages: [{ ...msg('history'), timestamp: 1 }, { ...auth, id: 'canonical-auth' }] }))
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['history', 'canonical-auth'])
    expect(loaded?.messages[1]?.authStatus).toBe('completed')
  })

  it('reconciles a fetched text_complete commentary with its temporary live stream', async () => {
    const id = 'fetched-commentary-race'
    const stream = { ...msg('temporary-commentary', 'assistant'), turnId: 'turn-commentary', content: 'Je vérifie', isStreaming: true, isPending: true, timestamp: 3 }
    const earlier = { ...msg('earlier-commentary', 'assistant'), turnId: stream.turnId, content: 'Première phase.', isIntermediate: true, timestamp: 2 }
    const history = { ...msg('history'), timestamp: 1 }
    const { store, resolve, result } = deferredLoad(id, [stream])
    const completed = handleTextComplete({ session: makeSession({ id, messages: [history, earlier, stream] }), streaming: null }, {
      type: 'text_complete', sessionId: id, turnId: stream.turnId, messageId: 'canonical-commentary',
      text: 'Je vérifie le résultat.', isIntermediate: true, timestamp: 3,
    }).session
    resolve(completed)
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['history', 'earlier-commentary', 'canonical-commentary'])
    expect(loaded?.messages[2]).toMatchObject({ isIntermediate: true, isStreaming: false, isPending: false, content: 'Je vérifie le résultat.' })
    expect(store.get(sessionMetaMapAtom).get(id)?.lastFinalMessageId).toBeUndefined()
  })

  it('keeps a live text_complete commentary when hydration returns its older stream', async () => {
    const id = 'live-commentary-race'
    const stream = { ...msg('temporary-commentary', 'assistant'), turnId: 'turn-commentary', content: 'Je vérifie', isStreaming: true, isPending: true, timestamp: 2 }
    const { store, resolve, result } = deferredLoad(id, [stream])
    const completed = handleTextComplete({ session: store.get(sessionAtomFamily(id))!, streaming: null }, {
      type: 'text_complete', sessionId: id, turnId: stream.turnId, messageId: 'canonical-commentary',
      text: 'Je vérifie le résultat.', isIntermediate: true, timestamp: 2,
    }).session
    store.set(sessionAtomFamily(id), completed)
    resolve(makeSession({ id, messages: [{ ...msg('history'), timestamp: 1 }, { ...stream, id: 'snapshot-stream' }] }))
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['history', 'canonical-commentary'])
    expect(loaded?.messages[1]).toMatchObject({ isIntermediate: true, isStreaming: false, isPending: false, content: 'Je vérifie le résultat.' })
  })

  it('keeps a new stream distinct from an earlier completed comment in the same turn', async () => {
    for (const content of ['Nouvelle phase.', 'Je vérifie']) {
      const id = `later-stream-${content}`
      const earlier = { ...msg('known-comment', 'assistant'), turnId: 'reused-turn', content: 'Je vérifie les sources.', isIntermediate: true, timestamp: 2 }
      const { store, resolve, result } = deferredLoad(id, [earlier])
      const stream = { ...msg('new-stream', 'assistant'), turnId: earlier.turnId, content, isStreaming: true, isPending: true, timestamp: 3 }
      store.set(sessionAtomFamily(id), makeSession({ id, isProcessing: true, messages: [earlier, stream] }))
      resolve(makeSession({ id, messages: [{ ...msg('history'), timestamp: 1 }, earlier] }))
      const loaded = await result
      expect(loaded?.messages.map(message => message.id)).toEqual(['history', 'known-comment', 'new-stream'])
      expect(loaded?.messages[2]).toMatchObject({ content, isStreaming: true })
    }
  })

  it('does not resurrect a queued user message removed while history is loading', async () => {
    const id = 'queued-removal-race'
    const queued = { ...msg('queued-human'), isQueued: true }
    const { store, resolve, result } = deferredLoad(id, [queued], false)
    store.set(sessionAtomFamily(id), makeSession({ id, isProcessing: false, messages: [] }))
    resolve(makeSession({ id, messages: [msg('history'), queued] }))
    const loaded = await result
    expect(loaded?.messages.map(message => message.id)).toEqual(['history'])
  })

  afterEach(() => {
    if (originalWindow) {
      globalThis.window = originalWindow
    } else {
      // @ts-expect-error test cleanup for window shim
      delete globalThis.window
    }
  })

  it('replaceLoadedSessionAtom marks authoritative full sessions as loaded', () => {
    const store = createStore()
    const sessionId = 'session-1'

    store.set(replaceLoadedSessionAtom, makeSession({
      id: sessionId,
      messages: [msg('m1'), msg('m2', 'assistant')],
    }))

    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get(sessionId)?.messageCount).toBe(2)
  })

  it('forceSessionMessagesReloadAtom reloads an empty-but-loaded session', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({ id: sessionId, messages: [] }))
    store.set(loadedSessionsAtom, new Set([sessionId]))

    const normalResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(calls).toEqual([])
    expect(normalResult?.messages).toHaveLength(0)

    const forcedResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId])
    expect(forcedResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionAtomFamily(sessionId))?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })

  it('does not mark stale empty-response fallback as loaded', async () => {
    const store = createStore()
    const sessionId = 'session-1'
    const calls: string[] = []

    globalThis.window = {
      electronAPI: {
        getSessionMessages: async (id: string) => {
          calls.push(id)
          if (calls.length === 1) {
            return makeSession({ id, messages: [] })
          }
          return makeSession({
            id,
            messages: [msg('m1'), msg('m2', 'assistant')],
          })
        },
      },
    } as unknown as typeof window

    store.set(sessionAtomFamily(sessionId), makeSession({
      id: sessionId,
      messages: [msg('local-1'), msg('local-2', 'assistant')],
    }))

    const firstResult = await store.set(ensureSessionMessagesLoadedAtom, sessionId)
    expect(firstResult?.messages.map((message) => message.id)).toEqual(['local-1', 'local-2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(false)

    const secondResult = await store.set(forceSessionMessagesReloadAtom, sessionId)
    expect(calls).toEqual([sessionId, sessionId])
    expect(secondResult?.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(store.get(loadedSessionsAtom).has(sessionId)).toBe(true)
  })
})

describe('refreshSessionsMetadataAtom', () => {
  it('preserves messages for already-loaded sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    // Pre-populate: session has messages and is marked loaded
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    // Refresh with metadata-only payload (empty messages, like getSessions returns)
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    // Messages should be preserved from the existing atom
    const session = store.get(sessionAtomFamily('s1'))
    expect(session?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('marks sessions as unloaded when atom was cleared but loadedSessionIds still tracked them', () => {
    const store = createStore()

    // Session was previously loaded, but its atom was cleared (e.g., by remove + re-add)
    // while loadedSessionsAtom still tracks it. The atom value is null.
    store.set(loadedSessionsAtom, new Set(['s1']))
    // sessionAtomFamily('s1') defaults to null — no store.set needed

    // Refresh — s1 is in loadedSessionIds but current atom is null,
    // so shouldPreserveMessages is false. Since it was in loadedSessionIds,
    // it should be removed so lazy-loading re-fetches messages.
    const freshSessions = [makeSession({ id: 's1', messages: [] })]
    store.set(refreshSessionsMetadataAtom, {
      sessions: freshSessions,
      loadedSessionIds: new Set(['s1']),
    })

    expect(store.get(loadedSessionsAtom).has('s1')).toBe(false)
  })

  it('removes stale sessions from all atoms', () => {
    const store = createStore()

    // Initialize with two sessions via initializeSessionsAtom
    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1' }),
      makeSession({ id: 's2' }),
    ])
    expect(store.get(sessionMetaMapAtom).size).toBe(2)
    expect(store.get(sessionIdsAtom)).toContain('s2')

    // Refresh with only s1 — s2 should be removed
    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1' })],
      loadedSessionIds: new Set<string>(),
    })

    expect(store.get(sessionMetaMapAtom).has('s2')).toBe(false)
    expect(store.get(sessionIdsAtom)).not.toContain('s2')
    expect(store.get(sessionAtomFamily('s2'))).toBe(null)
  })

  it('preserves omitted sessions when removeMissing is false', () => {
    const store = createStore()

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', lastMessageAt: 200 }),
      makeSession({ id: 's2', name: 'Second', lastMessageAt: 100 }),
    ])

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', lastMessageAt: 300 })],
      loadedSessionIds: new Set<string>(),
      removeMissing: false,
    })

    expect(result.has('s1')).toBe(true)
    expect(result.has('s2')).toBe(true)
    expect(result.get('s1')?.name).toBe('First refreshed')
    expect(result.get('s2')?.name).toBe('Second')

    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.has('s2')).toBe(true)
    expect(store.get(sessionIdsAtom)).toEqual(['s1', 's2'])
    expect(store.get(sessionAtomFamily('s2'))?.name).toBe('Second')
  })

  it('non-destructive refresh still preserves loaded messages for returned sessions', () => {
    const store = createStore()
    const existingMessages = [msg('m1'), msg('m2', 'assistant')]

    store.set(initializeSessionsAtom, [
      makeSession({ id: 's1', name: 'First', messages: [] }),
      makeSession({ id: 's2', name: 'Second', messages: [] }),
    ])
    store.set(sessionAtomFamily('s1'), makeSession({ id: 's1', name: 'First', messages: existingMessages }))
    store.set(loadedSessionsAtom, new Set(['s1']))

    store.set(refreshSessionsMetadataAtom, {
      sessions: [makeSession({ id: 's1', name: 'First refreshed', messages: [] })],
      loadedSessionIds: new Set(['s1']),
      removeMissing: false,
    })

    expect(store.get(sessionAtomFamily('s1'))?.messages.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(store.get(sessionMetaMapAtom).get('s1')?.name).toBe('First refreshed')
    expect(store.get(sessionMetaMapAtom).get('s2')?.name).toBe('Second')
  })

  it('updates metadata map and returns it', () => {
    const store = createStore()

    const sessions = [
      makeSession({ id: 's1', name: 'First' }),
      makeSession({ id: 's2', name: 'Second' }),
    ]

    const result = store.set(refreshSessionsMetadataAtom, {
      sessions,
      loadedSessionIds: new Set<string>(),
    })

    // Returned map matches store state
    expect(result.size).toBe(2)
    expect(result.get('s1')?.name).toBe('First')
    expect(result.get('s2')?.name).toBe('Second')

    // Store is consistent
    const storeMap = store.get(sessionMetaMapAtom)
    expect(storeMap.size).toBe(2)
    expect(storeMap.get('s1')?.name).toBe('First')

    // IDs are set
    expect(store.get(sessionIdsAtom)).toHaveLength(2)
  })
})
