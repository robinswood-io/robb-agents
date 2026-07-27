import { afterEach, describe, expect, it } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DurableKillSwitchRegistry } from './kill-switch-registry.ts'

const roots: string[] = []

function journalPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'kill-switch-registry-'))
  roots.push(root)
  return join(root, 'governance', 'kill-switches.jsonl')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('DurableKillSwitchRegistry', () => {
  it('persists scopes and makes changes visible across registry instances', () => {
    const path = journalPath()
    const first = new DurableKillSwitchRegistry(path, () => new Date('2026-07-27T10:00:00.000Z'))
    const second = new DurableKillSwitchRegistry(path)

    first.set({
      scope: 'mission',
      id: 'invoice-reconciliation',
      active: true,
      reason: 'Provider receipts are inconsistent',
      actorId: 'operator-1',
      expectedGeneration: 0,
    })
    expect(second.snapshot()).toMatchObject({
      generation: 1,
      missionIds: ['invoice-reconciliation'],
      updatedBy: 'operator-1',
    })

    second.set({
      scope: 'workspace',
      id: 'client-a',
      active: true,
      reason: 'Client requested an immediate pause',
      actorId: 'owner-1',
      expectedGeneration: 1,
    })
    expect(first.taskSnapshot()).toEqual({
      global: false,
      workspaceIds: ['client-a'],
      missionIds: ['invoice-reconciliation'],
    })
  })

  it('rejects stale updates and invalid scope bindings', () => {
    const registry = new DurableKillSwitchRegistry(journalPath())
    expect(() => registry.set({
      scope: 'global',
      id: 'not-allowed',
      active: true,
      reason: 'test',
      actorId: 'owner',
    })).toThrow('cannot have an identifier')

    registry.set({
      scope: 'global',
      active: true,
      reason: 'Emergency stop',
      actorId: 'owner',
      expectedGeneration: 0,
    })
    expect(() => registry.set({
      scope: 'global',
      active: false,
      reason: 'Stale operator view',
      actorId: 'owner',
      expectedGeneration: 0,
    })).toThrow('generation conflict')
  })

  it('fails closed when the append-only audit chain is tampered with', () => {
    const path = journalPath()
    const registry = new DurableKillSwitchRegistry(path)
    registry.set({
      scope: 'connector',
      id: 'microsoft365',
      active: true,
      reason: 'Credential incident',
      actorId: 'security-owner',
    })

    const original = readFileSync(path, 'utf8')
    writeFileSync(path, original.replace('Credential incident', 'Credential incident cleared'), 'utf8')
    appendFileSync(path, '\n', 'utf8')

    expect(() => registry.snapshot()).toThrow('journal hash is invalid')
  })
})
