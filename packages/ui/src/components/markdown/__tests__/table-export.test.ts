import { describe, expect, test } from 'bun:test'
import { tableToMarkdown } from '../table-export'

describe('tableToMarkdown', () => {
  test('escapes existing backslashes before markdown separators', () => {
    const markdown = tableToMarkdown(
      [{ key: 'value', label: 'Value' }],
      [{ value: String.raw`folder\|name` }],
    )

    expect(markdown).toContain(String.raw`folder\\\|name`)
  })
})
