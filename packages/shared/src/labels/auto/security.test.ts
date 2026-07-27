import { describe, expect, test } from 'bun:test'
import { normalizeValue } from './normalize.ts'
import { validateAutoLabelRule } from './validation.ts'

function patternFromCharacterCodes(codes: readonly number[]): string {
  return codes.map(code => String.fromCharCode(code)).join('')
}

describe('auto-label security regressions', () => {
  test('rejects nested quantifiers without evaluating the candidate pattern', () => {
    expect(validateAutoLabelRule(patternFromCharacterCodes([40, 97, 43, 41, 43, 36])).valid).toBe(false)
    expect(validateAutoLabelRule(patternFromCharacterCodes([40, 91, 97, 45, 122, 93, 43, 41, 123, 50, 44, 52, 125])).valid).toBe(false)
    expect(validateAutoLabelRule('(safe)-([0-9]+)').valid).toBe(true)
  })

  test('recognizes named captures and ignores escaped parentheses', () => {
    expect(validateAutoLabelRule('(?<name>[a-z]+)').warnings).toEqual([])
    expect(validateAutoLabelRule('\\(literal\\)').warnings).toHaveLength(1)
  })

  test('normalizes numeric suffixes without an ambiguous numeric regexp', () => {
    expect(normalizeValue('1.5M', 'number')).toBe('1500000')
    expect(normalizeValue('-2k', 'number')).toBe('-2000')
    expect(normalizeValue('not-a-numberB', 'number')).toBe('not-a-numberB')
  })
})
