import { describe, expect, it } from 'bun:test';
import {
  loadGoogleGeminiOAuthCredentials,
  prepareGoogleGeminiOAuth,
} from './google-gemini-oauth.ts';

describe('Google Gemini OAuth credentials', () => {
  it('fails closed when host credentials are absent', () => {
    expect(() => loadGoogleGeminiOAuthCredentials({})).toThrow(
      'Google Gemini OAuth requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET',
    );
  });

  it('uses injected credentials without exposing the client secret in the authorization URL', () => {
    const credentials = {
      clientId: 'test-client.apps.googleusercontent.com',
      clientSecret: 'test-client-secret-value',
    };
    const prepared = prepareGoogleGeminiOAuth('http://127.0.0.1:1457/oauth2callback', credentials);
    const authorizationUrl = new URL(prepared.authUrl);

    expect(authorizationUrl.searchParams.get('client_id')).toBe(credentials.clientId);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(prepared.authUrl).not.toContain(credentials.clientSecret);
  });
});
