import { describe, expect, it } from 'bun:test'
import { BUILTIN_PLAYBOOKS, getBuiltinPlaybook } from './builtins.ts'
import { formatPlaybookPrompt } from './prompt.ts'
import { validatePlaybookManifest } from './validation.ts'

describe('built-in operational playbooks', () => {
  it('ships validated, unique playbooks with required proof', () => {
    const slugs = new Set<string>()
    for (const playbook of BUILTIN_PLAYBOOKS) {
      expect(validatePlaybookManifest(playbook.manifest)).toEqual(playbook.manifest)
      expect(slugs.has(playbook.manifest.slug)).toBeFalse()
      slugs.add(playbook.manifest.slug)
      expect(playbook.manifest.proofs.some(proof => proof.required)).toBeTrue()
    }
  })

  it('formats an explicit bounded execution contract', () => {
    const playbook = getBuiltinPlaybook('source-api-diagnostic')!
    const prompt = formatPlaybookPrompt(playbook)
    expect(prompt).toContain('<robb_playbook')
    expect(prompt).toContain('Allowed tools: browser_tool, source_test')
    expect(prompt).toContain('Human-only gates: oauth_or_mfa, credential_required')
  })
})
