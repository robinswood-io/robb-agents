import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createManagedSession, SessionManager } from './SessionManager'
import { transitionObjectiveContract } from './objective-contract'

type Managed = ReturnType<typeof createManagedSession>
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const rootPath = mkdtempSync(join(tmpdir(), 'combined-delegation-'))
  roots.push(rootPath)
  const workspace = { id: 'fixture-workspace', slug: 'fixture-workspace', name: 'Fixture', rootPath, createdAt: 1 }
  const parent = createManagedSession({ id: 'root', permissionMode: 'safe' }, workspace)
  parent.isProcessing = true
  parent.processingGeneration = 1
  parent.activeObjective = transitionObjectiveContract({ messageId: 'objective', text: 'Inspect the target files.', nowMs: 1 })
  const host = new SessionManager() as any
  host.sessions.set(parent.id, parent)
  const created: Managed[] = [], sent: string[] = []
  host.persistSession = () => {}
  host.flushSession = async () => {}
  host.sendEvent = () => {}
  host.createSession = async (_id: string, options: any, internal: any) => {
    const child = createManagedSession({ ...options, id: `child-${created.length}`, delegation: internal.delegation }, workspace)
    host.sessions.set(child.id, child); created.push(child); return child
  }
  host.sendMessage = async (id: string, _prompt: string, ...args: unknown[]) => {
    sent.push(id); host.sessions.get(id).isProcessing = true
    ;(args[5] as ((messageId: string) => void) | undefined)?.(`${id}-durable-dispatch`)
  }
  return { parent, host, workspace, created, sent, spawn: (extra: Record<string, unknown> = {}) => host.spawnDelegatedSession(parent, { prompt: 'Inspect the exact target.', ...extra }) }
}

describe('combined delegation retains lifecycle guards', () => {
  it.each(['inactive', 'stop'] as const)('rejects a %s parent before creating a child', async state => {
    const h = fixture()
    if (state === 'inactive') h.parent.isProcessing = false
    else h.parent.stopRequested = true
    await expect(h.spawn()).rejects.toThrow()
    expect(h.created).toHaveLength(0); expect(h.sent).toHaveLength(0)
  })

  it.each(['generation', 'objective', 'decision'] as const)('does not dispatch after %s changes during persistence', async state => {
    const h = fixture()
    h.host.flushSession = async () => {
      if (state === 'generation') { h.parent.processingGeneration++; h.parent.stopRequested = false }
      else if (state === 'objective') h.parent.activeObjective = transitionObjectiveContract({ messageId: 'new-objective', text: 'Inspect a different target.', nowMs: 2 })
      else h.parent.pendingAuthRequestId = 'new-auth'
    }
    await expect(h.spawn()).rejects.toThrow()
    expect(h.sent.filter(id => id.startsWith('child-'))).toHaveLength(0)
    expect(h.created[0]!.delegation?.finishedAt).toBeNumber()
    expect(h.host.automaticAdmissionReservations.size).toBe(0)
    expect(h.host.pendingSpawnRoots.size).toBe(0)
  })

  it('deduplicates the same role but never reuses a worker as a reviewer', async () => {
    const h = fixture()
    const [first, duplicate] = await Promise.all([h.spawn(), h.spawn({ name: 'Cosmetic' })])
    expect(first.sessionId).toBe(duplicate.sessionId); expect(duplicate.reused).toBe(true)
    const review = await h.spawn({ role: 'reviewer', prompt: 'Inspect the exact target /srv/review.' })
    expect(review.sessionId).not.toBe(first.sessionId)
    expect(h.created).toHaveLength(2); expect(h.sent).toHaveLength(2)
    expect(h.created[1]!.delegation?.role).toBe('reviewer')
    expect(h.created[1]!.permissionMode).toBe('safe')
  })

  it.each(['global', 'legacy-family'] as const)('preserves the %s capacity boundary', async scope => {
    const h = fixture()
    for (let i = 0; i < (scope === 'global' ? 7 : 3); i++) {
      const child = createManagedSession({ id: `existing-${i}`, ...(scope === 'legacy-family' ? { parentSessionId: h.parent.id } : {}) }, h.workspace)
      child.isProcessing = true; h.host.sessions.set(child.id, child)
    }
    await expect(h.spawn()).rejects.toThrow(scope === 'global' ? 'global_capacity' : 'root_capacity')
    expect(h.created).toHaveLength(0); expect(h.sent).toHaveLength(0)
  })

  it('refuses a missing attachment without creating an incomplete child', async () => {
    const h = fixture()
    await expect(h.spawn({ attachments: [{ path: join(h.workspace.rootPath, 'missing.pdf') }] })).rejects.toThrow()
    expect(h.created).toHaveLength(0); expect(h.sent).toHaveLength(0)
  })
})
