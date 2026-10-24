import { isApiOAuthProvider } from './provider-inference.ts';
import type { LoadedSource } from './source-resources.ts';

/**
 * Check if a source uses OAuth authentication (for proactive token refresh).
 *
 * Returns true for:
 * - MCP sources with authType: 'oauth'
 * - API sources with OAuth providers (google, slack, microsoft)
 */
export function isOAuthSource(source: LoadedSource): boolean {
  // MCP OAuth sources
  if (source.config.type === 'mcp') {
    return source.config.mcp?.authType === 'oauth';
  }

  // API OAuth sources (Google, Slack, Microsoft)
  if (source.config.type === 'api') {
    if (isApiOAuthProvider(source.config.provider)) return true;
    // Generic OAuth API sources (e.g. GitHub, Linear)
    if (isGenericOAuthSource(source)) return true;
  }

  return false;
}

/**
 * Check if a source uses generic OAuth (not Google/Slack/Microsoft provider-specific).
 * Matches API sources with authType 'oauth' — either explicit oauth config block
 * or auto-discovery from baseUrl via RFC 9728/8414.
 */
export function isGenericOAuthSource(source: LoadedSource): boolean {
  return (
    source.config.type === 'api' &&
    source.config.api?.authType === 'oauth' &&
    !isApiOAuthProvider(source.config.provider)
  );
}

/**
 * Check if an API source has a token renew endpoint configured.
 */
export function hasRenewEndpoint(source: LoadedSource): boolean {
  return source.config.type === 'api' && !!source.config.api?.renewEndpoint?.path;
}

/**
 * Check if a source can auto-refresh its token.
 * Returns true for OAuth sources OR sources with a renewEndpoint.
 *
 * Use this as the single guard for "can this source refresh?" instead of
 * sprinkling provider/authType/renewEndpoint checks in multiple places.
 */
export function isRefreshableSource(source: LoadedSource): boolean {
  return isOAuthSource(source) || hasRenewEndpoint(source);
}
