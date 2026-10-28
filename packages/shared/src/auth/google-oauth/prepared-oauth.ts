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
import { type GoogleService } from "../../sources/types.ts";
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from "../oauth-flow-types.ts";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, resolveGoogleOAuthClient } from './oauth-contracts.ts';
import { exchangeCodeForTokens, generatePKCE, generateState, getUserEmail } from './token-exchange.ts';
import { getGoogleScopes, isGoogleOAuthConfigured } from './token-refresh.ts';

/**
 * Options for preparing a Google OAuth flow (server-side, no browser interaction)
 */
export interface PrepareGoogleOAuthOptions {
  service?: GoogleService;
  scopes?: string[];
  /** Port for the local callback server (Electron). One of callbackPort or callbackUrl required. */
  callbackPort?: number;
  /** Full callback URL (WebUI). Takes precedence over callbackPort. */
  callbackUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Prepare a Google OAuth flow without starting a callback server or opening a browser.
 * Returns everything needed to construct the auth URL and later exchange the code.
 */
export function prepareGoogleOAuth(options: PrepareGoogleOAuthOptions): PreparedOAuthFlow {
  const resolvedClient = resolveGoogleOAuthClient(options.clientId, options.clientSecret);
  const clientId = resolvedClient.clientId;
  const clientSecret = resolvedClient.clientSecret;

  if (!isGoogleOAuthConfigured(clientId)) {
    throw new Error(
      'Google OAuth not configured. Provide clientId in source config or set ' +
      'GOOGLE_OAUTH_CLIENT_ID. Desktop clients use PKCE and must not embed a client secret.'
    );
  }

  const scopes = getGoogleScopes(options);
  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}/callback`;

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: GOOGLE_TOKEN_URL,
    clientId,
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    redirectUri,
    provider: 'google',
  };
}

/**
 * Exchange a Google authorization code for tokens (server-side).
 * Also fetches the user's email address.
 */
export async function exchangeGoogleOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeCodeForTokens(
      params.code,
      params.codeVerifier,
      params.redirectUri,
      params.clientId,
      params.clientSecret
    );

    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresIn ? { expiresAt: Date.now() + tokens.expiresIn * 1000 } : {}),
      email,
      oauthClientId: params.clientId,
      ...(params.clientSecret !== undefined ? { oauthClientSecret: params.clientSecret } : {}),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Google OAuth exchange failed',
    };
  }
}
