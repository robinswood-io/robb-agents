import { describe, expect, it } from 'bun:test'
import { hasSingleMailboxShape, trimTrailingCharacters } from '../string-boundaries.ts'

describe('external string boundaries', () => {
  it('trims only the suffix and preserves punctuation inside a locator', () => {
    expect(trimTrailingCharacters('/srv/report.v2,,..', '.,')).toBe('/srv/report.v2')
    expect(trimTrailingCharacters('https://example.test/page);.', '),.;')).toBe('https://example.test/page')
    expect(trimTrailingCharacters('.'.repeat(100_000), '.,')).toBe('')
  })

  it('accepts a single mailbox while rejecting absent domains, extra recipients and repeated punctuation', () => {
    expect(hasSingleMailboxShape('reader@sub.example.test')).toBe(true)
    for (const value of ['reader@.test', 'reader@example.', 'reader example@test.test', 'reader@example.test@other.test', 'reader@' + '.'.repeat(100_000)]) {
      expect(hasSingleMailboxShape(value)).toBe(false)
    }
  })
})
