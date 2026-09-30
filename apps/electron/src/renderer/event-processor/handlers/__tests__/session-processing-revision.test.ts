import { describe, expect, it } from 'bun:test'
import type { AgentEvent, SessionState } from '../../types'
import { processEvent } from '../../processor'
import { getSessionProcessingRevision } from '../../../lib/session-processing-state'

function initial(isProcessing = false): SessionState {
  return { session: { id: 'session', workspaceId: 'workspace', workspaceName: 'Workspace', lastMessageAt: 1,
    messages: [], isProcessing }, streaming: null }
}

describe('processing lifecycle revisions', () => {
  it('records explicit stops even when the UI already says idle', () => {
    const stopEvents: AgentEvent[] = [
      { type: 'complete', sessionId: 'session' },
      { type: 'error', sessionId: 'session', error: 'Stopped' },
      { type: 'typed_error', sessionId: 'session', error: { code: 'network_error', title: 'Disconnected', message: 'Stopped', canRetry: true, actions: [] } },
      { type: 'interrupted', sessionId: 'session' },
      { type: 'session_metadata_changed', sessionId: 'session', changes: { isProcessing: false } },
      { type: 'auth_request', sessionId: 'session',
        message: { id: 'auth', role: 'auth-request', content: 'Connect', timestamp: 1 },
        request: { type: 'oauth', requestId: 'auth', sessionId: 'session', sourceSlug: 'source', sourceName: 'Source' } },
    ]
    for (const event of stopEvents) {
      const before = initial()
      const after = processEvent(before, event).state
      expect(after.session.isProcessing).toBe(false)
      expect(getSessionProcessingRevision(after.session)).toBeGreaterThan(getSessionProcessingRevision(before.session))
      expect(getSessionProcessingRevision(before.session)).toBe(0)
      expect(getSessionProcessingRevision(processEvent(after, event).state.session)).toBeGreaterThan(getSessionProcessingRevision(after.session))
    }
  })

  it('records dispatch and host processing acknowledgements independently of a boolean transition', () => {
    const startEvents: AgentEvent[] = [
      { type: 'user_message', sessionId: 'session', status: 'accepted', message: { id: 'user', role: 'user', content: 'Request', timestamp: 1 } },
      { type: 'user_message', sessionId: 'session', status: 'processing', message: { id: 'answer', role: 'user', content: 'Answer', timestamp: 2, hidden: true, internalOrigin: { kind: 'user-input' } } },
      { type: 'session_metadata_changed', sessionId: 'session', changes: { isProcessing: true } },
    ]
    for (const event of startEvents) {
      const before = initial(true)
      const after = processEvent(before, event).state
      expect(after.session.isProcessing).toBe(true)
      expect(getSessionProcessingRevision(after.session)).toBeGreaterThan(getSessionProcessingRevision(before.session))
      expect(getSessionProcessingRevision(before.session)).toBe(0)
    }
  })

  it('preserves a Stop revision through ordinary activity without inferring another start', () => {
    const events: AgentEvent[] = [
      { type: 'tool_start', sessionId: 'session', toolName: 'Read', toolUseId: 'tool' },
      { type: 'tool_result', sessionId: 'session', toolUseId: 'tool', result: 'Done', executed: true },
      { type: 'text_complete', sessionId: 'session', text: 'Recorded report.', isIntermediate: true },
      { type: 'user_input_changed', sessionId: 'session', requests: [] },
      { type: 'user_message', sessionId: 'session', status: 'queued', message: { id: 'queued', role: 'user', content: 'Later', timestamp: 2 } },
      { type: 'session_metadata_changed', sessionId: 'session', changes: { taskNodeCount: 2 } },
      { type: 'objective_changed', sessionId: 'session', activeObjective: null, pendingTurnRecovery: null },
    ]
    let state = processEvent(initial(), { type: 'interrupted', sessionId: 'session' }).state
    const stopRevision = getSessionProcessingRevision(state.session)
    for (const event of events) {
      state = processEvent(state, event).state
      expect(state.session.isProcessing).toBe(false)
      expect(getSessionProcessingRevision(state.session)).toBe(stopRevision)
    }
    const serialized = JSON.parse(JSON.stringify(state.session))
    expect(getSessionProcessingRevision(serialized)).toBe(0)
    expect(serialized.messages).toEqual(state.session.messages)
  })
})
