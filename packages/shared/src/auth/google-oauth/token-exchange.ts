import { randomBytes, createHash } from "crypto";
import { GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL } from './oauth-contracts.ts';

/**
 * Generate PKCE code verifier and challenge
 */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate random state for CSRF protection
 */
export function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret?: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const params = buildGoogleAuthorizationCodeTokenParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    client_secret: clientSecret,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

interface GoogleAuthorizationCodeTokenInput {
  client_id: string;
  code: string;
  code_verifier: string;
  grant_type: 'authorization_code';
  redirect_uri: string;
  client_secret?: string;
}

interface GoogleRefreshTokenInput {
  client_id: string;
  grant_type: 'refresh_token';
  refresh_token: string;
  client_secret?: string;
}

export function buildGoogleAuthorizationCodeTokenParams(
  input: GoogleAuthorizationCodeTokenInput,
): URLSearchParams {
  const params = new URLSearchParams({
    client_id: input.client_id,
    code: input.code,
    code_verifier: input.code_verifier,
    grant_type: input.grant_type,
    redirect_uri: input.redirect_uri,
  });
  if (input.client_secret?.trim()) params.set('client_secret', input.client_secret.trim());
  return params;
}

export function buildGoogleRefreshTokenParams(input: GoogleRefreshTokenInput): URLSearchParams {
  const params = new URLSearchParams({
    client_id: input.client_id,
    grant_type: input.grant_type,
    refresh_token: input.refresh_token,
  });
  if (input.client_secret?.trim()) params.set('client_secret', input.client_secret.trim());
  return params;
}

/**
 * Get user email from access token
 */
export async function getUserEmail(accessToken: string): Promise<string> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  const data = (await response.json()) as { email: string };
  return data.email;
}
