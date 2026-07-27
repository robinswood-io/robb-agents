import { describe, expect, test } from 'bun:test'
import { SecretLeaseBroker, type SecretLeaseIssueRequest } from './secret-lease-broker'

const startMs = Date.parse('2026-07-27T10:00:00.000Z')

function leaseRequest(overrides: Partial<SecretLeaseIssueRequest> = {}): SecretLeaseIssueRequest {
  return {
    secretReference: 'secret://workspace-1/google',
    secretName: 'google-oauth-access-token',
    identity: {
      clientId: 'client-1',
      workspaceId: 'workspace-1',
      sourceId: 'io.robb-agents.google-workspace',
      missionId: 'mission-1',
      agentId: 'agent-1',
      connectorId: 'io.robb-agents.google-workspace',
    },
    operationId: 'drive.update',
    scopes: ['drive.file'],
    authorizationGeneration: 7,
    ttlMs: 60_000,
    maxUses: 1,
    ...overrides,
  }
}

function createBroker(clock: { value: number }, generation: { value: number }): SecretLeaseBroker {
  let leaseSequence = 0
  return new SecretLeaseBroker({
    signingKey: '0123456789abcdef0123456789abcdef',
    currentAuthorizationGeneration: () => generation.value,
    nowMs: () => clock.value,
    generateId: () => `lease-${++leaseSequence}`,
  })
}

describe('SecretLeaseBroker', () => {
  test('binds a one-time grant to client, workspace, source, mission, connector, operation, and scopes', () => {
    const clock = { value: startMs }
    const generation = { value: 7 }
    const broker = createBroker(clock, generation)
    const issue = leaseRequest()
    const grant = broker.issue(issue)
    const request = {
      secretReference: issue.secretReference,
      identity: issue.identity,
      operationId: issue.operationId,
      scopes: issue.scopes,
      authorizationGeneration: 7,
    }
    expect(broker.consume(grant, request)).toEqual({ allowed: true, leaseId: 'lease-1', remainingUses: 0 })
    expect(broker.consume(grant, request)).toMatchObject({ allowed: false, code: 'LEASE_EXHAUSTED' })
  })

  test('rejects tampering, cross-workspace use, expiration, revocation, and stale generations', () => {
    const clock = { value: startMs }
    const generation = { value: 7 }
    const broker = createBroker(clock, generation)
    const issue = leaseRequest({ maxUses: 5 })
    const request = {
      secretReference: issue.secretReference,
      identity: issue.identity,
      operationId: issue.operationId,
      scopes: issue.scopes,
      authorizationGeneration: 7,
    }

    const tampered = broker.issue(issue)
    expect(broker.consume({ ...tampered, operationId: 'drive.delete' }, request))
      .toMatchObject({ allowed: false, code: 'LEASE_INVALID' })

    const crossWorkspace = broker.issue(issue)
    expect(broker.consume(crossWorkspace, {
      ...request,
      identity: { ...request.identity, workspaceId: 'workspace-2' },
    })).toMatchObject({ allowed: false, code: 'LEASE_BINDING_MISMATCH' })

    const revoked = broker.issue(issue)
    broker.revoke(revoked.leaseId)
    expect(broker.consume(revoked, request)).toMatchObject({ allowed: false, code: 'LEASE_REVOKED' })

    const stale = broker.issue(issue)
    generation.value = 8
    expect(broker.consume(stale, request))
      .toMatchObject({ allowed: false, code: 'AUTHORIZATION_GENERATION_MISMATCH' })

    generation.value = 7
    const expired = broker.issue(issue)
    clock.value += 60_001
    expect(broker.consume(expired, request)).toMatchObject({ allowed: false, code: 'LEASE_EXPIRED' })
  })

  test('refuses grants beyond the bounded TTL or current authorization generation', () => {
    const clock = { value: startMs }
    const generation = { value: 7 }
    const broker = createBroker(clock, generation)
    expect(() => broker.issue(leaseRequest({ ttlMs: 5 * 60_000 + 1 }))).toThrow('TTL')
    expect(() => broker.issue(leaseRequest({ authorizationGeneration: 6 }))).toThrow('stale')
  })
})
