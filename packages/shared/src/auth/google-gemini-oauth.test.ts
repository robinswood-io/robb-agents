import { describe, expect, it } from 'bun:test';
import {
  buildGoogleGeminiCodeExchangeParams,
  buildGoogleGeminiRefreshParams,
  exchangeGoogleGeminiTokens,
  loadGoogleGeminiOAuthCredentials,
  prepareGoogleGeminiOAuth,
  refreshGoogleGeminiTokens,
} from './google-gemini-oauth.ts';

describe('Google Gemini OAuth credentials', () => {
  it('uses the official installed-app client credential when no host override is present', () => {
    const credentials = loadGoogleGeminiOAuthCredentials({});
    expect(credentials.clientId).toEndWith('.apps.googleusercontent.com');
    expect(credentials.clientSecret?.length).toBeGreaterThan(0);
  });

  it('uses an injected public client ID with PKCE', () => {
    const credentials = {
      clientId: 'test-client.apps.googleusercontent.com',
    };
    const prepared = prepareGoogleGeminiOAuth('http://127.0.0.1:1457/oauth2callback', credentials);
    const authorizationUrl = new URL(prepared.authUrl);

    expect(authorizationUrl.searchParams.get('client_id')).toBe(credentials.clientId);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl.searchParams.get('code_challenge')).not.toBe(prepared.codeVerifier);
  });

  it('sends the official public client credential during code exchange and refresh', () => {
    const credentials = loadGoogleGeminiOAuthCredentials({});
    const requests = [
      buildGoogleGeminiCodeExchangeParams(
        'code',
        'verifier',
        'http://127.0.0.1:1457/oauth2callback',
        credentials,
      ),
      buildGoogleGeminiRefreshParams('refresh-token', credentials),
    ];

    for (const params of requests) {
      expect(params.get('client_id')).toBe(credentials.clientId);
      expect(params.get('client_secret')).toBe(credentials.clientSecret ?? null);
    }
  });

  it('ignores a secret-only environment override that has no matching client ID', () => {
    const credentials = loadGoogleGeminiOAuthCredentials({
      GOOGLE_OAUTH_CLIENT_SECRET: 'unrelated-google-workspace-secret',
    });

    expect(credentials.clientId).toBe(loadGoogleGeminiOAuthCredentials({}).clientId);
    expect(credentials.clientSecret).not.toBe('unrelated-google-workspace-secret');
  });

  it('keeps PKCE-only custom clients secretless when no custom secret is configured', () => {
    const credentials = loadGoogleGeminiOAuthCredentials({
      GOOGLE_OAUTH_CLIENT_ID: 'custom-public-client.apps.googleusercontent.com',
    });

    expect(credentials.clientSecret).toBeUndefined();
    expect(buildGoogleGeminiRefreshParams('refresh-token', credentials).has('client_secret')).toBe(false);
  });

  it('uses a configured secret with a custom client for both token requests', () => {
    const credentials = loadGoogleGeminiOAuthCredentials({
      GOOGLE_OAUTH_CLIENT_ID: 'custom-client.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'custom-client-secret',
    });
    const requests = [
      buildGoogleGeminiCodeExchangeParams(
        'code',
        'verifier',
        'http://127.0.0.1:1457/oauth2callback',
        credentials,
      ),
      buildGoogleGeminiRefreshParams('refresh-token', credentials),
    ];

    for (const params of requests) {
      expect(params.get('client_secret')).toBe('custom-client-secret');
    }
  });

  it('threads the installed-app credential through live code and refresh request paths', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: string[] = [];
    globalThis.fetch = (async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      requestBodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await exchangeGoogleGeminiTokens('code', 'verifier');
      await refreshGoogleGeminiTokens('refresh-token');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBodies).toHaveLength(2);
    for (const body of requestBodies) {
      const params = new URLSearchParams(body);
      expect(params.get('client_secret')).toBe(loadGoogleGeminiOAuthCredentials({}).clientSecret ?? null);
    }
  });
});
