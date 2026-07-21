import { describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { invalidatePlaybooksCache, loadWorkspacePlaybook, loadWorkspacePlaybooks } from './storage.ts'

const manifest = `---
version: 1
slug: source-api-diagnostic
name: Source API diagnostic
description: Diagnose safely
allowedTools:
  - mcp__session__browser_tool
proofs:
  - id: final-status
    description: Verify the visible result
    required: true
---
Use the browser only after a source failure.`

describe('workspace playbook storage', () => {
  it('loads valid manifests and ignores invalid files', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-playbooks-'))
    const dir = join(root, 'playbooks')
    mkdirSync(dir)
    writeFileSync(join(dir, 'diagnostic.md'), manifest)
    writeFileSync(join(dir, 'invalid.md'), '---\nslug: invalid\n---\nmissing contract')

    const playbooks = loadWorkspacePlaybooks(root)
    expect(playbooks).toHaveLength(1)
    expect(playbooks[0]?.manifest.slug).toBe('source-api-diagnostic')
    expect(loadWorkspacePlaybook(root, 'source-api-diagnostic')?.instructions).toContain('browser')
  })

  it('refreshes after explicit cache invalidation', () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-playbooks-'))
    const dir = join(root, 'playbooks')
    mkdirSync(dir)
    expect(loadWorkspacePlaybooks(root)).toEqual([])
    writeFileSync(join(dir, 'diagnostic.md'), manifest)
    expect(loadWorkspacePlaybooks(root)).toEqual([])
    invalidatePlaybooksCache(root)
    expect(loadWorkspacePlaybooks(root)).toHaveLength(1)
  })
})
