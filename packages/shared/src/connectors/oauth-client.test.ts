import { describe, expect, test } from 'bun:test'

import {
  ConnectorOAuthError,
  createConnectorOAuthProfile,
  createConnectorSecretLeaseFromOAuth,
  exchangeConnectorOAuthCode,
  prepareConnectorOAuthFlow,
  refreshConnectorOAuthToken,
  type ConnectorOAuthHttpRequest,
} from './oauth-client'

const now = '2026-07-23T12:00:00.000Z'

describe('connector OAuth client', () => {
  test('prepares a Microsoft authorization-code flow with PKCE and state', () => {
    const profile = createConnectorOAuthProfile('microsoft365', { tenantId: 'tenant-42' })
    const flow = prepareConnectorOAuthFlow({
      profile,
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:45123/oauth/callback',
      connectorScopes: ['Files.Read', 'Files.ReadWrite'],
      now: () => now,
    })
    const authorizationUrl = new URL(flow.authorizationUrl)

    expect(authorizationUrl.origin).toBe('https://login.microsoftonline.com')
    expect(authorizationUrl.pathname).toContain('/tenant-42/oauth2/v2.0/authorize')
    expect(authorizationUrl.searchParams.get('state')).toBe(flow.state)
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('code_challenge')).not.toBe(flow.codeVerifier)
    expect(flow.requestedConnectorScopes).toEqual(['Files.Read', 'Files.ReadWrite'])
  })

  test('rejects insecure generic provider endpoints and redirect targets', () => {
    expect(() => createConnectorOAuthProfile('genericErp', {
      authorizationEndpoint: 'http://erp.test/authorize',
      tokenEndpoint: 'https://erp.test/token',
      scopes: [{ connectorScope: 'erp.records.read', oauthScope: 'erp.read' }],
    })).toThrow(ConnectorOAuthError)

    const profile = createConnectorOAuthProfile('googleWorkspace')
    expect(() => prepareConnectorOAuthFlow({
      profile,
      clientId: 'client-1',
      redirectUri: 'http://remote-host.test/callback',
      connectorScopes: ['drive.readonly'],
    })).toThrow('HTTPS or an explicit loopback host')
  })

  test('exchanges a code without logging or returning the client secret', async () => {
    const profile = createConnectorOAuthProfile('googleWorkspace')
    const flow = prepareConnectorOAuthFlow({
      profile,
      clientId: 'google-client',
      redirectUri: 'http://localhost:45123/oauth/callback',
      connectorScopes: ['drive.readonly', 'drive.file'],
      now: () => now,
    })
    const requests: ConnectorOAuthHttpRequest[] = []
    const tokenSet = await exchangeConnectorOAuthCode({
      profile,
      flow,
      returnedState: flow.state,
      code: 'one-time-code',
      clientId: 'google-client',
      clientSecret: 'secret-value',
      now: () => now,
      transport: async (request) => {
        requests.push(request)
        return {
          status: 200,
          body: {
            access_token: 'access-value',
            refresh_token: 'refresh-value',
            expires_in: 3600,
            token_type: 'Bearer',
            scope: flow.requestedOAuthScopes.join(' '),
          },
        }
      },
    })

    expect(tokenSet).toEqual({
      accessToken: 'access-value',
      refreshToken: 'refresh-value',
      expiresAt: '2026-07-23T13:00:00.000Z',
      tokenType: 'Bearer',
      grantedOAuthScopes: flow.requestedOAuthScopes,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.body).toContain('code_verifier=')
    expect(requests[0]?.body).toContain('client_secret=secret-value')
    expect(JSON.stringify(tokenSet)).not.toContain('secret-value')
  })

  test('validates callback state and flow expiry before token exchange', async () => {
    const profile = createConnectorOAuthProfile('microsoft365')
    const flow = prepareConnectorOAuthFlow({
      profile,
      clientId: 'client-1',
      redirectUri: 'http://127.0.0.1:45123/oauth/callback',
      connectorScopes: ['Files.Read'],
      now: () => now,
    })
    let requestCount = 0
    const transport = async () => {
      requestCount += 1
      return { status: 200, body: { access_token: 'unused' } }
    }

    await expect(exchangeConnectorOAuthCode({
      profile,
      flow,
      returnedState: 'attacker-state',
      code: 'code',
      clientId: 'client-1',
      clientSecret: 'secret',
      transport,
    })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(exchangeConnectorOAuthCode({
      profile,
      flow,
      returnedState: flow.state,
      code: 'code',
      clientId: 'client-1',
      clientSecret: 'secret',
      now: () => '2026-07-23T12:11:00.000Z',
      transport,
    })).rejects.toMatchObject({ code: 'FLOW_EXPIRED' })
    expect(requestCount).toBe(0)
  })

  test('refreshes tokens and keeps a rotated or existing refresh token', async () => {
    const profile = createConnectorOAuthProfile('hubspot')
    const refreshed = await refreshConnectorOAuthToken({
      profile,
      refreshToken: 'refresh-1',
      clientId: 'hubspot-client',
      clientSecret: 'hubspot-secret',
      now: () => now,
      transport: async (request) => {
        expect(request.body).toContain('grant_type=refresh_token')
        return {
          status: 200,
          body: {
            access_token: 'access-2',
            expires_in: 1800,
            scope: 'crm.objects.contacts.read crm.objects.contacts.write',
          },
        }
      },
    })
    expect(refreshed.refreshToken).toBe('refresh-1')
    expect(refreshed.expiresAt).toBe('2026-07-23T12:30:00.000Z')
  })

  test('maps granted vendor scopes to a short-lived secret lease', () => {
    const profile = createConnectorOAuthProfile('googleWorkspace')
    const lease = createConnectorSecretLeaseFromOAuth({
      reference: 'secret://connectors/google',
      profile,
      tokenSet: {
        accessToken: 'access-token',
        tokenType: 'Bearer',
        expiresAt: '2026-07-23T13:00:00.000Z',
        grantedOAuthScopes: [
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/drive.file',
        ],
      },
      requestedConnectorScopes: ['drive.readonly', 'drive.file'],
    })
    expect(lease).toEqual({
      reference: 'secret://connectors/google',
      value: 'access-token',
      scopes: ['drive.readonly', 'drive.file'],
      expiresAt: '2026-07-23T13:00:00.000Z',
    })
  })
})
