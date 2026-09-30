import { afterEach, describe, expect, it } from 'bun:test';
import { CLAUDE_OAUTH_CONFIG } from './claude-oauth-config.ts';
import { clearOAuthState, exchangeClaudeCode, prepareClaudeOAuth } from './claude-oauth.ts';
import { refreshClaudeToken } from './claude-token.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOAuthState();
});

describe('Claude OAuth contract', () => {
  it('requests the complete scope set used by the pinned Pi SDK', () => {
    const url = new URL(prepareClaudeOAuth());

    expect(url.origin + url.pathname).toBe(CLAUDE_OAUTH_CONFIG.AUTH_URL);
    expect(url.searchParams.get('client_id')).toBe(CLAUDE_OAUTH_CONFIG.CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CLAUDE_OAUTH_CONFIG.REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe(
      'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('exchanges a code with PKCE and preserves optional identity fields', async () => {
    prepareClaudeOAuth();
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(CLAUDE_OAUTH_CONFIG.TOKEN_URL);
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body.grant_type).toBe('authorization_code');
      expect(body.client_id).toBe(CLAUDE_OAUTH_CONFIG.CLIENT_ID);
      expect(body.client_secret).toBeUndefined();
      expect(body.code).toBe('authorization-code');
      expect(body.code_verifier).toBeTruthy();
      expect(body.state).toBeTruthy();
      return Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        scope: 'user:inference user:profile',
        account: { uuid: 'account-id', email_address: 'user@example.test' },
        organization: { uuid: 'org-id', name: 'Organization' },
      });
    }) as typeof fetch;

    const tokens = await exchangeClaudeCode('authorization-code#ignored-fragment');
    expect(tokens.accessToken).toBe('access-token');
    expect(tokens.refreshToken).toBe('refresh-token');
    expect(tokens.account).toEqual({ uuid: 'account-id', emailAddress: 'user@example.test' });
    expect(tokens.organization).toEqual({ uuid: 'org-id', name: 'Organization' });
  });

  it('refreshes with JSON, keeps the old token without rotation, and rejects missing access tokens', async () => {
    let responseBody: Record<string, unknown> = {
      access_token: 'new-access-token',
      expires_in: 3600,
    };
    globalThis.fetch = (async (_input, init) => {
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh-token',
        client_id: CLAUDE_OAUTH_CONFIG.CLIENT_ID,
      });
      return Response.json(responseBody);
    }) as typeof fetch;

    const refreshed = await refreshClaudeToken('old-refresh-token');
    expect(refreshed.accessToken).toBe('new-access-token');
    expect(refreshed.refreshToken).toBe('old-refresh-token');

    responseBody = { expires_in: 3600 };
    await expect(refreshClaudeToken('old-refresh-token')).rejects.toThrow('no access_token');
  });
});
