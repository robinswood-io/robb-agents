/** LLM connection types, model selection, authentication and legacy migration. */
export type { LlmProviderType, LlmConnectionType, LlmAuthType, ModelSelectionMode, CustomEndpointApi, CustomEndpointConfig, MidStreamBehavior, LlmConnection, LlmConnectionWithStatus } from './llm-connections/connection-types.ts';
export { registerPiModelResolver } from './llm-connections/connection-types.ts';
export { isModelAllowedForAuthProvider, isDeniedMiniModelId, getMiniModel } from './llm-connections/model-selection.ts';
export type { LlmCredentialStorageType } from './llm-connections/credential-identity.ts';
export { generateSlug, isValidSlug, getLlmCredentialKey, authTypeToCredentialStorageType, authTypeToCredentialType, authTypeRequiresEndpoint } from './llm-connections/credential-identity.ts';
export { isCompatProvider, isAnthropicProvider, isLocalConnection, isPiProvider, defaultMidStreamBehavior, resolveMidStreamBehavior } from './llm-connections/provider-policy.ts';
export { setModelSupportsImages, modelSupportsImages, getModelsForProviderType } from './llm-connections/model-capabilities.ts';
export { PI_PREFERRED_DEFAULTS, getDefaultModelsForConnection, getDefaultModelForConnection, resolveEffectiveConnectionSlug, isSessionConnectionUnavailable } from './llm-connections/default-models.ts';
export { authTypeIsOAuth, isValidProviderAuthCombination } from './llm-connections/auth-policy.ts';
export { deriveBedrockRegionPrefix, toBedrockNativeId, fromBedrockNativeId, normalizeBedrockModelId } from './llm-connections/bedrock-models.ts';
export { migrateConnectionType, migrateAuthType } from './llm-connections/legacy-types.ts';
export type { ResolvedAuthEnvVars } from './llm-connections/auth-environment.ts';
export { clearClaudeBedrockRoutingEnvVars, resetManagedAnthropicAuthEnvVars, resolveAuthEnvVars, migrateLlmConnection } from './llm-connections/auth-environment.ts';
