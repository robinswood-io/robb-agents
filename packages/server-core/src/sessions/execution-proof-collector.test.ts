import { describe, expect, it } from 'bun:test'
import { ExecutionProofIssuer, operationValueHash } from '@craft-agent/shared/governance'
import { ExecutionProofCollector } from './execution-proof-collector'

function proofFor(nodeId = 'publish') {
  return new ExecutionProofIssuer({
    signingKey: 'session-proof-collector-signing-key-32-bytes',
    now: () => '2026-07-27T10:00:01.000Z',
    generateId: () => `proof-${nodeId}`,
  }).issue({
    clientId: 'client-1',
    workspaceId: 'workspace-1',
    missionId: 'mission-1',
    nodeId,
    agentId: 'agent-1',
    connectorId: 'connector-1',
    operationId: 'records.upsert',
    idempotencyKey: `idem-${nodeId}`,
    payloadHash: operationValueHash({ input: nodeId }),
    resultHash: operationValueHash({ output: nodeId }),
    providerRequestId: `provider-${nodeId}`,
    policyVersion: 1,
    authorizationGeneration: 1,
    connectorManifestHash: operationValueHash({ manifest: 1 }),
    reconciliation: {
      status: 'confirmed',
      observedAt: '2026-07-27T10:00:00.000Z',
      providerStateHash: operationValueHash({ remote: nodeId }),
    },
  })
}

describe('ExecutionProofCollector', () => {
  const binding = {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    missionId: 'mission-1',
    nodeId: 'publish',
  }

  it('keeps a matching proof off-channel until the host consumes it once', () => {
    const collector = new ExecutionProofCollector()
    const proof = proofFor()
    expect(collector.record(binding, proof)).toEqual(proof)
    expect(collector.take('session-1')).toEqual(proof)
    expect(collector.take('session-1')).toBeUndefined()
  })

  it('rejects cross-node proof reuse and conflicting proofs', () => {
    const collector = new ExecutionProofCollector()
    expect(() => collector.record(binding, proofFor('other'))).toThrow('bound session identity')
    collector.record(binding, proofFor())
    const conflicting = { ...proofFor(), providerRequestId: 'different-request' }
    expect(() => collector.record(binding, conflicting)).toThrow('Conflicting execution proofs')
  })
})
