/**
 * Google OAuth flow using Google's OAuth 2.0 with PKCE
 *
 * This module handles the complete Google OAuth flow for any Google API:
 * 1. Opens browser for Google consent screen
 * 2. Receives authorization code via local callback server
 * 3. Exchanges code for access and refresh tokens
 * 4. Returns tokens and user email
 *
 * Supports multiple Google services (Gmail, Calendar, Drive) with predefined
 * scope sets, or custom scopes for other Google APIs.
 */
import { URL } from "url";
import { openUrl } from "../../utils/open-url.ts";
import { createCallbackServer } from "../callback-server.ts";
import { buildOAuthDeeplinkUrl } from "../types.ts";
import type { GoogleOAuthOptions, GoogleOAuthResult } from './oauth-contracts.ts';
import { GOOGLE_AUTH_URL, resolveGoogleOAuthClient } from './oauth-contracts.ts';
import { exchangeCodeForTokens, generatePKCE, generateState, getUserEmail } from './token-exchange.ts';
import { getGoogleScopes, isGoogleOAuthConfigured } from './token-refresh.ts';

/**
 * Start Google OAuth flow
 *
 * Opens browser for Google consent, handles callback, and returns tokens + email.
 * Supports multiple Google services via the service option, or custom scopes.
 *
 * @example
 * // Authenticate for Gmail
 * const result = await startGoogleOAuth({ service: 'gmail' });
 *
 * @example
 * // Authenticate for Google Calendar
 * const result = await startGoogleOAuth({ service: 'calendar' });
 *
 * @example
 * // Authenticate with custom scopes
 * const result = await startGoogleOAuth({
 *   scopes: ['https://www.googleapis.com/auth/spreadsheets']
 * });
 */
export async function startGoogleOAuth(
  options: GoogleOAuthOptions = {}
): Promise<GoogleOAuthResult> {
  try {
    // Resolve credentials: use provided values or fall back to env vars
    const resolvedClient = resolveGoogleOAuthClient(options.clientId, options.clientSecret);
    const clientId = resolvedClient.clientId;
    const clientSecret = resolvedClient.clientSecret;

    // Verify the public OAuth client ID is configured.
    if (!isGoogleOAuthConfigured(clientId)) {
      return {
        success: false,
        error:
          'Google OAuth not configured. Provide clientId in source config or set ' +
          'GOOGLE_OAUTH_CLIENT_ID. Desktop clients use PKCE and must not embed a client secret.',
      };
    }

    // Get scopes for this request
    const scopes = getGoogleScopes(options);

    // Generate PKCE and state
    const pkce = generatePKCE();
    const state = generateState();

    // Start callback server with deeplink for returning to chat session
    const appType = options.appType || 'electron';
    const deeplinkUrl = buildOAuthDeeplinkUrl(options.sessionContext);
    const callbackServer = await createCallbackServer({ appType, deeplinkUrl });
    const redirectUri = `${callbackServer.url}/callback`;

    // Build authorization URL
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline'); // Request refresh token
    authUrl.searchParams.set('prompt', 'consent'); // Always show consent to get refresh token

    // Open browser for authorization
    await openUrl(authUrl.toString());

    // Wait for callback
    const callback = await callbackServer.promise;

    // Verify state
    if (callback.query.state !== state) {
      return {
        success: false,
        error: 'OAuth state mismatch - possible CSRF attack',
      };
    }

    // Check for error
    if (callback.query.error) {
      const isAccessBlocked =
        callback.query.error === 'access_denied' &&
        String(callback.query.error_description ?? '').toLowerCase().includes('verif');
      const error = isAccessBlocked
        ? 'Google has blocked this app (not yet verified).\n\n' +
          'To fix this, add your own Google OAuth credentials to the source config:\n' +
          '  "googleOAuthClientId": "..."\n\n' +
          'See: https://console.cloud.google.com/apis/credentials'
        : callback.query.error_description || callback.query.error;
      return { success: false, error };
    }

    // Get authorization code
    const code = callback.query.code;
    if (!code) {
      return {
        success: false,
        error: 'No authorization code received',
      };
    }

    // Exchange the code with PKCE. A secret is sent only for an explicitly
    // configured confidential WebUI client, never from the desktop build.
    const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri, clientId, clientSecret);

    // Get user email
    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
      // Return credentials so they can be stored for token refresh
      clientId,
      clientSecret,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during Google OAuth',
    };
  }
}
