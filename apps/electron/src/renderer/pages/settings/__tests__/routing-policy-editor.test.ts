import { describe, expect, it } from 'bun:test'
import { parseRoutingPolicyText } from '../routing-policy-editor'

describe('parseRoutingPolicyText', () => {
  it('treats empty text as clearing the workspace policy', () => {
    const result = parseRoutingPolicyText('  \n ', ['local-fast'])
    expect(result).toEqual({ policy: undefined, errors: [], warnings: [] })
  })

  it('returns JSON parse errors without throwing', () => {
    const result = parseRoutingPolicyText('{ invalid', ['local-fast'])
    expect(result.policy).toBeUndefined()
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.warnings).toEqual([])
  })

  it('validates routingPolicy schema and duplicate rule ids', () => {
    const result = parseRoutingPolicyText(JSON.stringify({
      version: 1,
      rules: [
        { id: 'same', when: { sensitivity: ['internal'] }, allowConnections: ['local-fast'] },
        { id: 'same', when: { sensitivity: ['public'] }, allowConnections: ['local-fast'] },
      ],
    }), ['local-fast'])

    expect(result.errors).toContain('Duplicate routingPolicy rule id: same')
  })

  it('passes known connection slugs through for policy warnings', () => {
    const result = parseRoutingPolicyText(JSON.stringify({
      version: 1,
      rules: [
        { id: 'internal', when: { sensitivity: ['internal'] }, allowConnectionSlugs: ['unknown-connection'] },
      ],
    }), ['local-fast'])

    expect(result.errors).toEqual([])
    expect(result.warnings).toContain("routingPolicy references unknown connection 'unknown-connection' in rules.internal.allowConnectionSlugs")
  })
})
