import { describe, expect, test } from 'bun:test'
import { resolveContextTokenEstimate } from './context-token-estimate'

describe('resolveContextTokenEstimate', () => {
  test('prefers positive provider telemetry', () => {
    expect(resolveContextTokenEstimate(42_000, [{ content: 'x'.repeat(800_000) }])).toBe(42_000)
  })

  test('estimates legacy context from messages and tool results', () => {
    expect(resolveContextTokenEstimate(0, [
      { content: 'a'.repeat(8_000), toolResult: 'b'.repeat(72_000) },
    ])).toBe(20_000)
  })

  test('bounds pathological legacy transcripts', () => {
    expect(resolveContextTokenEstimate(undefined, [
      { toolResult: 'x'.repeat(4_100_000) },
    ])).toBe(1_000_000)
  })
})
