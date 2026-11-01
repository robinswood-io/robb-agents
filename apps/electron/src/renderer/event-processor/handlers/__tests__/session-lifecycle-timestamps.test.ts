import { describe, expect, it } from 'bun:test'
import { handleError, handleStatus, handleTypedError } from '../session'
import type { SessionState } from '../../types'

function state(): SessionState {
  return {
    session: { id: 'qa', workspaceId: 'qa', workspaceName: 'QA', lastMessageAt: 1, messages: [], isProcessing: true },
    streaming: null,
  }
}

describe('session lifecycle timestamps and error actions', () => {
  it('displays a plain error with its original timestamp and stops processing', () => {
    const result = handleError(state(), { type: 'error', sessionId: 'qa', error: 'Disconnected', timestamp: 42 })
    expect(result.state.session.messages).toHaveLength(1)
    expect(result.state.session.messages[0]).toMatchObject({ role: 'error', content: 'Disconnected', timestamp: 42 })
    expect(result.state.session.isProcessing).toBe(false)
  })

  it('displays a timestamped status from older transports', () => {
    const event = { type: 'status' as const, sessionId: 'qa', message: 'Working', timestamp: 27 }
    expect(handleStatus(state(), event).state.session.messages.at(-1)?.timestamp).toBe(27)
  })

  it('uses a finite current timestamp when a status timestamp is invalid or absent', () => {
    for (const timestamp of [undefined, 'invalid', Number.NaN, Number.POSITIVE_INFINITY]) {
      const before = Date.now()
      const event = { type: 'status' as const, sessionId: 'qa', message: 'Working', timestamp }
      const result = handleStatus(state(), event)
      const message = result.state.session.messages.at(-1)
      if (!message) throw new Error('Expected the status message to be displayed')
      expect(message.timestamp).toBeGreaterThanOrEqual(before)
      expect(message.timestamp).toBeLessThanOrEqual(Date.now())
    }
  })

  it('retains error actions without inventing optional fields', () => {
    const result = handleTypedError(state(), {
      type: 'typed_error', sessionId: 'qa', timestamp: 19,
      error: { code: 'unknown_error', title: '', message: 'Retry later', canRetry: true,
        actions: [{ key: 'retry', label: 'Retry', action: 'retry' }] },
    })
    const message = result.state.session.messages.at(-1)
    expect(message?.timestamp).toBe(19)
    expect(message?.errorActions).toEqual([{ key: 'retry', label: 'Retry', action: 'retry' }])
    const action = message?.errorActions?.[0]
    if (!action) throw new Error('Expected the retry action')
    expect(Object.hasOwn(action, 'url')).toBe(false)
    expect(Object.hasOwn(action, 'sourceSlug')).toBe(false)
  })
})
