/**
 * Agent Factory
 *
 * Creates the appropriate AI agent based on configuration.
 * Supports two agents:
 * - ClaudeAgent (Anthropic) - Default, using @anthropic-ai/claude-agent-sdk
 * - PiAgent (Pi) - Using @earendil-works/pi-ai SDK
 *
 * All agents implement AgentBackend directly.
 *
 * LLM Connections:
 * - Backends can be created from LLM connection configs
 * - providerType determines SDK selection and credential routing
 * - authType determines how credentials are retrieved
 */
import type { BackendConfig, AgentProvider, LlmProviderType } from "../types.ts";
import { type LlmConnection } from "../../../config/storage.ts";
// Import validation helpers for provider-auth combinations
import { isModelAllowedForAuthProvider } from "../../../config/llm-connections.ts";
// Model resolution utilities
import { getModelProvider, DEFAULT_MODEL, normalizeDeprecatedModelId } from "../../../config/models.ts";
import { connectionTypeToProvider, providerTypeToAgentProvider } from './provider-policy.ts';

/**
 * Create backend configuration from an LLM connection.
 *
 * @param connection - The LLM connection config
 * @param baseConfig - Base backend config (workspace, session, etc.)
 * @returns Complete BackendConfig ready for createBackend()
 */
export function createConfigFromConnection(
  connection: LlmConnection,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType' | 'providerType'>
): BackendConfig {
  // Use new providerType if available, fall back to legacy type
  const providerType = connection.providerType || (connection.type ? (connectionTypeToProvider(connection.type)) as LlmProviderType : 'anthropic');
  const provider = providerTypeToAgentProvider(providerType);

  const optionalModel = baseConfig.model || connection.defaultModel;
  const baseConfigWithoutOverrides = { ...baseConfig };
  delete baseConfigWithoutOverrides.model;
  return {
    ...baseConfigWithoutOverrides,
    provider,
    providerType,
    authType: connection.authType,
    connectionSlug: connection.slug,
    // Use connection's default model if no model specified in baseConfig
    ...(optionalModel !== undefined ? { model: optionalModel } : {}),
  };
}

// ============================================================
// Model Resolution
// ============================================================

/**
 * Resolve the model ID for a given provider, validating against the connection's model list.
 *
 * Explicit models are validated without replacement. For a new session without
 * a selection, the configured connection default or provider initialization
 * default applies.
 *
 * @param provider - The agent provider
 * @param managedModel - The model stored on the session (user's choice)
 * @param connection - The LLM connection config (has defaultModel and models[])
 * @returns Resolved model ID string
 */
export function resolveModelForProvider(
  provider: AgentProvider,
  managedModel: string | undefined,
  connection: LlmConnection | null
): string {
  // An explicit model is never replaced by a provider/catalog fallback.
  if (managedModel) {
    const modelProvider = getModelProvider(managedModel);
    if (modelProvider && modelProvider !== provider) {
      throw new Error(`Selected model "${managedModel}" is incompatible with provider "${provider}".`);
    }
  }

  let connectionDefault = connection?.defaultModel
    ? normalizeDeprecatedModelId(connection.defaultModel)
    : undefined;

  const authProvider = provider === 'pi' ? connection?.piAuthProvider : undefined;
  // A stored/explicit session choice is user intent. Reject an incompatible
  // choice before runtime creation; do not silently substitute a default model.
  if (managedModel && !isModelAllowedForAuthProvider(managedModel, authProvider)) {
    throw new Error(`The selected model "${managedModel}" cannot be used with ChatGPT-account Codex authentication. Choose another model for this conversation, then retry. The saved selection was preserved.`);
  }
  const retiredSelection = connectionDefault && !isModelAllowedForAuthProvider(connectionDefault, authProvider);
  if (retiredSelection) connectionDefault = undefined;

  if (provider === 'pi' && connection?.models?.length) {
    const connectionModelIds = connection.models.map(m => typeof m === 'string' ? m : m.id)
      .filter(modelId => isModelAllowedForAuthProvider(modelId, authProvider));
    if (managedModel && !connectionModelIds.includes(managedModel)) {
      throw new Error(`Selected model "${managedModel}" is unavailable in the configured connection.`);
    }
    if (connectionDefault && !connectionModelIds.includes(connectionDefault)) {
      if (!retiredSelection) {
        throw new Error(`Selected model "${connectionDefault}" is unavailable in the configured connection.`);
      }
      connectionDefault = connectionModelIds[0];
    }
    if (retiredSelection && !connectionDefault) connectionDefault = connectionModelIds[0];
  }

  if (retiredSelection && !managedModel && !connectionDefault) {
    throw new Error(`No supported model is configured for connection "${connection?.slug ?? '(unknown)'}"`);
  }

  switch (provider) {
    case 'pi':
      return managedModel || connectionDefault || '';
    default:
      return managedModel || connectionDefault || DEFAULT_MODEL;
  }
}
