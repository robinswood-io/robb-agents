import { afterEach, describe, expect, it } from 'bun:test';
import { CHATGPT_OAUTH_CONFIG } from './chatgpt-oauth-config.ts';
import {
  exchangeChatGptTokens,
  prepareChatGptOAuth,
  refreshChatGptTokens,
} from './chatgpt-oauth.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ChatGPT OAuth contract', () => {
  it('matches the current Codex authorization URL contract', () => {
    const flow = prepareChatGptOAuth();
    const url = new URL(flow.authUrl);

    expect(url.origin + url.pathname).toBe(CHATGPT_OAUTH_CONFIG.AUTH_URL);
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_OAUTH_CONFIG.CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CHATGPT_OAUTH_CONFIG.REDIRECT_URI);
    expect(url.searchParams.get('scope')).toBe(
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
    );
    expect(url.searchParams.get('originator')).toBe('codex_cli_rs');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('state')).toBe(flow.state);
    expect(flow.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('exchanges an authorization code as a public PKCE client', async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe(CHATGPT_OAUTH_CONFIG.TOKEN_URL);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe(CHATGPT_OAUTH_CONFIG.CLIENT_ID);
      expect(body.get('client_secret')).toBeNull();
      expect(body.get('code')).toBe('authorization-code');
      expect(body.get('code_verifier')).toBe('code-verifier');
      expect(body.get('redirect_uri')).toBe(CHATGPT_OAUTH_CONFIG.REDIRECT_URI);
      return Response.json({
        id_token: 'id-token',
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      });
    }) as typeof fetch;

    const tokens = await exchangeChatGptTokens('authorization-code', 'code-verifier');
    expect(tokens.idToken).toBe('id-token');
    expect(tokens.accessToken).toBe('access-token');
    expect(tokens.refreshToken).toBe('refresh-token');
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it('uses refresh-token rotation and rejects incomplete success responses', async () => {
    let responseBody: Record<string, unknown> = {
      id_token: 'new-id-token',
      access_token: 'new-access-token',
      refresh_token: 'rotated-refresh-token',
      expires_in: 3600,
    };
    globalThis.fetch = (async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-refresh-token');
      expect(body.get('client_id')).toBe(CHATGPT_OAUTH_CONFIG.CLIENT_ID);
      return Response.json(responseBody);
    }) as typeof fetch;

    const refreshed = await refreshChatGptTokens('old-refresh-token');
    expect(refreshed.refreshToken).toBe('rotated-refresh-token');

    responseBody = { access_token: 'missing-id-token' };
    await expect(refreshChatGptTokens('old-refresh-token')).rejects.toThrow(
      'required token fields were missing',
    );
  });
});
