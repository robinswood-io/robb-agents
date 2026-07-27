import { describe, expect, it } from 'bun:test'
import { operationValueHash } from './capability-broker'
import { ExecutionProofIssuer, type ExecutionProofIssueRequest } from './execution-proof'

const SIGNING_KEY = 'execution-proof-test-key-material-32-bytes-minimum'

function request(
  overrides: Partial<ExecutionProofIssueRequest> = {},
): ExecutionProofIssueRequest {
  return {
    clientId: 'client-a',
    workspaceId: 'workspace-a',
    missionId: 'mission-a',
    nodeId: 'publish',
    agentId: 'agent-a',
    connectorId: 'slackTeams',
    operationId: 'messages.send',
    idempotencyKey: 'mission-a:publish',
    payloadHash: operationValueHash({ channel: 'C123', text: 'hello' }),
    resultHash: operationValueHash({ ok: true, ts: '123.456' }),
    providerRequestId: 'provider-request-1',
    policyVersion: 7,
    authorizationGeneration: 3,
    connectorManifestHash: operationValueHash({ manifest: 'slack-v1' }),
    reconciliation: {
      status: 'confirmed',
      observedAt: '2026-07-27T10:00:01.000Z',
      providerStateHash: operationValueHash({ exists: true, ts: '123.456' }),
    },
    ...overrides,
  }
}

describe('ExecutionProofIssuer', () => {
  it('verifies a signed proof only for the exact authorized binding', () => {
    const issuer = new ExecutionProofIssuer({
      signingKey: SIGNING_KEY,
      now: () => '2026-07-27T10:00:00.000Z',
      generateId: () => 'proof-1',
    })
    const input = request()
    const proof = issuer.issue(input)

    expect(issuer.verify(proof, input)).toEqual({ allowed: true, proof })
    expect(issuer.verifyForTask(proof, {
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      nodeId: input.nodeId,
      idempotencyKey: input.idempotencyKey,
    })).toEqual({ allowed: true, proof })
  })

  it('rejects tampering even when the proof remains structurally valid', () => {
    const issuer = new ExecutionProofIssuer({ signingKey: SIGNING_KEY })
    const proof = issuer.issue(request())

    expect(issuer.verifyForTask({ ...proof, providerRequestId: 'forged-request' }, {
      workspaceId: 'workspace-a',
      missionId: 'mission-a',
      nodeId: 'publish',
      idempotencyKey: 'mission-a:publish',
    })).toMatchObject({ allowed: false, code: 'PROOF_INVALID' })
  })

  it('rejects reuse across task nodes', () => {
    const issuer = new ExecutionProofIssuer({ signingKey: SIGNING_KEY })
    const proof = issuer.issue(request())

    expect(issuer.verifyForTask(proof, {
      workspaceId: 'workspace-a',
      missionId: 'mission-a',
      nodeId: 'publish-again',
      idempotencyKey: 'mission-a:publish-again',
    })).toMatchObject({ allowed: false, code: 'PROOF_BINDING_MISMATCH' })
  })

  it('preserves divergent reconciliation as evidence but never as success', () => {
    const issuer = new ExecutionProofIssuer({ signingKey: SIGNING_KEY })
    const input = request({
      reconciliation: {
        status: 'diverged',
        observedAt: '2026-07-27T10:00:01.000Z',
        providerStateHash: operationValueHash({ exists: false }),
        detailCode: 'PROVIDER_STATE_MISSING',
      },
    })
    const proof = issuer.issue(input)

    expect(issuer.verify(proof, input)).toMatchObject({
      allowed: false,
      code: 'RECONCILIATION_DIVERGED',
    })
  })
})
