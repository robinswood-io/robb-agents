import { type AppType } from "../callback-server.ts";
import { type GoogleService } from "../../sources/types.ts";
import { type OAuthSessionContext } from "../types.ts";

// Google OAuth configuration - environment variables used as fallback.
// Installed apps are public OAuth clients and authenticate with PKCE, not an
// embedded secret. A client secret remains optional for confidential WebUI
// deployments or explicit user-owned source configurations.
const GOOGLE_CLIENT_ID_ENV = process.env["GOOGLE_OAUTH_CLIENT_ID"] || '';

const GOOGLE_CLIENT_SECRET_ENV = process.env["GOOGLE_OAUTH_CLIENT_SECRET"] || '';

export function resolveGoogleOAuthClient(
  clientId?: string,
  clientSecret?: string,
): { clientId: string; clientSecret?: string } {
  const explicitClientId = clientId?.trim();
  const explicitClientSecret = clientSecret?.trim();
  const resolvedSecret = explicitClientSecret || (explicitClientId ? undefined : GOOGLE_CLIENT_SECRET_ENV.trim() || undefined);
  return {
    clientId: explicitClientId || GOOGLE_CLIENT_ID_ENV.trim(),
    ...(resolvedSecret !== undefined ? { clientSecret: resolvedSecret } : {}),
  };
}

// Google OAuth endpoints
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * Predefined scope sets for common Google services
 */
export const GOOGLE_SERVICE_SCOPES: Record<GoogleService, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify', // Read, trash, labels, mark read/unread
    'https://www.googleapis.com/auth/gmail.compose', // Create and send drafts
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar', // Full calendar access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  drive: [
    'https://www.googleapis.com/auth/drive', // Full Drive access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  docs: [
    'https://www.googleapis.com/auth/documents', // Full Docs access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  sheets: [
    'https://www.googleapis.com/auth/spreadsheets', // Full Sheets access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  youtube: [
    'https://www.googleapis.com/auth/youtube.readonly', // Read channel, video, playlist data
    'https://www.googleapis.com/auth/youtube.force-ssl', // Manage content (comments, playlists, etc.)
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  searchconsole: [
    'https://www.googleapis.com/auth/webmasters.readonly', // Read Search Console data
    'https://www.googleapis.com/auth/userinfo.email',
  ],
};

/**
 * Options for starting Google OAuth flow
 */
export interface GoogleOAuthOptions {
  /** Google service to authenticate (uses predefined scopes) */
  service?: GoogleService;
  /** Custom scopes (overrides service scopes if provided) */
  scopes?: string[];
  /** App type for callback server styling */
  appType?: AppType;
  /** OAuth client ID (user-provided, falls back to env var) */
  clientId?: string;
  /** Optional OAuth client secret for confidential WebUI clients */
  clientSecret?: string;
  /** Session context for building deeplink back to chat after OAuth */
  sessionContext?: OAuthSessionContext;
}

/**
 * Result of Google OAuth flow
 */
export interface GoogleOAuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  error?: string;
  /** OAuth client ID used (for storage alongside tokens) */
  clientId?: string;
  /** Optional confidential-client secret used by WebUI deployments */
  clientSecret?: string;
}
