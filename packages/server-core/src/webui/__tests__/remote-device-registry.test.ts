import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteDeviceRegistry } from '../remote-device-registry'

const roots: string[] = []

function registryPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'remote-device-registry-'))
  roots.push(root)
  return join(root, 'devices.json')
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('RemoteDeviceRegistry', () => {
  it('persists scoped devices and revokes their generation immediately', () => {
    const filePath = registryPath()
    const now = new Date('2026-07-30T10:00:00.000Z')
    const registry = new RemoteDeviceRegistry({ filePath, now: () => now })
    registry.register({
      id: 'phone-1',
      name: 'Phone',
      allowedWorkspaceIds: ['workspace-1'],
      expiresAt: '2026-08-01T10:00:00.000Z',
      authorizationGeneration: 42,
    })

    const reloaded = new RemoteDeviceRegistry({ filePath, now: () => now })
    expect(reloaded.authorize('phone-1', 42)?.allowedWorkspaceIds).toEqual(['workspace-1'])
    expect(reloaded.revoke('phone-1')).toBe(true)
    expect(reloaded.authorize('phone-1', 42)).toBeNull()
  })

  it('keeps multiple paired devices independently authorized and revocable', () => {
    const now = new Date('2026-08-19T10:00:00.000Z')
    const registry = new RemoteDeviceRegistry({ now: () => now })
    registry.register({
      id: 'phone-1',
      name: 'Phone',
      allowedWorkspaceIds: ['workspace-1'],
      expiresAt: '2026-08-26T10:00:00.000Z',
      authorizationGeneration: 10,
    })
    registry.register({
      id: 'tablet-1',
      name: 'Tablet',
      allowedWorkspaceIds: ['workspace-1', 'workspace-2'],
      expiresAt: '2026-08-26T10:00:00.000Z',
      authorizationGeneration: 20,
    })

    expect(registry.list().map(({ id }) => id)).toEqual(['phone-1', 'tablet-1'])
    expect(registry.authorize('phone-1', 10)).not.toBeNull()
    expect(registry.authorize('tablet-1', 20)).not.toBeNull()

    expect(registry.revoke('phone-1')).toBe(true)
    expect(registry.authorize('phone-1', 10)).toBeNull()
    expect(registry.authorize('tablet-1', 20)?.allowedWorkspaceIds).toEqual([
      'workspace-1',
      'workspace-2',
    ])
  })

  it('fails closed when its durable document is corrupt', () => {
    const filePath = registryPath()
    writeFileSync(filePath, '{invalid json', 'utf8')
    const registry = new RemoteDeviceRegistry({ filePath })

    expect(registry.authorize('phone-1', 1)).toBeNull()
    expect(() => registry.list()).toThrow('unreadable')
  })

  it('rejects malformed expiry dates and empty workspace scopes', () => {
    const registry = new RemoteDeviceRegistry()
    expect(() => registry.register({
      id: 'phone-1',
      name: 'Phone',
      allowedWorkspaceIds: [],
      expiresAt: 'not-a-date',
      authorizationGeneration: 1,
    })).toThrow('Invalid Remote device registration')
  })
})
