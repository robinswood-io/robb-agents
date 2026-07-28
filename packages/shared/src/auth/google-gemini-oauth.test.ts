import { describe, expect, it } from 'bun:test';
import {
  buildGoogleGeminiCodeExchangeParams,
  buildGoogleGeminiRefreshParams,
  loadGoogleGeminiOAuthCredentials,
  prepareGoogleGeminiOAuth,
} from './google-gemini-oauth.ts';

describe('Google Gemini OAuth credentials', () => {
  it('uses the public installed-app client when no host override is present', () => {
    expect(loadGoogleGeminiOAuthCredentials({}).clientId).toEndWith('.apps.googleusercontent.com');
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

  it('never sends a client secret during code exchange or refresh', () => {
    const credentials = { clientId: 'public-client.apps.googleusercontent.com' };
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
      expect(params.get('client_id')).toBe('public-client.apps.googleusercontent.com');
      expect(params.has('client_secret')).toBe(false);
    }
  });
});
