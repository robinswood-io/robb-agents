import { afterEach, describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CredentialId, StoredCredential } from '@craft-agent/shared/credentials'
import {
  connectorPackTemplates,
  DurableConnectorPackRegistry,
  signConnectorPackManifest,
  type ConnectorHttpRequest,
} from '@craft-agent/shared/connectors'
import type {
  CapabilityPolicy,
  EgressVaultEntry,
  PrivacyReceipt,
  SignedExecutionProof,
  StructuredEgressPolicy,
} from '@craft-agent/shared/governance'
import { StructuredEgressFirewall, capabilityOperationRequestHash } from '@craft-agent/shared/governance'
import { loadWorkspaceExecutionProofIssuer, type GovernanceCredentialStore } from '../tasks/execution-proof-runtime'
import { createWorkspaceConnectorExecutionRuntime } from './connector-execution-runtime'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class MemoryCredentialStore implements GovernanceCredentialStore {
  readonly entries = new Map<string, StoredCredential>()

  async getOrCreate(id: CredentialId, create: () => StoredCredential): Promise<StoredCredential> {
    const key = JSON.stringify(id)
    const existing = this.entries.get(key)
    if (existing) return existing
    const credential = create()
    this.entries.set(key, credential)
    return credential
  }
}

function policy(): CapabilityPolicy {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    policyVersion: 9,
    authorizationGeneration: 0,
    enabled: true,
    maxRisk: 'W3',
    allowedOperations: ['health.read', 'drive.list', 'drive.update'],
    allowedOrigins: ['https://www.googleapis.com'],
    allowedResourceTypes: ['connector-health', 'file'],
    approvalRequiredFor: ['W2', 'W3'],
    maxRequestAgeMs: 300_000,
    capabilityTtlMs: 60_000,
    approvalTtlMs: 120_000,
  }
}

function egressPolicy(): StructuredEgressPolicy {
  return {
    schemaVersion: 1,
    policyId: 'google-drive-finance-v1',
    allowedOrigins: ['https://www.googleapis.com'],
    purpose: 'Publish an approved reconciliation artifact',
    unmatchedAction: 'drop',
    piiAction: 'pseudonymize',
    rules: [
      { path: 'name', classification: 'business-sensitive', action: 'allow' },
      { path: 'owner.email', classification: 'pii', action: 'pseudonymize' },
      { path: 'pageSize', classification: 'public', action: 'allow' },
      { path: 'includeItemsFromAllDrives', classification: 'public', action: 'allow' },
    ],
  }
}

async function createHarness(withEgressPolicy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'robb-connector-runtime-'))
  temporaryDirectories.push(directory)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const manifest = signConnectorPackManifest(
    connectorPackTemplates.googleWorkspace,
    'publisher-key-1',
    privateKey,
    '2026-07-27T09:00:00.000Z',
  )
  const registry = new DurableConnectorPackRegistry(
    join(directory, 'registry.jsonl'),
    (keyId) => keyId === 'publisher-key-1' ? publicKey : null,
    async () => ({ passed: true, failures: [], healthLatencyMs: 4 }),
    () => new Date('2026-07-27T10:00:00.000Z'),
  )
  await registry.install(manifest, {
    actorId: 'security-admin-1',
    reason: 'Approved Google Workspace pack',
  })
  const credentialStore = new MemoryCredentialStore()
  const requests: ConnectorHttpRequest[] = []
  const proofs: Array<{ sessionId: string; proof: SignedExecutionProof }> = []
  const privacyReceipts: Array<{ sessionId: string; receipt: PrivacyReceipt }> = []
  const vaultEntries: EgressVaultEntry[] = []
  let generated = 0
  const runtime = await createWorkspaceConnectorExecutionRuntime({
    workspaceId: 'workspace-1',
    policy: policy(),
    registry,
    capabilityUseLedgerPath: join(directory, 'capability-uses.jsonl'),
    connectors: [{
      pack: 'googleWorkspace',
      secretReference: 'source_oauth::workspace-1::google-drive',
      secretName: 'google-drive-access-token',
      ...(withEgressPolicy ? {
        egressPolicy: egressPolicy(),
      } : {}),
    }],
    transport: async (request) => {
      requests.push(request)
      return {
        status: 200,
        body: { id: 'file-42', state: 'updated' },
        requestId: 'provider-request-42',
      }
    },
    resolveSecretValue: async () => 'raw-secret-never-exported',
    reconcileMutation: async () => ({
      status: 'confirmed',
      observedAt: '2026-07-27T10:00:01.000Z',
      providerState: { id: 'file-42', state: 'updated' },
    }),
    recordExecutionProof: (record) => proofs.push(record),
    recordPrivacyReceipt: (record) => privacyReceipts.push(record),
    storeEgressVaultEntries: (entries) => vaultEntries.push(...entries),
    credentialStore,
    nowMs: () => Date.parse('2026-07-27T10:00:00.000Z'),
    generateId: () => `generated-${++generated}`,
  })
  return { runtime, registry, credentialStore, requests, proofs, privacyReceipts, vaultEntries }
}

