import { describe, expect, it } from 'bun:test'
import { createEmptySession } from '../helpers'
import { isUserFacingSession } from '../../utils/session-visibility'

describe('event placeholder visibility', () => {
  it('keeps an event-first session internal until authoritative metadata arrives', () => {
    const placeholder = createEmptySession('event-first', 'workspace')

    expect(placeholder.hidden).toBe(true)
    expect(isUserFacingSession(placeholder)).toBe(false)
  })
})
