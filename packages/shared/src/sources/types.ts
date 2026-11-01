/** Source contracts: provider inference, OAuth, MCP, API and folder resources. */
export type { SourceType, SourceMcpAuthType, ApiAuthType, GoogleService, SlackService, MicrosoftService, KnownProvider, ApiOAuthProvider } from './types/provider-inference.ts';
export { inferGoogleServiceFromUrl, inferSlackServiceFromUrl, inferMicrosoftServiceFromUrl, API_OAUTH_PROVIDERS, isApiOAuthProvider } from './types/provider-inference.ts';
export { isOAuthSource, isGenericOAuthSource, hasRenewEndpoint, isRefreshableSource } from './types/provider-inference-is-oauth-source.ts';
export type { McpTransport, McpPlatform, McpPlatformOverride, McpSourceConfig } from './types/mcp-config.ts';
export type { ApiTestEndpoint, ApiOAuthConfig, ApiRenewEndpoint, ApiSourceConfig } from './types/api-config.ts';
export type { LocalSourceConfig, SourceConnectionStatus, SourceBrand, FolderSourceConfig, SourceGuide, LoadedSource, CreateSourceInput, ApiConfig } from './types/source-resources.ts';
