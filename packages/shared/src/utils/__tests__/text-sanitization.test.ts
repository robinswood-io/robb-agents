import { describe, expect, test } from 'bun:test'
import {
  collapseWhitespace,
  sanitizeMessagePreviewText,
  stripAngleBracketTags,
} from '../text-sanitization.ts'

describe('linear text sanitization', () => {
  test('removes edit blocks, mentions, and markup from previews', () => {
    const input = '  Hello <b>world</b> [skill:commit]\n<edit_request>secret</edit_request> done  '
    expect(sanitizeMessagePreviewText(input)).toBe('Hello world done')
  })

  test('drops an unterminated edit block without scanning repeatedly', () => {
    const input = `visible <edit_request>${'x'.repeat(100_000)}`
    expect(sanitizeMessagePreviewText(input)).toBe('visible')
  })

  test('handles malformed angle markup and Unicode whitespace deterministically', () => {
    expect(stripAngleBracketTags('before<tag>after<unfinished')).toBe('beforeafter')
    expect(collapseWhitespace('a\n\t b\u00a0c')).toBe('a b c')
  })
})
