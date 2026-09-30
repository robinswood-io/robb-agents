import { describe, expect, it } from 'bun:test';
import { redactSecretLikeMaterial } from '../redaction.ts';

describe('redactSecretLikeMaterial OAuth material', () => {
  it('redacts OAuth callback parameters while retaining non-sensitive routing context', () => {
    const authorizationCode = 'authorization-code-value';
    const oauthState = 'oauth-state-value';
    const input = `robb://auth-callback?code=${authorizationCode}&state=${oauthState}&workspace=my-workspace`;

    const redacted = redactSecretLikeMaterial(input);

    expect(redacted).not.toContain(authorizationCode);
    expect(redacted).not.toContain(oauthState);
    expect(redacted).toContain('code=[REDACTED]');
    expect(redacted).toContain('state=[REDACTED]');
    expect(redacted).toContain('workspace=my-workspace');
  });

  it('redacts OAuth fragments and JSON-serialized verifier/token fields', () => {
    const accessToken = 'oauth-access-token-value';
    const idToken = 'oauth-id-token-value';
    const verifier = 'oauth-code-verifier-value';
    const authorizationCode = 'oauth-authorization-code-value';
    const input = [
      `https://example.test/callback#access_token=${accessToken}&id_token=${idToken}`,
      JSON.stringify({ code_verifier: verifier, authorization_code: authorizationCode }),
    ].join(' ');

    const redacted = redactSecretLikeMaterial(input);

    for (const secret of [accessToken, idToken, verifier, authorizationCode]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('access_token=[REDACTED]');
    expect(redacted).toContain('id_token=[REDACTED]');
    expect(redacted).toContain('"code_verifier":"[REDACTED]"');
    expect(redacted).toContain('"authorization_code":"[REDACTED]"');
  });

  it('redacts Microsoft identity and session artifacts carried beside the callback code', () => {
    const clientInfo = 'base64url-client-identity-value';
    const sessionState = 'session-correlation-value';
    const loginHint = 'person@example.test';
    const input = `https://login.example.test/callback#code=code-value&client_info=${clientInfo}&session_state=${sessionState}&login_hint=${loginHint}`;

    const redacted = redactSecretLikeMaterial(input);

    for (const sensitiveValue of [clientInfo, sessionState, loginHint]) {
      expect(redacted).not.toContain(sensitiveValue);
    }
    expect(redacted).toContain('client_info=[REDACTED]');
    expect(redacted).toContain('session_state=[REDACTED]');
    expect(redacted).toContain('login_hint=[REDACTED]');
  });

  it('does not hide ordinary non-URL application state and error codes', () => {
    const diagnostic = 'state=ready code=ERR_CONNECTION_RESET status_code=502';

    expect(redactSecretLikeMaterial(diagnostic)).toBe(diagnostic);
  });
});
