import { describe, expect, test } from 'bun:test'
import {
  CapabilityBroker,
  capabilityOperationRequestHash,
  type CapabilityOperationRequest,
  type CapabilityPolicy,
} from './capability-broker'

const startMs = Date.parse('2026-07-27T10:00:00.000Z')

function policy(overrides: Partial<CapabilityPolicy> = {}): CapabilityPolicy {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-1',
    policyVersion: 3,
    authorizationGeneration: 7,
    enabled: true,
    maxRisk: 'W3',
    allowedOperations: ['documents.read', 'documents.update', 'erp.entries.post'],
    allowedOrigins: ['https://connector.example.com'],
    allowedResourceTypes: ['document', 'erp-entry'],
    approvalRequiredFor: ['W2'],
    maxRequestAgeMs: 300_000,
    capabilityTtlMs: 60_000,
    approvalTtlMs: 120_000,
    budgets: {
      maxTokens: 5_000,
      maxCostUsd: 2,
      maxWallTimeMs: 60_000,
    },
    ...overrides,
  }
}

function request(overrides: Partial<CapabilityOperationRequest> = {}): CapabilityOperationRequest {
  return {
    schemaVersion: 1,
    operationId: 'documents.read',
    risk: 'R1',
    autonomy: 'A1',
    identity: {
      clientId: 'client-1',
      workspaceId: 'workspace-1',
      missionId: 'mission-1',
      agentId: 'agent-1',
      actorId: 'operator-1',
      connectorId: 'connector-1',
    },
    target: {
      resourceType: 'document',
      resourceId: 'document-1',
      origin: 'https://connector.example.com',
    },
    payload: { fields: ['title'] },
    policyVersion: 3,
    authorizationGeneration: 7,
    requestedAt: '2026-07-27T10:00:00.000Z',
    ...overrides,
  }
}

function createBroker(now: { value: number }, configuredPolicy = policy()): CapabilityBroker {
  let id = 0
  return new CapabilityBroker({
    policy: configuredPolicy,
    signingKey: '0123456789abcdef0123456789abcdef',
    nowMs: () => now.value,
    generateId: () => `generated-${++id}`,
  })
}

