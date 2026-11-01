import type { GoogleOAuthOptions } from './oauth-contracts.ts';
import { GOOGLE_SERVICE_SCOPES, GOOGLE_TOKEN_URL, resolveGoogleOAuthClient } from './oauth-contracts.ts';
import { buildGoogleRefreshTokenParams } from './token-exchange.ts';

/**
 * Refresh Google access token using refresh token
 *
 * @param refreshToken - The refresh token from initial OAuth
 * @param clientId - OAuth client ID (falls back to env var if not provided)
 * @param clientSecret - Optional secret for confidential WebUI clients
 */
export async function refreshGoogleToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string
): Promise<{
  accessToken: string;
  expiresAt?: number;
}> {
  const resolvedClient = resolveGoogleOAuthClient(clientId, clientSecret);
  const id = resolvedClient.clientId;
  const secret = resolvedClient.clientSecret;

  if (!id) {
    throw new Error(
      'Google OAuth client ID not available for token refresh. ' +
        'The client ID must be stored with the token or set via GOOGLE_OAUTH_CLIENT_ID.'
    );
  }

  const params = buildGoogleRefreshTokenParams({
    client_id: id,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    ...(secret !== undefined ? { client_secret: secret } : {}),
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error('Failed to refresh Google token');
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    ...(data.expires_in ? { expiresAt: Date.now() + data.expires_in * 1000 } : {}),
  };
}

/**
 * Check if Google OAuth is configured (a public client ID is available)
 *
 * @param clientId - Optional user-provided client ID
 * @param _clientSecret - Kept for source-config API compatibility; not required for PKCE
 * @returns true if a client ID is available (provided or from the environment)
 */
export function isGoogleOAuthConfigured(clientId?: string, _clientSecret?: string): boolean {
  return Boolean(resolveGoogleOAuthClient(clientId).clientId);
}

/**
 * Get scopes for a Google service or use custom scopes
 */
export function getGoogleScopes(options: GoogleOAuthOptions): string[] {
  // Custom scopes take precedence
  if (options.scopes && options.scopes.length > 0) {
    // Ensure userinfo.email is included for email retrieval
    const emailScope = 'https://www.googleapis.com/auth/userinfo.email';
    if (!options.scopes.includes(emailScope)) {
      return [...options.scopes, emailScope];
    }
    return options.scopes;
  }

  // Use predefined service scopes
  if (options.service && options.service in GOOGLE_SERVICE_SCOPES) {
    return GOOGLE_SERVICE_SCOPES[options.service];
  }

  // Default to Gmail scopes for backwards compatibility
  return GOOGLE_SERVICE_SCOPES.gmail;
}