describe('ConnectorExecutionRuntime', () => {
  test('separates authorization from the credentialed transport boundary', async () => {
    const harness = await createHarness()
    const prepared = harness.runtime.prepare({
      pack: 'googleWorkspace',
      sessionId: 'mission:finance-sync:publish',
      operationId: 'drive.update',
      identity: {
        clientId: 'client-1', missionId: 'finance-sync', nodeId: 'publish-correction',
        agentId: 'finance-agent', actorId: 'operator-1',
      },
      autonomy: 'A3',
      resourceType: 'file',
      resourceId: 'file-42',
      payload: { name: 'corrected-report.xlsx' },
      idempotencyKey: 'finance-sync:file-42:wal-v1',
      requestedAt: '2026-07-27T10:00:00.000Z',
    })
    const pending = harness.runtime.authorize(prepared.preparationId)
    expect(pending.status).toBe('approval-required')
    expect(harness.requests).toHaveLength(0)
    if (pending.status !== 'approval-required') throw new Error('Expected approval request')
    expect(harness.runtime.resolveApproval(
      pending.approval.approvalId, 'approved', 'validator-1',
    ).status).toBe('approved')
    expect(harness.runtime.authorize(prepared.preparationId, pending.approval.approvalId).status)
      .toBe('authorized')
    expect(harness.requests).toHaveLength(0)
    expect((await harness.runtime.invokeAuthorized(prepared.preparationId)).status).toBe('executed')
    expect(harness.requests).toHaveLength(1)
  })

  test('executes an approved mutation through the complete secure host chain', async () => {
    const harness = await createHarness()
    const prepared = harness.runtime.prepare({
      pack: 'googleWorkspace',
      sessionId: 'session-1',
      operationId: 'drive.update',
      identity: {
        clientId: 'client-1',
        missionId: 'finance-sync',
        nodeId: 'publish-correction',
        agentId: 'finance-agent',
        actorId: 'operator-1',
      },
      autonomy: 'A3',
      resourceType: 'file',
      resourceId: 'file-42',
      payload: { name: 'corrected-report.xlsx' },
      idempotencyKey: 'finance-sync:file-42:v1',
    })

    const pending = await harness.runtime.execute(prepared.preparationId)
    expect(pending.status).toBe('approval-required')
    if (pending.status !== 'approval-required') throw new Error('Expected approval request')
    expect(harness.runtime.resolveApproval(
      pending.approval.approvalId,
      'approved',
      'validator-1',
    ).status).toBe('approved')

    const result = await harness.runtime.execute(prepared.preparationId, pending.approval.approvalId)
    expect(result.status).toBe('executed')
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]).toMatchObject({
      method: 'PATCH',
      redirect: 'manual',
      security: { blockPrivateAddresses: true },
    })
    expect(harness.requests[0]?.headers.Authorization).toBe('Bearer raw-secret-never-exported')
    expect(harness.proofs).toHaveLength(1)
    expect(harness.proofs[0]?.sessionId).toBe('session-1')
    expect(JSON.stringify(result)).not.toContain('raw-secret-never-exported')
    expect(JSON.stringify(harness.proofs[0])).not.toContain('corrected-report.xlsx')

    const restartedVerifier = await loadWorkspaceExecutionProofIssuer('workspace-1', harness.credentialStore)
    expect(restartedVerifier.verifyForTask(harness.proofs[0]?.proof, {
      workspaceId: 'workspace-1',
      missionId: 'finance-sync',
      nodeId: 'publish-correction',
      idempotencyKey: 'finance-sync:file-42:v1',
    }).allowed).toBe(true)
  })

  test('invalidates a prepared invocation when the connector registry changes', async () => {
    const harness = await createHarness()
    const prepared = harness.runtime.prepare({
      pack: 'googleWorkspace',
      sessionId: 'session-2',
      operationId: 'drive.list',
      identity: {
        clientId: 'client-1',
        missionId: 'finance-sync',
        nodeId: 'collect-files',
        agentId: 'finance-agent',
        actorId: 'operator-1',
      },
      autonomy: 'A1',
      resourceType: 'file',
      payload: { pageSize: 10 },
    })
    harness.registry.revoke(connectorPackTemplates.googleWorkspace.id, {
      actorId: 'security-admin-2',
      reason: 'Emergency connector revocation',
      expectedGeneration: 1,
    })

    expect(await harness.runtime.execute(prepared.preparationId)).toMatchObject({
      status: 'denied',
      code: 'POLICY_VERSION_MISMATCH',
    })
    expect(harness.requests).toHaveLength(0)
  })

  test('executes scalar GET input without an egress policy using the exact canonical query hash', async () => {
    const harness = await createHarness(false)
    const prepared = harness.runtime.prepare({
      pack: 'googleWorkspace', sessionId: 'session-get-no-egress', operationId: 'drive.list',
      identity: {
        clientId: 'client-1', missionId: 'finance-sync', nodeId: 'collect-files',
        agentId: 'finance-agent', actorId: 'operator-1',
      },
      autonomy: 'A1', resourceType: 'file',
      payload: { pageSize: 25, includeItemsFromAllDrives: true },
    })
    const expectedQuery = { pageSize: '25', includeItemsFromAllDrives: 'true' }
    expect(prepared.request.payload).toEqual(expectedQuery)
    const authorized = harness.runtime.authorize(prepared.preparationId)
    expect(authorized).toMatchObject({
      status: 'authorized',
      requestHash: capabilityOperationRequestHash(prepared.request),
    })
    if (authorized.status !== 'authorized') throw new Error('Expected GET authorization')
    expect((await harness.runtime.invokeAuthorized(prepared.preparationId)).status).toBe('executed')
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]?.body).toBeUndefined()
    expect(Object.fromEntries(new URL(harness.requests[0]!.url).searchParams.entries())).toEqual(expectedQuery)
    expect(harness.privacyReceipts).toHaveLength(0)
  })

  test('releases only the inspected payload and durably emits its privacy receipt at transport', async () => {
    const harness = await createHarness(true)
    const prepared = harness.runtime.prepare({
      pack: 'googleWorkspace', sessionId: 'session-egress', operationId: 'drive.update',
      identity: {
        clientId: 'client-1', missionId: 'finance-sync', nodeId: 'publish-correction',
        agentId: 'finance-agent', actorId: 'operator-1',
      },
      autonomy: 'A3', resourceType: 'file', resourceId: 'file-42',
      payload: {
        name: 'corrected-report.xlsx',
        internalComment: 'local only',
        owner: { email: 'alice@example.fr' },
      },
      idempotencyKey: 'finance-sync:file-42:privacy-v1',
    })
    const pending = await harness.runtime.execute(prepared.preparationId)
    if (pending.status !== 'approval-required') throw new Error('Expected approval request')
    harness.runtime.resolveApproval(pending.approval.approvalId, 'approved', 'validator-1')
    expect((await harness.runtime.execute(prepared.preparationId, pending.approval.approvalId)).status)
      .toBe('executed')
    expect(harness.requests[0]?.body).toEqual({
      name: 'corrected-report.xlsx',
      owner: { email: expect.stringMatching(/^psn_/) },
    })
    expect(harness.privacyReceipts).toHaveLength(1)
    expect(harness.privacyReceipts[0]?.sessionId).toBe('session-egress')
    expect(JSON.stringify(harness.privacyReceipts[0])).not.toContain('alice@example.fr')
    expect(harness.vaultEntries).toMatchObject([{ path: 'owner.email', originalValue: 'alice@example.fr' }])
  })

  test('blocks a secret canary during preparation, before approval, lease, or transport', async () => {
    const harness = await createHarness(true)
    expect(() => harness.runtime.prepare({
      pack: 'googleWorkspace', sessionId: 'session-secret', operationId: 'drive.update',
      identity: {
        clientId: 'client-1', missionId: 'finance-sync', nodeId: 'publish-correction',
        agentId: 'finance-agent', actorId: 'operator-1',
      },
      autonomy: 'A3', resourceType: 'file', resourceId: 'file-42',
      payload: { name: 'report.xlsx', api_token: 'sk-proj-abcdefghijklmnop' },
      idempotencyKey: 'finance-sync:file-42:secret-v1',
    })).toThrow('secret canary')
    expect(harness.requests).toHaveLength(0)
    expect(harness.privacyReceipts).toHaveLength(0)
  })

  test('canonicalizes GET query scalars before hashing and receipts exactly what reaches the URL', async () => {
    const harness = await createHarness(true)
    const prepared = harness.runtime.prepare({
      pack: 'googleWorkspace', sessionId: 'session-get-egress', operationId: 'drive.list',
      identity: {
        clientId: 'client-1', missionId: 'finance-sync', nodeId: 'collect-files',
        agentId: 'finance-agent', actorId: 'operator-1',
      },
      autonomy: 'A1', resourceType: 'file',
      payload: { pageSize: 25, includeItemsFromAllDrives: true },
    })
    const expectedQuery = { pageSize: '25', includeItemsFromAllDrives: 'true' }
    expect(prepared.request.payload).toEqual(expectedQuery)
    expect((await harness.runtime.execute(prepared.preparationId)).status).toBe('executed')
    expect(harness.requests).toHaveLength(1)
    expect(harness.requests[0]?.body).toBeUndefined()
    const sentUrl = new URL(harness.requests[0]!.url)
    expect(Object.fromEntries(sentUrl.searchParams.entries())).toEqual(expectedQuery)

    expect(harness.privacyReceipts).toHaveLength(1)
    const storedKey = harness.credentialStore.entries.get(JSON.stringify({
      type: 'governance_signing_key',
      workspaceId: 'workspace-1',
      name: 'structured-egress-v1',
    }))
    if (!storedKey) throw new Error('Missing structured egress test key')
    const verifier = new StructuredEgressFirewall({ signingKey: Buffer.from(storedKey.value, 'base64url') })
    const expected = verifier.prepare({
      payload: prepared.request.payload,
      destinationOrigin: sentUrl.origin,
      policy: egressPolicy(),
    })
    expect(harness.privacyReceipts[0]?.receipt.transmittedPayloadHash).toBe(expected.transmittedPayloadHash)
    expect(harness.privacyReceipts[0]?.receipt.fields.map(({ path }) => path).sort())
      .toEqual(['includeItemsFromAllDrives', 'pageSize'])
  })

  test('fails closed before authorization or transport when GET payload structure has no exact query representation', async () => {
    const harness = await createHarness(true)
    expect(() => harness.runtime.prepare({
      pack: 'googleWorkspace', sessionId: 'session-get-nested', operationId: 'drive.list',
      identity: {
        clientId: 'client-1', missionId: 'finance-sync', nodeId: 'collect-files',
        agentId: 'finance-agent', actorId: 'operator-1',
      },
      autonomy: 'A1', resourceType: 'file',
      payload: { pageSize: [25], filter: { owner: 'finance' }, nullable: null },
    })).toThrow('not representable as one scalar value')
    expect(harness.requests).toHaveLength(0)
    expect(harness.privacyReceipts).toHaveLength(0)
  })
})
