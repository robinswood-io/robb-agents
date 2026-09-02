import { describe, expect, it } from 'bun:test'
import { shouldAutoDeleteEmptySession } from './navigation-empty-session-cleanup'

describe('empty session navigation cleanup', () => {
  it('deletes only an empty session created during the current navigation lifetime', () => {
    const empty = { isProcessing: false }
    expect(shouldAutoDeleteEmptySession(true, empty, undefined)).toBe(true)
    expect(shouldAutoDeleteEmptySession(false, empty, undefined)).toBe(false)
  })

  it('preserves drafts, named sessions, completed sessions, and active sessions', () => {
    expect(shouldAutoDeleteEmptySession(true, {}, 'draft')).toBe(false)
    expect(shouldAutoDeleteEmptySession(true, { name: 'Kept' }, undefined)).toBe(false)
    expect(shouldAutoDeleteEmptySession(true, { lastFinalMessageId: 'msg-1' }, undefined)).toBe(false)
    expect(shouldAutoDeleteEmptySession(true, { isProcessing: true }, undefined)).toBe(false)
  })
})
