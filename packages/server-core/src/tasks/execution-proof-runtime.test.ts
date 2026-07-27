import { describe, expect, it } from 'bun:test'
import type { CredentialId, StoredCredential } from '@craft-agent/shared/credentials'
import { operationValueHash } from '@craft-agent/shared/governance'
import {
  loadWorkspaceExecutionProofIssuer,
  loadWorkspaceGovernanceSigningKey,
  type GovernanceCredentialStore,
} from './execution-proof-runtime'

class MemoryCredentialStore implements GovernanceCredentialStore {
  readonly entries = new Map<string, StoredCredential>()
  createCount = 0

  async getOrCreate(id: CredentialId, create: () => StoredCredential): Promise<StoredCredential> {
    const key = JSON.stringify(id)
    const existing = this.entries.get(key)
    if (existing) return existing
    this.createCount += 1
    const credential = create()
    this.entries.set(key, credential)
    return credential
  }
}

describe('workspace execution proof runtime', () => {
  it('reuses one durable workspace key so proofs remain valid after a runtime restart', async () => {
    const store = new MemoryCredentialStore()
    const first = await loadWorkspaceExecutionProofIssuer('workspace-1', store)
    const proof = first.issue({
      clientId: 'client-1',
      workspaceId: 'workspace-1',
      missionId: 'mission-1',
      nodeId: 'publish',
      agentId: 'agent-1',
      connectorId: 'connector-1',
      operationId: 'records.upsert',
      idempotencyKey: 'idem-1',
      payloadHash: operationValueHash({ input: 1 }),
      resultHash: operationValueHash({ output: 1 }),
      providerRequestId: 'provider-request-1',
      policyVersion: 1,
      authorizationGeneration: 1,
      connectorManifestHash: operationValueHash({ manifest: 1 }),
      reconciliation: {
        status: 'confirmed',
        observedAt: '2026-07-27T10:00:00.000Z',
        providerStateHash: operationValueHash({ remote: 1 }),
      },
    })

    const restarted = await loadWorkspaceExecutionProofIssuer('workspace-1', store)
    expect(restarted.verifyForTask(proof, {
      workspaceId: 'workspace-1',
      missionId: 'mission-1',
      nodeId: 'publish',
      idempotencyKey: 'idem-1',
    }).allowed).toBe(true)
    expect(store.createCount).toBe(1)
  })

  it('fails closed when the persisted key is malformed', async () => {
    const store: GovernanceCredentialStore = {
      getOrCreate: async () => ({ value: 'not-a-32-byte-key' }),
    }
    await expect(loadWorkspaceExecutionProofIssuer('workspace-1', store)).rejects.toThrow(
      'Governance signing key execution-proof-v1 is invalid',
    )
  })

  it('keeps distinct durable keys for distinct governance purposes', async () => {
    const store = new MemoryCredentialStore()
    const capabilityKey = await loadWorkspaceGovernanceSigningKey('workspace-1', 'capability-v1', store)
    const leaseKey = await loadWorkspaceGovernanceSigningKey('workspace-1', 'secret-lease-v1', store)
    expect(capabilityKey.equals(leaseKey)).toBe(false)
    expect(store.createCount).toBe(2)
  })
})
