import type { ApiAuthType, GoogleService, MicrosoftService, SlackService } from './provider-inference.ts';

/**
 * API test endpoint configuration for connection validation
 */
export interface ApiTestEndpoint {
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>; // For POST requests
  headers?: Record<string, string>; // Custom headers for the test request
}

/**
 * Generic OAuth configuration for API sources.
 * Allows any OAuth 2.0 provider to be configured via config.json
 * without needing an MCP server or manual PAT.
 */
export interface ApiOAuthConfig {
  /** OAuth authorization endpoint URL (REQUIRED) */
  authorizationUrl: string;
  /** OAuth token exchange endpoint URL (REQUIRED) */
  tokenUrl: string;
  /** OAuth client ID (REQUIRED) */
  clientId: string;
  /** OAuth client secret (optional for public PKCE clients) */
  clientSecret?: string;
  /** Requested OAuth scopes */
  scopes?: string[];
  /** Auth0-style audience parameter */
  audience?: string;
  /** Additional parameters to include in the authorization URL */
  extraParams?: Record<string, string>;
}

/**
 * Token renewal endpoint configuration for non-OAuth API sources.
 * Allows custom bearer-token APIs to auto-renew expired tokens by calling
 * a provider-specific endpoint (not OAuth-compliant).
 *
 * MVP scope: access-token-based renewal only. The current access token is
 * sent via the Authorization header and/or substituted into body/headers
 * using the {{token}} placeholder.
 */
export interface ApiRenewEndpoint {
  /** Renew URL — relative path (resolved against baseUrl) or absolute URL */
  path: string;
  /** HTTP method (default: POST) */
  method?: 'GET' | 'POST';
  /** Request body — {{token}} in string leaves is substituted with current access token.
   *  Supports nested objects (recursive substitution on string leaves). */
  body?: Record<string, unknown>;
  /** Extra headers for the renew request — {{token}} substitution applies here too.
   *  Merged on top of defaultHeaders. Authorization header is always sent unless
   *  explicitly overridden here. */
  headers?: Record<string, string>;
  /** JSON field name for the new access token in response (default: "access_token") */
  tokenField?: string;
  /** JSON field name for expiry in seconds in response (default: "expires_in") */
  expiresInField?: string;
  /** Fallback TTL in seconds when renew response doesn't include expiry (optional).
   *  Without this, missing expiry causes refresh on every session start (safe but noisy). */
  fallbackTtlSecs?: number;
}

/**
 * API-specific configuration
 */
export interface ApiSourceConfig {
  baseUrl: string;
  authType: ApiAuthType;
  headerName?: string; // For 'header' auth (e.g., "X-API-Key")
  headerNames?: string[]; // For multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])
  queryParam?: string; // For 'query' auth (e.g., "api_key")
  authScheme?: string; // For 'bearer' auth (default: "Bearer", could be "Token")
  defaultHeaders?: Record<string, string>; // Headers to include with every request
  testEndpoint?: ApiTestEndpoint; // Endpoint to use for connection testing
  renewEndpoint?: ApiRenewEndpoint; // Optional token renewal endpoint for non-OAuth sources

  // Google OAuth fields (used when provider is 'google')
  googleService?: GoogleService; // Predefined service for scope selection
  googleScopes?: string[]; // Custom scopes (overrides googleService)
  // User-provided OAuth credentials (for OSS users who create their own Google Cloud project)
  googleOAuthClientId?: string; // User's Google OAuth Client ID
  googleOAuthClientSecret?: string; // User's Google OAuth Client Secret

  // Slack OAuth fields (used when provider is 'slack')
  // Uses user_scope for user authentication (posts as the user, not a bot)
  slackService?: SlackService; // Predefined service for scope selection
  slackUserScopes?: string[]; // Custom user scopes (overrides slackService)

  // Microsoft OAuth fields (used when provider is 'microsoft')
  microsoftService?: MicrosoftService; // Predefined service for scope selection
  microsoftScopes?: string[]; // Custom scopes (overrides microsoftService)

  // Generic OAuth config (used when authType is 'oauth' and provider is not google/slack/microsoft)
  oauth?: ApiOAuthConfig;
}
