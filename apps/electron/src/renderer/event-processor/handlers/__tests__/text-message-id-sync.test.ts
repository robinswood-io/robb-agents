import { describe, expect, it } from 'bun:test'
import { handleTextComplete } from '../text'
import type { SessionState, TextCompleteEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

describe('handleTextComplete messageId synchronization', () => {
  it('overwrites existing streaming message id with authoritative messageId', () => {
    const state = makeState([
      {
        id: 'msg-local-temp-1',
        role: 'assistant',
        content: 'partial',
        isStreaming: true,
        isPending: true,
        turnId: 'turn-1',
        timestamp: 100,
      },
    ])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'final response',
      turnId: 'turn-1',
      messageId: 'msg-main-1',
      timestamp: 200,
    }

    const next = handleTextComplete(state, event)
    const msg = next.session.messages[0] as any

    expect(msg.id).toBe('msg-main-1')
    expect(msg.content).toBe('final response')
    expect(msg.isStreaming).toBe(false)
    expect(msg.isPending).toBe(false)
    expect(msg.timestamp).toBe(200)
  })

  it('uses authoritative messageId when creating message in race path', () => {
    const state = makeState([])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'created from complete',
      turnId: 'turn-race',
      messageId: 'msg-main-race',
      timestamp: 300,
    }

    const next = handleTextComplete(state, event)
    expect(next.session.messages).toHaveLength(1)
    expect((next.session.messages[0] as any).id).toBe('msg-main-race')
  })

  it('preserves routing metadata from main process', () => {
    const state = makeState([])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'routed response',
      turnId: 'turn-routed',
      messageId: 'msg-routed',
      routingMeta: {
        connectionSlug: 'premium-complex',
        providerType: 'pi_compat',
        model: 'openrouter/anthropic/claude-sonnet-4',
        reason: 'router',
        sensitivity: 'confidential',
        policyRuleIds: ['confidential-local-or-sovereign'],
      },
    }

    const next = handleTextComplete(state, event)
    expect((next.session.messages[0] as any).routingMeta).toEqual(event.routingMeta)
  })

  it('keeps backward compatibility when messageId is missing', () => {
    const state = makeState([])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'legacy payload',
      turnId: 'turn-legacy',
      timestamp: 400,
    }

    const next = handleTextComplete(state, event)
    const id = (next.session.messages[0] as any).id as string

    expect(id.startsWith('msg-')).toBe(true)
    expect(id).not.toBe('')
  })

  it('reclassifies the same authoritative final message as intermediate in place', () => {
    const state = makeState([{
      id: 'msg-host-1',
      role: 'assistant',
      content: 'Premature final response',
      isStreaming: false,
      isPending: false,
      isIntermediate: false,
      turnId: 'turn-original',
      timestamp: 500,
    }])
    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'Premature final response',
      turnId: 'turn-reclassified',
      messageId: 'msg-host-1',
      isIntermediate: true,
      timestamp: 500,
    }

    const next = handleTextComplete(state, event)
    expect(next.session.messages).toHaveLength(1)
    expect(next.session.messages[0]).toMatchObject({
      id: 'msg-host-1',
      isIntermediate: true,
      isStreaming: false,
      isPending: false,
      turnId: 'turn-reclassified',
    })
  })

  it('is idempotent when the same completed intermediate event is delivered twice', () => {
    const state = makeState([])
    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'Continue automatically.',
      turnId: 'turn-continue',
      messageId: 'msg-continue-1',
      isIntermediate: true,
      timestamp: 600,
    }

    const once = handleTextComplete(state, event)
    const twice = handleTextComplete(once, event)
    expect(twice.session.messages).toHaveLength(1)
    expect(twice.session.messages[0]).toMatchObject({
      id: 'msg-continue-1',
      content: 'Continue automatically.',
      isIntermediate: true,
    })
  })
})
