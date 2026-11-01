import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managers, originalFetch, registerProjectSession, roots } from "./testing/session-persistence-root-identity-fixture.ts";

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(managers.splice(0).map(manager => manager.cleanup()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('managed session physical persistence root', () => {
  it('loads a session-bound playbook only from the captured root after alias retargeting', () => {
    if (process.platform === 'win32') return
    const { fixture, managed, runtime } = registerProjectSession('playbook')
    const slug = 'captured-root-playbook'
    const playbook = (instructions: string) => `---
version: 1
slug: ${slug}
name: Captured root playbook
description: Verify physical workspace ownership
allowedTools:
  - Read
proofs:
  - id: physical-root
    description: Verify the captured root
    required: true
---
${instructions}`
    mkdirSync(join(fixture.rootA, 'playbooks'))
    mkdirSync(join(fixture.rootB, 'playbooks'))
    writeFileSync(join(fixture.rootA, 'playbooks', `${slug}.md`), playbook('Instructions from captured workspace A.'))
    writeFileSync(join(fixture.rootB, 'playbooks', `${slug}.md`), playbook('Instructions from replacement workspace B.'))
    managed.playbookSlug = slug

    const selected = runtime.loadSessionPlaybook(managed)

    expect(selected?.instructions).toContain('captured workspace A')
    expect(selected?.instructions).not.toContain('replacement workspace B')
  })
});
