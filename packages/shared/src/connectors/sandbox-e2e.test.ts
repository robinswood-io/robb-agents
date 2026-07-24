import { describe, expect, test } from 'bun:test'

import {
  ConnectorSandboxError,
  runConnectorSandboxProbe,
  type ConnectorSandboxRequest,
} from './sandbox-e2e'

describe('connector vendor sandbox E2E probe', () => {
  test('uses read-only authenticated endpoints for built-in vendors', async () => {
    const requests: ConnectorSandboxRequest[] = []
    const results = await Promise.all(
      (['microsoft365', 'googleWorkspace', 'slack', 'hubspot'] as const).map((provider) =>
        runConnectorSandboxProbe({
          provider,
          accessToken: 'sandbox-token',
          transport: async (request) => {
            requests.push(request)
            return { status: 200, body: provider === 'slack' ? { ok: true } : { id: 'account' } }
          },
        }),
      ),
    )

    expect(results.every((result) => result.authenticated)).toBe(true)
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
    expect(requests.every((request) => request.headers.Authorization === 'Bearer sandbox-token')).toBe(true)
    expect(requests.map((request) => new URL(request.url).protocol)).toEqual([
      'https:',
      'https:',
      'https:',
      'https:',
    ])
  })

  test('requires an explicit HTTPS endpoint for generic CRM and ERP sandboxes', async () => {
    const transport = async () => ({ status: 200, body: { ok: true } })
    await expect(runConnectorSandboxProbe({
      provider: 'genericCrm',
      accessToken: 'token',
      transport,
    })).rejects.toBeInstanceOf(ConnectorSandboxError)
    await expect(runConnectorSandboxProbe({
      provider: 'genericErp',
      accessToken: 'token',
      endpoint: 'http://erp.test/health',
      transport,
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })
  })

  test('fails closed on auth errors and Slack ok=false responses', async () => {
    await expect(runConnectorSandboxProbe({
      provider: 'microsoft365',
      accessToken: 'expired',
      transport: async () => ({ status: 401, body: { error: 'invalid_token' } }),
    })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
    await expect(runConnectorSandboxProbe({
      provider: 'slack',
      accessToken: 'invalid',
      transport: async () => ({ status: 200, body: { ok: false, error: 'invalid_auth' } }),
    })).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' })
  })
})