describe('CapabilityBroker', () => {
  test('returns an isolated policy snapshot', () => {
    const now = { value: startMs }
    const broker = createBroker(now)
    const snapshot = broker.snapshotPolicy()
    snapshot.allowedOperations.push('forged.operation')
    expect(broker.snapshotPolicy().allowedOperations).not.toContain('forged.operation')
  })

  test('issues a payload-bound capability and consumes it exactly once', () => {
    const now = { value: startMs }
    const broker = createBroker(now)
    const operation = request()
    const decision = broker.authorize(operation)
    expect(decision.status).toBe('authorized')
    if (decision.status !== 'authorized') throw new Error('Expected an issued capability')

    expect(broker.consume(decision.capability, operation)).toMatchObject({ allowed: true })
    expect(broker.consume(decision.capability, operation)).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_ALREADY_USED',
    })

    const second = broker.authorize(operation)
    if (second.status !== 'authorized') throw new Error('Expected a second issued capability')
    expect(broker.consume(second.capability, {
      ...operation,
      payload: { fields: ['title', 'body'] },
    })).toMatchObject({ allowed: false, code: 'CAPABILITY_INVALID' })
  })

  test('requires one-time approval and separation of duties for W3', () => {
    const now = { value: startMs }
    const broker = createBroker(now)
    const operation = request({
      operationId: 'erp.entries.post',
      risk: 'W3',
      autonomy: 'A4',
      target: {
        resourceType: 'erp-entry',
        resourceId: 'entry-42',
        origin: 'https://connector.example.com',
      },
      payload: { debit: 100, credit: 100 },
      idempotencyKey: 'entry-42-v1',
      compensation: { strategy: 'inverse-operation', operationId: 'erp.entries.reverse' },
    })
    const pending = broker.authorize(operation)
    expect(pending.status).toBe('approval-required')
    if (pending.status !== 'approval-required') throw new Error('Expected approval request')

    expect(broker.resolveApproval(pending.approval.approvalId, 'approved', 'operator-1'))
      .toEqual({ status: 'denied', reason: 'W3 operations require separation of duties' })

    const replacement = broker.authorize(operation)
    if (replacement.status !== 'approval-required') throw new Error('Expected replacement approval request')
    const approved = broker.resolveApproval(replacement.approval.approvalId, 'approved', 'validator-1')
    expect(approved.status).toBe('approved')

    const authorized = broker.authorize(operation, replacement.approval.approvalId)
    expect(authorized.status).toBe('authorized')
    expect(broker.authorize(operation, replacement.approval.approvalId)).toMatchObject({
      status: 'denied',
      code: 'APPROVAL_INVALID',
    })
  })

  test('revokes stale generations and active kill-switch scopes', () => {
    const now = { value: startMs }
    const broker = createBroker(now)
    expect(broker.authorize(request({ authorizationGeneration: 6 }))).toMatchObject({
      status: 'denied',
      code: 'AUTHORIZATION_GENERATION_MISMATCH',
    })

    broker.setKillSwitch('mission', true, 'mission-1')
    expect(broker.authorize(request())).toMatchObject({
      status: 'denied',
      code: 'KILL_SWITCH_ACTIVE',
    })
    broker.setKillSwitch('mission', false, 'mission-1')
    expect(broker.authorize(request()).status).toBe('authorized')
  })

  test('fails closed on origins, budgets, idempotency, and compensation', () => {
    const now = { value: startMs }
    const broker = createBroker(now)
    expect(broker.authorize(request({
      target: { resourceType: 'document', origin: 'https://attacker.example' },
    }))).toMatchObject({ status: 'denied', code: 'ORIGIN_DENIED' })
    expect(broker.authorize(request({
      budget: { costUsd: 3 },
    }))).toMatchObject({ status: 'denied', code: 'BUDGET_DENIED' })
    expect(broker.authorize(request({
      operationId: 'documents.update',
      risk: 'W2',
      autonomy: 'A3',
    }))).toMatchObject({ status: 'denied', code: 'IDEMPOTENCY_REQUIRED' })
    expect(broker.authorize(request({
      operationId: 'documents.update',
      risk: 'W2',
      autonomy: 'A3',
      idempotencyKey: 'document-1-v2',
    }))).toMatchObject({ status: 'denied', code: 'COMPENSATION_REQUIRED' })
  })

  test('expires capabilities and invalidates them on policy rotation', () => {
    const now = { value: startMs }
    const broker = createBroker(now)
    const operation = request()
    const first = broker.authorize(operation)
    if (first.status !== 'authorized') throw new Error('Expected issued capability')
    now.value += 60_001
    expect(broker.consume(first.capability, operation)).toMatchObject({
      allowed: false,
      code: 'CAPABILITY_EXPIRED',
    })

    now.value = startMs
    const second = broker.authorize(operation)
    if (second.status !== 'authorized') throw new Error('Expected issued capability')
    broker.updatePolicy(policy({ policyVersion: 4, authorizationGeneration: 8 }))
    expect(broker.consume(second.capability, operation)).toMatchObject({
      allowed: false,
      code: 'POLICY_VERSION_MISMATCH',
    })
  })

  test('binds bounded approval context to the canonical request hash without exposing business values', () => {
    const now = { value: startMs }
    const broker = createBroker(now)
    const operation = request({
      operationId: 'documents.update',
      risk: 'W2',
      autonomy: 'A3',
      payload: { confidentialTitle: 'Quarterly acquisition target' },
      idempotencyKey: 'document-1-v3',
      compensation: { strategy: 'manual' },
      approvalContext: {
        provider: 'Document Provider',
        connectorId: 'connector-1',
        origin: 'https://connector.example.com',
        resourceClass: 'document',
        purpose: 'Update an approved document',
        effect: 'external-mutation',
        method: 'PATCH',
      },
    })
    const pending = broker.authorize(operation)
    if (pending.status !== 'approval-required') throw new Error('Expected approval request')
    expect(pending.approval).toMatchObject({
      risk: 'W2',
      approvalContext: {
        provider: 'Document Provider',
        resourceClass: 'document',
        purpose: 'Update an approved document',
        method: 'PATCH',
      },
    })
    expect(JSON.stringify(pending.approval)).not.toContain('Quarterly acquisition target')
    expect(JSON.stringify(pending.approval)).not.toContain('document-1')

    expect(capabilityOperationRequestHash({
      ...operation,
      approvalContext: { ...operation.approvalContext!, purpose: 'Delete the document' },
    })).not.toBe(capabilityOperationRequestHash(operation))
    expect(() => capabilityOperationRequestHash({
      ...operation,
      approvalContext: { ...operation.approvalContext!, origin: 'https://attacker.example' },
    })).toThrow('Approval origin must match')
  })
})
