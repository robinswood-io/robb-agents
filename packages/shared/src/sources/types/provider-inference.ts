
/**
 * Source Types
 *
 * Sources are external data connections (MCP servers, APIs, local filesystems).
 * They replace the old "connections" concept with a more flexible, folder-based architecture.
 *
 * File structure:
 * ~/.craft-agent/workspaces/{workspaceId}/sources/{sourceSlug}/
 *   ├── config.json   - Source settings
 *   └── guide.md      - Usage guidelines + cached data (in YAML frontmatter)
 */



/**
 * Source types - how we connect to the source
 */
export type SourceType = 'mcp' | 'api' | 'local';

/**
 * MCP source authentication types (for individual source connections)
 * Note: Different from workspace McpAuthType which uses 'workspace_oauth' | 'workspace_bearer' | 'public'
 */
export type SourceMcpAuthType = 'oauth' | 'bearer' | 'none';

/**
 * API authentication types
 */
export type ApiAuthType = 'bearer' | 'header' | 'query' | 'basic' | 'oauth' | 'none';

/**
 * Google service types for OAuth scope selection
 */
export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets' | 'youtube' | 'searchconsole';

/**
 * Slack service types for OAuth scope selection
 */
export type SlackService = 'messaging' | 'channels' | 'users' | 'files' | 'full';

/**
 * Microsoft service types for OAuth scope selection
 */
export type MicrosoftService = 'outlook' | 'microsoft-calendar' | 'onedrive' | 'teams' | 'sharepoint';

/**
 * Infer Google service from API baseUrl.
 * Returns undefined if URL doesn't match a known Google API pattern.
 *
 * Uses proper URL parsing to avoid false positives from arbitrary path matching.
 */
export function inferGoogleServiceFromUrl(baseUrl: string | undefined): GoogleService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return undefined;
  }

  // Match by hostname (most reliable)
  if (hostname === 'calendar.googleapis.com') return 'calendar';
  if (hostname === 'drive.googleapis.com') return 'drive';
  if (hostname === 'gmail.googleapis.com') return 'gmail';
  if (hostname === 'docs.googleapis.com') return 'docs';
  if (hostname === 'sheets.googleapis.com') return 'sheets';
  if (hostname === 'youtube.googleapis.com') return 'youtube';
  if (hostname === 'searchconsole.googleapis.com' || hostname === 'webmasters.googleapis.com') return 'searchconsole';

  // Fallback: check path patterns only on googleapis.com domains
  if (hostname === 'www.googleapis.com' || hostname === 'googleapis.com') {
    if (pathname.startsWith('/calendar/')) return 'calendar';
    if (pathname.startsWith('/drive/')) return 'drive';
    if (pathname.startsWith('/gmail/')) return 'gmail';
    if (pathname.startsWith('/v1/documents') || pathname.startsWith('/documents/')) return 'docs';
    if (pathname.startsWith('/v4/spreadsheets') || pathname.startsWith('/spreadsheets/')) return 'sheets';
    if (pathname.startsWith('/youtube/')) return 'youtube';
    if (pathname.startsWith('/webmasters/')) return 'searchconsole';
  }

  return undefined;
}

/**
 * Infer Slack service from API baseUrl.
 * Returns 'full' by default if URL matches Slack API pattern.
 */
export function inferSlackServiceFromUrl(baseUrl: string | undefined): SlackService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
  } catch {
    return undefined;
  }

  // Match Slack API hostname
  if (hostname === 'slack.com' || hostname === 'api.slack.com') {
    return 'full'; // Default to full service for Slack
  }

  return undefined;
}

/**
 * Infer Microsoft service from API baseUrl.
 * Microsoft Graph API uses graph.microsoft.com for all services.
 * Returns undefined if service cannot be determined from URL path.
 */
export function inferMicrosoftServiceFromUrl(baseUrl: string | undefined): MicrosoftService | undefined {
  if (!baseUrl) return undefined;

  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(baseUrl);
    hostname = parsed.hostname.toLowerCase();
    pathname = parsed.pathname.toLowerCase();
  } catch {
    return undefined;
  }

  // Match Microsoft Graph API hostname
  if (hostname === 'graph.microsoft.com') {
    // Try to infer service from path
    if (pathname.includes('/me/messages') || pathname.includes('/me/mailfolders') || pathname.includes('/mail')) {
      return 'outlook';
    }
    if (pathname.includes('/me/calendar') || pathname.includes('/me/events')) {
      return 'microsoft-calendar';
    }
    if (pathname.includes('/me/drive') || pathname.includes('/drives')) {
      return 'onedrive';
    }
    if (pathname.includes('/teams') || pathname.includes('/chats')) {
      return 'teams';
    }
    if (pathname.includes('/sites')) {
      return 'sharepoint';
    }
    // Cannot determine service from generic Graph URL - require explicit microsoftService config
    return undefined;
  }

  // Match Outlook-specific API (legacy, but still used)
  if (hostname === 'outlook.office.com' || hostname === 'outlook.office365.com') {
    return 'outlook';
  }

  return undefined;
}

/**
 * Known providers for special handling (OAuth flows, icons, etc.)
 * These have well-known OAuth endpoints or special behavior.
 */
export type KnownProvider =
  | 'google' // Google APIs (Gmail, etc.) - uses Google OAuth
  | 'microsoft' // Microsoft APIs (Outlook, OneDrive, etc.) - uses Microsoft OAuth
  | 'linear' // Linear - standard MCP OAuth
  | 'github' // GitHub - standard MCP OAuth
  | 'notion' // Notion - standard MCP OAuth
  | 'slack' // Slack - standard MCP OAuth
  | 'exa';

// Exa search API

/**
 * API providers that use OAuth for authentication.
 * These providers store credentials as source_oauth and use SourceCredentialManager.
 */
export const API_OAUTH_PROVIDERS = ['google', 'microsoft', 'slack'] as const;

export type ApiOAuthProvider = typeof API_OAUTH_PROVIDERS[number];

/**
 * Check if a provider uses OAuth for API authentication
 */
export function isApiOAuthProvider(provider: string | undefined): provider is ApiOAuthProvider {
  return API_OAUTH_PROVIDERS.includes(provider as ApiOAuthProvider);
}
