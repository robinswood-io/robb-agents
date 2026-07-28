import { describe, it, expect } from 'bun:test'

/**
 * Tests that all OAuth prepare functions correctly support callbackUrl
 * as an alternative to callbackPort for WebUI deployments.
 */

import {
  buildGoogleAuthorizationCodeTokenParams,
  buildGoogleRefreshTokenParams,
  isGoogleOAuthConfigured,
  prepareGoogleOAuth,
} from '../google-oauth'

// Google and Slack accept credentials via options, so we can test them directly.
// Microsoft reads MICROSOFT_OAUTH_CLIENT_ID from env at module load — skip if not set.

const TEST_CREDS = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
}

describe('callbackUrl support in OAuth prepare functions', () => {
  describe('Google OAuth', () => {
    it('configures public desktop clients from a client ID alone', () => {
      expect(isGoogleOAuthConfigured('public-client-id')).toBe(true)
      const result = prepareGoogleOAuth({
        callbackPort: 6477,
        clientId: 'public-client-id',
      })
      expect(result.clientSecret).toBeUndefined()
      expect(result.authUrl).not.toContain('client_secret')
    })

    it('omits client_secret from public-client token requests', () => {
      const exchange = buildGoogleAuthorizationCodeTokenParams({
        client_id: 'public-client-id',
        code: 'authorization-code',
        code_verifier: 'pkce-verifier',
        grant_type: 'authorization_code',
        redirect_uri: 'http://127.0.0.1:6477/callback',
      })
      const refresh = buildGoogleRefreshTokenParams({
        client_id: 'public-client-id',
        grant_type: 'refresh_token',
        refresh_token: 'refresh-token',
      })

      expect(exchange.has('client_secret')).toBe(false)
      expect(refresh.has('client_secret')).toBe(false)
    })

    it('uses callbackUrl when provided', () => {
      const result = prepareGoogleOAuth({
        callbackUrl: 'https://my-server.com/api/oauth/callback',
        ...TEST_CREDS,
      })
      expect(result.redirectUri).toBe('https://my-server.com/api/oauth/callback')
      expect(result.authUrl).toContain('redirect_uri=https%3A%2F%2Fmy-server.com%2Fapi%2Foauth%2Fcallback')
    })

    it('falls back to callbackPort when callbackUrl not provided', () => {
      const result = prepareGoogleOAuth({ callbackPort: 6477, ...TEST_CREDS })
      expect(result.redirectUri).toBe('http://localhost:6477/callback')
    })

    it('callbackUrl takes precedence over callbackPort', () => {
      const result = prepareGoogleOAuth({
        callbackPort: 6477,
        callbackUrl: 'https://my-server.com/api/oauth/callback',
        ...TEST_CREDS,
      })
      expect(result.redirectUri).toBe('https://my-server.com/api/oauth/callback')
    })
  })
})
