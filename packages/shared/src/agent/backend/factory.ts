/** Backend creation: provider registry, connection resolution, models and probes. */
export { detectProvider, createBackend, createAgent, createBackendFromResolvedContext, initializeBackendHostRuntime, resolveBackendHostTooling, createBackendFromConnection } from './factory/provider-registry.ts';
export { getAvailableProviders, isProviderAvailable, providerTypeToAgentProvider, connectionTypeToProvider, connectionAuthTypeToBackendAuthType, BACKEND_CAPABILITIES, getDefaultAuthType } from './factory/provider-policy.ts';
export type { ResolvedBackendContext } from './factory/connection-context.ts';
export { resolveSessionConnection, resolveBackendContext, resolveSetupTestConnectionHint } from './factory/connection-context.ts';
export { fetchBackendModels, validateStoredBackendConnection } from './factory/connection-models-fetch-backend-models.ts';
export { createConfigFromConnection, resolveModelForProvider } from './factory/connection-models.ts';
export { cleanupSourceRuntimeArtifacts, testBackendConnection, validateConnection } from './factory/connection-test.ts';
