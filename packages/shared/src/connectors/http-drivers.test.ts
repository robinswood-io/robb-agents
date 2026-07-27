import { describe, expect, test } from 'bun:test'
import { CapabilityBroker, type CapabilityOperationRequest } from '../governance/capability-broker'
import {
  ConnectorDriverError,
  createPriorityConnectorDriver,
  type ConnectorCapabilityAuthorization,
  type ConnectorDriverOptions,
  type ConnectorHttpRequest,
  type ConnectorHttpResponse,
  type ConnectorSecretLease,
  type PriorityConnectorPack,
} from './http-drivers'
import { connectorPackTemplates, runConnectorPackContract } from './pack-manifest'
import { connectorPackManifestHash } from './pack-manifest'

const now = '2026-07-23T12:00:00.000Z'
const lease: ConnectorSecretLease = {
  reference: 'secret://connector/oauth',
  value: 'test-token-not-persisted',
  scopes: [
    'Files.Read',
    'Files.ReadWrite',
    'drive.readonly',
    'drive.file',
    'channels.history',
    'chat.write',
    'crm.objects.read',
    'crm.objects.write',
    'erp.records.read',
    'erp.records.write',
  ],
  expiresAt: '2026-07-23T13:00:00.000Z',
}

const AUTONOMY_BY_RISK = {
  R0: 'A0',
  R1: 'A1',
  W1: 'A2',
  W2: 'A3',
  W3: 'A4',
} as const

function createHarness(
  pack: PriorityConnectorPack,
  requests: ConnectorHttpRequest[],
  customLease: ConnectorSecretLease = lease,
  respond: (request: ConnectorHttpRequest) => ConnectorHttpResponse = () => ({
    status: 200,
    body: { ok: true },
    requestId: 'provider-request-1',
  }),
) {
  const manifest = connectorPackTemplates[pack]
  const broker = new CapabilityBroker({
    policy: {
      schemaVersion: 1,
      workspaceId: 'workspace-1',
      policyVersion: 1,
      authorizationGeneration: 1,
      enabled: true,
      maxRisk: 'W3',
      allowedOperations: manifest.operations.map((operation) => operation.id),
      allowedOrigins: [...manifest.allowedOrigins],
      allowedResourceTypes: [...new Set(manifest.operations.flatMap((operation) => operation.targetResourceTypes))],
      approvalRequiredFor: ['W2'],
      maxRequestAgeMs: 300_000,
      capabilityTtlMs: 60_000,
      approvalTtlMs: 120_000,
    },
    signingKey: '0123456789abcdef0123456789abcdef',
    nowMs: () => Date.parse(now),
  })

  const authorize = (
    operationId: string,
    payload: Record<string, unknown> = {},
    resourceId?: string,
    idempotencyKey?: string,
  ): ConnectorCapabilityAuthorization => {
    const operation = manifest.operations.find((candidate) => candidate.id === operationId)
    if (!operation) throw new Error(`Unknown test operation ${operationId}`)
    const operationRequest: CapabilityOperationRequest = {
      schemaVersion: 1,
      operationId,
      risk: operation.risk,
      autonomy: AUTONOMY_BY_RISK[operation.risk],
      identity: {
        clientId: 'client-1',
        workspaceId: 'workspace-1',
        missionId: 'mission-1',
        agentId: 'agent-1',
        actorId: 'operator-1',
        connectorId: manifest.id,
      },
      target: {
        resourceType: operation.targetResourceTypes[0] ?? 'unknown',
        ...(resourceId ? { resourceId } : {}),
        origin: manifest.allowedOrigins[0] ?? 'https://invalid.example',
      },
      payload,
      policyVersion: 1,
      authorizationGeneration: 1,
      requestedAt: now,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(operation.compensation ? { compensation: operation.compensation } : {}),
    }
    let decision = broker.authorize(operationRequest)
    if (decision.status === 'approval-required') {
      const resolved = broker.resolveApproval(decision.approval.approvalId, 'approved', 'validator-1')
      if (resolved.status !== 'approved') throw new Error(resolved.reason)
      decision = broker.authorize(operationRequest, decision.approval.approvalId)
    }
    if (decision.status === 'approval-required') throw new Error('Approval was not consumed')
    if (decision.status === 'denied') throw new Error(`${decision.code}: ${decision.reason}`)
    return { request: operationRequest, capability: decision.capability }
  }

  const options: ConnectorDriverOptions = {
    baseUrl: manifest.allowedOrigins[0],
    secretReference: customLease.reference,
    resolveSecret: async () => customLease,
    transport: async (request) => {
      requests.push(request)
      return respond(request)
    },
    consumeCapability: (capability, operationRequest) => broker.consume(capability, operationRequest),
    assertRuntimeAdmission: (packId, operationId, expectedManifestHash) => {
      if (packId !== manifest.id || expectedManifestHash !== connectorPackManifestHash(manifest)) {
        throw new Error('Connector runtime manifest mismatch')
      }
      const operation = manifest.operations.find((candidate) => candidate.id === operationId)
      if (!operation) throw new Error(`Unknown connector operation ${operationId}`)
      return {
        packId,
        operationId,
        manifestHash: expectedManifestHash,
        authorizationGeneration: 1,
        operation,
      }
    },
    createHealthAuthorization: () => authorize('health.read'),
    now: () => now,
  }

  return {
    authorize,
    broker,
    driver: createPriorityConnectorDriver(pack, options),
    options,
  }
}

