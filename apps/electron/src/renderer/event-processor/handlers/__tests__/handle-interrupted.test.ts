import { describe, expect, it } from 'bun:test'
import { handleInterrupted } from '../session'
import type { SessionState, InterruptedEvent } from '../../types'

function makeState(messages: SessionState['session']['messages']): SessionState {
  return {
    session: {
      workspaceId: 'qa-workspace',
      workspaceName: 'QA workspace',
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
      isProcessing: true,
    },
    streaming: null,
  }
}

describe('handleInterrupted (#616)', () => {
  describe('user-initiated stop (event.message present)', () => {
    it('removes queued bubbles AND emits restore_input', () => {
      const state = makeState([
        { timestamp: 0, id: 'msg-1', role: 'user', content: 'first' },
        { timestamp: 0, id: 'msg-2', role: 'user', content: 'queued one', isQueued: true },
        { timestamp: 0, id: 'msg-3', role: 'user', content: 'queued two', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 },
        queuedMessages: ['queued one', 'queued two'],
      }

      const next = handleInterrupted(state, event)

      // queued bubbles dropped
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).not.toContain('msg-2')
      expect(ids).not.toContain('msg-3')
      // info message appended
      expect(ids).toContain('info-1')
      // restore_input effect emitted with combined text
      expect(next.effects).toEqual([
        { type: 'restore_input', text: 'queued one\n\nqueued two' },
      ])
      // isProcessing cleared
      expect(next.state.session.isProcessing).toBe(false)
    })

    it('still works when no queued bubbles exist', () => {
      const state = makeState([
        { timestamp: 0, id: 'msg-1', role: 'user', content: 'first' },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        message: { id: 'info-1', role: 'info', content: 'Response interrupted', timestamp: 0 },
      }

      const next = handleInterrupted(state, event)
      expect(next.effects).toEqual([])
      expect(next.state.session.messages.map(m => m.id)).toContain('info-1')
    })
  })

  describe('silent redirect (event.message absent)', () => {
    it('KEEPS queued bubbles in chat and does NOT emit restore_input (#616 fix)', () => {
      const state = makeState([
        { timestamp: 0, id: 'msg-1', role: 'user', content: 'first' },
        { timestamp: 0, id: 'msg-2', role: 'user', content: 'queued during run', isQueued: true },
      ])

      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
        // no message field — silent redirect
        queuedMessages: ['queued during run'],
      }

      const next = handleInterrupted(state, event)

      // queued bubble must remain so the user sees it
      const ids = next.state.session.messages.map(m => m.id)
      expect(ids).toContain('msg-2')
      // no info bubble appended
      expect(ids).not.toContain('info-1')
      // critically: no restore_input effect — backend will auto-replay
      expect(next.effects).toEqual([])
      // isProcessing still gets cleared
      expect(next.state.session.isProcessing).toBe(false)
    })

    it('marks running tools as interrupted regardless of redirect type', () => {
      const state = makeState([
        { timestamp: 0, content: '', id: 'tool-1', role: 'tool', toolStatus: 'executing', toolResult: undefined },
      ])
      const event: InterruptedEvent = {
        type: 'interrupted',
        sessionId: 'session-1',
      }

      const next = handleInterrupted(state, event)
      const tool = next.state.session.messages[0]!
      expect(tool.toolStatus).toBe('error')
      expect(tool.toolResult).toBe('Interrupted')
      expect(tool.isError).toBe(true)
    })
  })

  it('always strips transient status messages', () => {
    const state = makeState([
      { timestamp: 0, id: 'msg-1', role: 'user', content: 'hi' },
      { timestamp: 0, id: 'status-1', role: 'status', content: 'thinking…' },
    ])
    const event: InterruptedEvent = {
      type: 'interrupted',
      sessionId: 'session-1',
    }

    const next = handleInterrupted(state, event)
    const ids = next.state.session.messages.map(m => m.id)
    expect(ids).not.toContain('status-1')
    expect(ids).toContain('msg-1')
  })
})
