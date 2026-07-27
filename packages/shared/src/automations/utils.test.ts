import { describe, expect, test } from 'bun:test'
import { expandEnvVars } from './utils.ts'

describe('expandEnvVars', () => {
  test('expands braced and bare variables while preserving unrelated dollars', () => {
    expect(expandEnvVars('$HOME/${NAME}/$MISSING $$', {
      HOME: '/tmp/home',
      NAME: 'agent',
    })).toBe('/tmp/home/agent/ $$')
  })

  test('handles large unterminated variables in linear time', () => {
    const input = `prefix \${${'A'.repeat(100_000)}`
    expect(expandEnvVars(input, {})).toBe(input)
  })
})