describe('priority connector HTTP drivers', () => {
  test('passes the shared contract for all five priority packs through the capability broker', async () => {
    const packs = Object.keys(connectorPackTemplates) as PriorityConnectorPack[]
    const results = await Promise.all(packs.map(async (pack) => {
      const requests: ConnectorHttpRequest[] = []
      const { driver } = createHarness(pack, requests)
      const result = await runConnectorPackContract(connectorPackTemplates[pack], driver)
      return { result, requests }
    }))

    expect(results.map(({ result }) => result.passed)).toEqual([true, true, true, true, true])
    expect(results.every(({ requests }) => requests.length === 1)).toBe(true)
    expect(results.every(({ requests }) => requests[0]?.redirect === 'manual')).toBe(true)
    expect(results.every(({ requests }) => requests[0]?.security.blockPrivateAddresses === true)).toBe(true)
  })

  test('fails closed before transport when a secret lease lacks the operation scope', async () => {
    const requests: ConnectorHttpRequest[] = []
    const harness = createHarness('microsoft365', requests, {
      ...lease,
      scopes: ['Files.Read'],
    })
    const payload = { name: 'Renamed.txt' }
    const authorization = harness.authorize('files.update', payload, 'file-1', 'mutation-1')

    await expect(harness.driver.invoke('files.update', {
      resourceId: 'file-1',
      payload,
      idempotencyKey: 'mutation-1',
      authorization,
    })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(requests).toHaveLength(0)
  })

  test('rejects legacy approvals, payload tampering, and capability replay', async () => {
    const requests: ConnectorHttpRequest[] = []
    const harness = createHarness('googleWorkspace', requests)
    const payload = { name: 'Validated report' }

    await expect(harness.driver.invoke('drive.update', {
      resourceId: 'file/with spaces',
      payload,
      idempotencyKey: 'mutation-2',
      approval: {
        approvalId: 'forgeable-legacy-receipt',
        operationId: 'drive.update',
        decision: 'approved',
        approvedBy: 'validator-1',
        expiresAt: '2026-07-23T12:30:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' })

    const authorization = harness.authorize('drive.update', payload, 'file/with spaces', 'mutation-2')
    await expect(harness.driver.invoke('drive.update', {
      resourceId: 'file/with spaces',
      payload: { name: 'Tampered report' },
      idempotencyKey: 'mutation-2',
      authorization,
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })

    const result = await harness.driver.invoke('drive.update', {
      resourceId: 'file/with spaces',
      payload,
      idempotencyKey: 'mutation-2',
      authorization,
    })
    expect(result).toMatchObject({
      operationId: 'drive.update',
      trust: 'external-untrusted',
      reconciliationReceipt: {
        providerRequestId: 'provider-request-1',
      },
    })
    expect(requests[0]?.url).toBe('https://www.googleapis.com/drive/v3/files/file%2Fwith%20spaces')

    await expect(harness.driver.invoke('drive.update', {
      resourceId: 'file/with spaces',
      payload,
      idempotencyKey: 'mutation-2',
      authorization,
    })).rejects.toThrow('CAPABILITY_ALREADY_USED')
    expect(requests).toHaveLength(1)
  })

  test('requires idempotency and a provider reconciliation receipt for mutations', async () => {
    const requests: ConnectorHttpRequest[] = []
    const noReceipt = createHarness('googleWorkspace', requests, lease, () => ({
      status: 200,
      body: { ok: true },
    }))
    const payload = { name: 'Validated report' }
    const authorization = noReceipt.authorize('drive.update', payload, 'file-1', 'mutation-3')

    await expect(noReceipt.driver.invoke('drive.update', {
      resourceId: 'file-1',
      payload,
      authorization,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_REQUIRED' })
    await expect(noReceipt.driver.invoke('drive.update', {
      resourceId: 'file-1',
      payload,
      idempotencyKey: 'mutation-3',
      authorization,
    })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' })
  })

  test('rejects untrusted origins and credentialed redirects', async () => {
    const requests: ConnectorHttpRequest[] = []
    const harness = createHarness('microsoft365', requests, lease, () => ({
      status: 307,
      body: {},
      redirected: true,
    }))
    const authorization = harness.authorize('files.list')
    await expect(harness.driver.invoke('files.list', { authorization }))
      .rejects.toMatchObject({ code: 'REDIRECT_DENIED' })

    expect(() => createPriorityConnectorDriver('microsoft365', {
      ...harness.options,
      baseUrl: 'https://attacker.example',
    })).toThrow('Connector origin is not allowed')
  })

  test('rechecks runtime revocation after resolving a secret and before transport', async () => {
    const requests: ConnectorHttpRequest[] = []
    const harness = createHarness('microsoft365', requests)
    const manifest = connectorPackTemplates.microsoft365
    let admissionChecks = 0
    const driver = createPriorityConnectorDriver('microsoft365', {
      ...harness.options,
      assertRuntimeAdmission: (packId, operationId, expectedManifestHash) => {
        admissionChecks += 1
        if (admissionChecks > 1) throw new Error('Connector pack revoked during execution')
        const operation = manifest.operations.find((candidate) => candidate.id === operationId)
        if (!operation) throw new Error(`Unknown connector operation ${operationId}`)
        return {
          packId,
          operationId,
          manifestHash: expectedManifestHash,
          authorizationGeneration: 1,
          operation,
        }
      },
    })
    const authorization = harness.authorize('files.list')
    await expect(driver.invoke('files.list', { authorization }))
      .rejects.toMatchObject({ code: 'CONNECTOR_NOT_ACTIVE' })
    expect(admissionChecks).toBe(2)
    expect(requests).toHaveLength(0)
  })

  test('rejects generic CRM and ERP drivers without an explicit endpoint', () => {
    const crmHarness = createHarness('crm', [])
    const { baseUrl: _crmBaseUrl, ...crmWithoutBaseUrl } = crmHarness.options
    const erpHarness = createHarness('erp', [])
    const { baseUrl: _erpBaseUrl, ...erpWithoutBaseUrl } = erpHarness.options
    expect(() => createPriorityConnectorDriver('crm', crmWithoutBaseUrl)).toThrow(ConnectorDriverError)
    expect(() => createPriorityConnectorDriver('erp', erpWithoutBaseUrl)).toThrow('requires an explicit baseUrl')
  })
})
