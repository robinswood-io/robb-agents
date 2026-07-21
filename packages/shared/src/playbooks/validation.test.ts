import { describe, expect, it } from 'bun:test'
import { validatePlaybookManifest } from './validation.ts'

const valid = {
  version: 1,
  slug: 'source-api-diagnostic',
  name: 'Source API diagnostic',
  description: 'Diagnose a source failure before escalation.',
  allowedTools: ['mcp__session__browser_tool'],
  humanGates: ['oauth_or_mfa'],
  proofs: [{ id: 'final-status', description: 'Record the final user-visible state.', required: true }],
}

describe('validatePlaybookManifest', () => {
  it('accepts a versioned manifest with explicit tools and proofs', () => {
    expect(validatePlaybookManifest(valid)).toMatchObject(valid)
  })

  it('rejects undeclared extra fields and empty proof requirements', () => {
    expect(() => validatePlaybookManifest({ ...valid, unbounded: true })).toThrow()
    expect(() => validatePlaybookManifest({ ...valid, proofs: [] })).toThrow()
  })
})
