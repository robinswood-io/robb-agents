import { describe, expect, it } from 'bun:test'
import { cliMessageText, isWebhookHistoryEntry, requireListResponse } from './rpc-shapes.ts'

describe('CLI response boundaries', () => {
  it('refuses a malformed list response instead of treating it as an empty configuration', () => {
    for (const value of [null, undefined, {}, 'not a list']) expect(() => requireListResponse(value)).toThrow('Expected a list')
    expect(requireListResponse([])).toEqual([])
  })
  it('extracts text from valid messages while ignoring malformed or non-text blocks', () => {
    expect(cliMessageText({ content: 'hello' })).toBe('hello')
    expect(cliMessageText({ content: [{ type: 'text', text: 'one' }, null,
      { type: 'image', data: 'fixture' }, { type: 'text', text: 42 }, { type: 'text', text: 'two' }] })).toBe('one two')
    for (const value of [null, 'text', { content: 42 }]) expect(cliMessageText(value)).toBe('')
  })
  it('accepts webhook history only with the fields used by the validation check', () => {
    expect(isWebhookHistoryEntry({ ok: false, ts: 123, webhook: { method: 'POST', url: 'http://fixture.invalid' } })).toBe(true)
    for (const value of [{}, { ok: false, ts: '123', webhook: { method: 'POST' } },
      { ok: false, ts: 123, webhook: 'invalid' }, { ok: false, ts: 123, webhook: { method: 'POST', url: 4 } }]) {
      expect(isWebhookHistoryEntry(value)).toBe(false)
    }
  })
})
