import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DurableConnectorPackRegistry } from './durable-pack-registry'
import {
  connectorPackTemplates,
  signConnectorPackManifest,
  type ConnectorPackContractResult,
} from './pack-manifest'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function createRegistryHarness() {
  const directory = mkdtempSync(join(tmpdir(), 'robb-connector-registry-'))
  temporaryDirectories.push(directory)
  const journalPath = join(directory, 'connector-packs.jsonl')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const contract: ConnectorPackContractResult = {
    passed: true,
    failures: [],
    healthLatencyMs: 12,
  }
  const createRegistry = (verifyContract = async () => contract) => new DurableConnectorPackRegistry(
    journalPath,
    (keyId) => keyId === 'publisher-key-1' ? publicKey : null,
    verifyContract,
    () => new Date('2026-07-27T10:00:00.000Z'),
  )
  const signed = signConnectorPackManifest(
    connectorPackTemplates.googleWorkspace,
    'publisher-key-1',
    privateKey,
    '2026-07-27T09:00:00.000Z',
  )
  return { createRegistry, journalPath, privateKey, signed }
}

describe('DurableConnectorPackRegistry', () => {
  test('persists contract-gated installs and propagates revocation between processes', async () => {
    const harness = createRegistryHarness()
    const first = harness.createRegistry()
    const installed = await first.install(harness.signed, {
      actorId: 'security-admin-1',
      reason: 'Approved connector onboarding',
      expectedGeneration: 0,
    })
    expect(installed).toMatchObject({ status: 'active', authorizationGeneration: 1 })

    const second = harness.createRegistry()
    expect(second.assertOperationAllowed(harness.signed.id, 'drive.list')).toMatchObject({
      operationId: 'drive.list',
      authorizationGeneration: 1,
    })

    first.revoke(harness.signed.id, {
      actorId: 'security-admin-2',
      reason: 'Publisher incident response',
      expectedGeneration: 1,
    })
    expect(() => second.assertOperationAllowed(harness.signed.id, 'drive.list')).toThrow('not active')
    expect(second.snapshot()).toMatchObject({
      generation: 2,
      packs: { [harness.signed.id]: { status: 'revoked', authorizationGeneration: 2 } },
    })
  })

  test('refuses installation when the executable connector contract fails', async () => {
    const harness = createRegistryHarness()
    const registry = harness.createRegistry(async () => ({
      passed: false,
      failures: ['driver health check failed'],
      healthLatencyMs: 0,
    }))
    await expect(registry.install(harness.signed, {
      actorId: 'security-admin-1',
      reason: 'Attempted connector onboarding',
    })).rejects.toThrow('driver health check failed')
    expect(registry.snapshot().generation).toBe(0)
  })

  test('rotates to a new signed manifest and invalidates stale runtime hashes', async () => {
    const harness = createRegistryHarness()
    const registry = harness.createRegistry()
    const installed = await registry.install(harness.signed, {
      actorId: 'security-admin-1',
      reason: 'Initial install',
    })
    const rotated = signConnectorPackManifest(
      { ...connectorPackTemplates.googleWorkspace, version: '1.1.0' },
      'publisher-key-1',
      harness.privateKey,
      '2026-07-27T10:30:00.000Z',
    )
    const record = await registry.rotate(rotated, {
      actorId: 'security-admin-1',
      reason: 'Publisher security release',
      expectedGeneration: 1,
    })
    expect(record).toMatchObject({ status: 'active', authorizationGeneration: 2 })
    expect(() => registry.assertOperationAllowed(rotated.id, 'drive.list', installed.manifestHash))
      .toThrow('manifest changed')
  })

  test('fails closed when the append-only journal is tampered with', async () => {
    const harness = createRegistryHarness()
    const registry = harness.createRegistry()
    await registry.install(harness.signed, {
      actorId: 'security-admin-1',
      reason: 'Initial install',
    })
    appendFileSync(harness.journalPath, '{"forged":true}\n', 'utf8')
    expect(() => registry.snapshot()).toThrow()
  })

  test('uses the global registry epoch for every active pack admission', async () => {
    const harness = createRegistryHarness()
    const registry = harness.createRegistry()
    await registry.install(harness.signed, {
      actorId: 'security-admin-1',
      reason: 'Install Google Workspace',
    })
    const microsoft = signConnectorPackManifest(
      connectorPackTemplates.microsoft365,
      'publisher-key-1',
      harness.privateKey,
      '2026-07-27T09:05:00.000Z',
    )
    await registry.install(microsoft, {
      actorId: 'security-admin-1',
      reason: 'Install Microsoft 365',
      expectedGeneration: 1,
    })

    expect(registry.assertOperationAllowed(harness.signed.id, 'drive.list').authorizationGeneration).toBe(2)
    expect(registry.assertOperationAllowed(microsoft.id, 'files.list').authorizationGeneration).toBe(2)
  })
})
