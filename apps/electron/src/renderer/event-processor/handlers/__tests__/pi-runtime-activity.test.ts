import { describe, expect, it } from 'bun:test'
import { PiEventAdapter } from '../../../../../../../packages/shared/src/agent/backend/pi/event-adapter.ts'
import { describeJourneyActivity } from '../../../../../../../packages/ui/src/components/chat/journey-activity.ts'
import { processEvent } from '../../processor'
import type { SessionState } from '../../types'

const preparing = 'Préparation du contexte'
const composing = 'Le modèle élabore la réponse'
function fixture() {
  const adapter = new PiEventAdapter(); adapter.startTurn()
  let state: SessionState = { session: { id: 's', messages: [], isProcessing: true, lastMessageAt: 1 } as never, streaming: null }
  const emitted: any[] = []
  const dispatch = (event: any) => {
    // Same field projection as SessionManager's existing renderer events.
    state = processEvent(state, { ...event, sessionId: 's', delta: event.text, error: event.message,
      statusType: event.type === 'status' && event.message.includes('Compacting') ? 'compacting' : undefined } as never).state
  }
  return { adapter, emitted, dispatch,
    pi(event: any) { const events = [...adapter.adaptEvent(event)]; emitted.push(...events); events.forEach(dispatch); return events },
    state: () => state, activity: () => describeJourneyActivity(state.session.messages, []) }
}

describe('Pi runtime activity through adapter, renderer and journey projection', () => {
  it('shows one generic model phase, hides thinking payloads, clears for tools/text/end and allows the next model phase', () => {
    const f = fixture()
    f.pi({ type: 'message_start', message: { role: 'assistant' } })
    expect(f.activity().title).toBe(composing)
    for (let i = 0; i < 100; i++) f.pi({ type: 'message_update', assistantMessageEvent: {
      type: i === 0 ? 'thinking_start' : 'thinking_delta', delta: 'PRIVATE_REASONING_SENTINEL', contentIndex: 0,
    } })
    expect(f.emitted.filter(e => e.type === 'status')).toHaveLength(1)
    expect(JSON.stringify(f.state())).not.toContain('PRIVATE_REASONING_SENTINEL')
    f.pi({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'read', args: { path: '/tmp/example' } })
    expect(f.state().session.currentStatus).toBeUndefined()
    expect(f.activity().title).not.toBe(composing)
    f.pi({ type: 'tool_execution_end', toolCallId: 'tool', toolName: 'read', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false })
    f.pi({ type: 'message_start', message: { role: 'assistant' } })
    expect(f.activity().title).toBe(composing)
    f.pi({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Le bleu', contentIndex: 0 } })
    expect(f.state().session.currentStatus).toBeUndefined()
    expect(f.activity().title).not.toBe(composing)
    f.pi({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Le bleu' }] } })
    f.pi({ type: 'agent_end', messages: [] })
    expect(f.state().session.messages.some(m => m.role === 'status')).toBe(false)
  })

  it('shows preparation for host compaction, clears on completion/failure, and ignores arbitrary provider status as journey prose', () => {
    const f = fixture()
    f.dispatch({ type: 'status', message: preparing })
    f.dispatch({ type: 'status', message: preparing })
    expect(f.activity().title).toBe(preparing)
    expect(f.state().session.messages.filter(m => m.role === 'status')).toHaveLength(1)
    f.dispatch({ type: 'status', message: '' })
    expect(f.state().session.currentStatus).toBeUndefined()
    expect(f.activity().title).toBeUndefined()
    f.dispatch({ type: 'status', message: 'PRIVATE_PROTOCOL_PAYLOAD' })
    expect(f.activity().title).toBeUndefined()
    f.dispatch({ type: 'status', message: preparing })
    f.dispatch({ type: 'error', message: 'test failure' })
    expect(f.state().session.currentStatus).toBeUndefined()
    expect(f.activity().title).not.toBe(preparing)
  })

  it('maps native Pi compaction status and clears it before the next model/text phase', () => {
    const f = fixture()
    f.pi({ type: 'compaction_start', reason: 'threshold' })
    expect(f.activity().title).toBe(preparing)
    f.pi({ type: 'compaction_end', reason: 'threshold', result: { summary: 'PRIVATE_SUMMARY', firstKeptEntryId: 'x', tokensBefore: 100 } })
    f.pi({ type: 'message_start', message: { role: 'assistant' } })
    expect(f.activity().title).toBe(composing)
    expect(JSON.stringify(f.state())).not.toContain('PRIVATE_SUMMARY')
    f.dispatch({ type: 'interrupted', message: 'Stopped', timestamp: Date.now() })
    expect(f.state().session.currentStatus).toBeUndefined()
    expect(f.activity().title).not.toBe(composing)
  })
  it('resets activity across an interrupted turn and never clears unrelated provider status on text', () => {
    const f = fixture()
    f.pi({ type: 'message_start', message: { role: 'assistant' } })
    f.dispatch({ type: 'interrupted', message: 'Stopped', timestamp: Date.now() })
    f.adapter.startTurn()
    expect(f.pi({ type: 'message_start', message: { role: 'assistant' } })).toEqual([{ type: 'status', message: composing }])
    f.dispatch({ type: 'status', message: 'Unrelated provider status' })
    f.pi({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Answer', contentIndex: 0 } })
    expect(f.state().session.currentStatus?.message).toBe('Unrelated provider status')
    expect(f.activity().title).not.toBe(composing)
  })

})
