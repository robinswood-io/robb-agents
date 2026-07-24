import { describe, expect, test } from 'bun:test'
import {
  ConnectorDriverError,
  createPriorityConnectorDriver,
  type ConnectorHttpRequest,
  type ConnectorSecretLease,
  type PriorityConnectorPack,
} from './http-drivers'
import { connectorPackTemplates, runConnectorPackContract } from './pack-manifest'

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

function driverOptions(requests: ConnectorHttpRequest[], customLease = lease) {
  return {
    baseUrl: 'https://connector.test',
    secretReference: customLease.reference,
    resolveSecret: async () => customLease,
    transport: async (request: ConnectorHttpRequest) => {
      requests.push(request)
      return { status: 200, body: { ok: true } }
    },
    now: () => now,
  }
}

describe('priority connector HTTP drivers', () => {
  test('passes the shared contract for all five priority packs', async () => {
    const packs = Object.keys(connectorPackTemplates) as PriorityConnectorPack[]
    const results = await Promise.all(packs.map(async (pack) => {
      const requests: ConnectorHttpRequest[] = []
      const driver = createPriorityConnectorDriver(pack, driverOptions(requests))
      const result = await runConnectorPackContract(connectorPackTemplates[pack], driver)
      return { result, requests }
    }))

    expect(results.map(({ result }) => result.passed)).toEqual([true, true, true, true, true])
    expect(results.every(({ requests }) => requests.length === 1)).toBe(true)
  })

  test('fails closed when a secret lease lacks the operation scope', async () => {
    const requests: ConnectorHttpRequest[] = []
    const driver = createPriorityConnectorDriver('microsoft365', driverOptions(requests, {
      ...lease,
      scopes: ['Files.Read'],
    }))

    await expect(driver.invoke('files.update', {
      resourceId: 'file-1',
      payload: { name: 'Renamed.txt' },
      idempotencyKey: 'mutation-1',
      approval: {
        approvalId: 'approval-1',
        operationId: 'files.update',
        decision: 'approved',
        approvedBy: 'validator-1',
        expiresAt: '2026-07-23T12:30:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(requests).toHaveLength(0)
  })

  test('requires approval and idempotency before an external mutation', async () => {
    const requests: ConnectorHttpRequest[] = []
    const driver = createPriorityConnectorDriver('googleWorkspace', driverOptions(requests))
    const input = {
      resourceId: 'file/with spaces',
      payload: { name: 'Validated report' },
    }

    await expect(driver.invoke('drive.update', input))
      .rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(driver.invoke('drive.update', {
      ...input,
      approval: {
        approvalId: 'approval-2',
        operationId: 'drive.update',
        decision: 'approved',
        approvedBy: 'validator-1',
        expiresAt: '2026-07-23T12:30:00.000Z',
      },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_REQUIRED' })

    const result = await driver.invoke('drive.update', {
      ...input,
      idempotencyKey: 'mutation-2',
      approval: {
        approvalId: 'approval-2',
        operationId: 'drive.update',
        decision: 'approved',
        approvedBy: 'validator-1',
        expiresAt: '2026-07-23T12:30:00.000Z',
      },
    })
    expect(result.operationId).toBe('drive.update')
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://connector.test/drive/v3/files/file%2Fwith%20spaces')
    expect(requests[0]?.headers['Idempotency-Key']).toBe('mutation-2')
  })

  test('rejects generic CRM and ERP drivers without an explicit endpoint', () => {
    const options = driverOptions([])
    const withoutBaseUrl = {
      secretReference: options.secretReference,
      resolveSecret: options.resolveSecret,
      transport: options.transport,
      now: options.now,
    }
    expect(() => createPriorityConnectorDriver('crm', withoutBaseUrl)).toThrow(ConnectorDriverError)
    expect(() => createPriorityConnectorDriver('erp', withoutBaseUrl)).toThrow('requires an explicit baseUrl')
  })
})
