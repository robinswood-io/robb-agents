/** Direct modules grouped by responsibility; declaration bodies and public exports preserved. */
export type { OAuthConfig, OAuthTokens, OAuthCallbacks, OAuthMetadata } from './oauth/contracts.ts';
export { CraftOAuth } from './oauth/oauth-client.ts';
export { prepareMcpOAuth, exchangeMcpOAuth, getMcpBaseUrl } from './oauth/mcp-client.ts';
export { discoverOAuthMetadata } from './oauth/discovery.ts';
