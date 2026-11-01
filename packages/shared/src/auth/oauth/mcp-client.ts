import { URL } from "url";
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from "../oauth-flow-types.ts";
import type { OAuthTokens } from './contracts.ts';
import { CALLBACK_PATH, CLIENT_NAME, generatePKCE, generateState } from './contracts.ts';
import { discoverOAuthMetadata } from './discovery.ts';

/**
 * Register an MCP OAuth client dynamically.
 * Extracted from CraftOAuth.registerClient for reuse in prepareMcpOAuth.
 */
class McpClientRegistrationError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'McpClientRegistrationError';
    if (status === undefined) { delete this.status } else { this.status = status }
  }
}

function shouldFallbackToDefaultMcpClient(error: unknown): boolean {
  return error instanceof McpClientRegistrationError && (error.status === 401 || error.status === 403);
}

async function registerMcpOAuthClient(
  registrationEndpoint: string,
  redirectUri: string
): Promise<{ client_id: string; client_secret?: string }> {
  let response: Response;
  try {
    response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpClientRegistrationError(`Failed to register OAuth client: ${message}`);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new McpClientRegistrationError(`Failed to register OAuth client: ${error}`, response.status);
  }

  return response.json() as Promise<{ client_id: string; client_secret?: string }>;
}

/**
 * Exchange an MCP authorization code for tokens (standalone, no class instance needed).
 */
async function exchangeMcpCodeForTokens(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${error}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const expiresIn = data.expires_in ?? 3600;

  return {
    accessToken: data.access_token,
    ...(data.refresh_token !== undefined ? { refreshToken: data.refresh_token } : {}),
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: data.token_type || 'Bearer',
  };
}

/**
 * Prepare an MCP OAuth flow without starting a callback server or opening a browser.
 *
 * Performs metadata discovery, PKCE generation, optional client registration,
 * and auth URL construction. Accepts either callbackPort (Electron) or
 * callbackUrl (WebUI) to construct the redirect URI.
 */
export async function prepareMcpOAuth(
  mcpUrl: string,
  options: { callbackPort?: number; callbackUrl?: string },
): Promise<PreparedOAuthFlow> {
  const metadata = await discoverOAuthMetadata(mcpUrl);
  if (!metadata) {
    throw new Error(`No OAuth metadata found for ${mcpUrl}`);
  }

  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}${CALLBACK_PATH}`;

  let clientId: string;
  let clientSecret: string | undefined;
  if (metadata.registration_endpoint) {
    try {
      const client = await registerMcpOAuthClient(metadata.registration_endpoint, redirectUri);
      clientId = client.client_id;
      clientSecret = client.client_secret;
    } catch (error) {
      if (!shouldFallbackToDefaultMcpClient(error)) {
        throw error;
      }

      // Dynamic client registration can be intentionally gated by providers
      // (for example returning 403 for unapproved clients). In that case,
      // fall back to a default client ID and proceed with the flow.
      clientId = 'craft-agent';
    }
  } else {
    clientId = 'craft-agent';
  }

  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: metadata.token_endpoint,
    clientId,
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    redirectUri,
    provider: 'mcp',
  };
}

/**
 * Exchange an MCP authorization code for tokens (server-side).
 */
export async function exchangeMcpOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeMcpCodeForTokens(
      params.tokenEndpoint,
      params.code,
      params.codeVerifier,
      params.clientId,
      params.redirectUri
    );

    return {
      success: true,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
      oauthClientId: params.clientId,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'MCP OAuth exchange failed',
    };
  }
}

/**
 * Extract the origin (scheme + host + port) from an MCP URL.
 * This is the base URL for OAuth discovery per RFC 8414.
 */
export function getMcpBaseUrl(mcpUrl: string): string {
  try {
    return new URL(mcpUrl).origin;
  } catch {
    // If URL parsing fails, return as-is and let caller handle it
    return mcpUrl;
  }
}
