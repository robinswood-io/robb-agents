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
import type { AgentBackend, BackendConfig, AgentProvider, CoreBackendConfig, BackendHostRuntimeContext } from "../types.ts";
import { ClaudeAgent } from "../../claude-agent.ts";
import { PiAgent } from "../../pi-agent.ts";
import { getLlmConnection } from "../../../config/storage.ts";
// Import validation helpers for provider-auth combinations
import { isValidProviderAuthCombination } from "../../../config/llm-connections.ts";
import type { BackendProviderOptions, ProviderDriver, ResolvedBackendConfig } from "../internal/driver-types.ts";
import { getDefaultProviderType } from "../internal/driver-types.ts";
import { resolveBackendHostTooling as resolveHostToolingPaths, resolveBackendRuntimePaths } from "../internal/runtime-resolver.ts";
import { anthropicDriver } from "../internal/drivers/anthropic.ts";
import { piDriver } from "../internal/drivers/pi.ts";
import type { ResolvedBackendContext } from './connection-context.ts';
import { createConfigFromConnection, resolveModelForProvider } from './connection-models.ts';
import { BACKEND_CAPABILITIES, connectionAuthTypeToBackendAuthType, getAvailableProviders, getDefaultAuthType, providerTypeToAgentProvider } from './provider-policy.ts';

const DRIVER_REGISTRY: Record<AgentProvider, ProviderDriver> = {
  anthropic: anthropicDriver,
  pi: piDriver,
};

function getProviderDriver(provider: AgentProvider): ProviderDriver {
  const driver = DRIVER_REGISTRY[provider];
  if (!driver) {
    throw new Error(`No backend driver registered for provider: ${provider}`);
  }
  return driver;
}

export function resolveDriverRuntime(
  provider: AgentProvider,
  hostRuntime: BackendHostRuntimeContext,
) {
  const driver = getProviderDriver(provider);
  const resolvedPaths = resolveBackendRuntimePaths(hostRuntime);
  return { driver, resolvedPaths };
}

/**
 * Detect provider from stored auth type.
 *
 * Maps authentication types to their corresponding providers:
 * - api_key, oauth_token → Anthropic (Claude) by default
 *
 * Note: Provider is now determined by LLM connection type, not auth type.
 * This function is kept for backward compatibility.
 *
 * @param authType - The stored authentication type
 * @returns The detected provider
 */
export function detectProvider(authType: string): AgentProvider {
  switch (authType) {
    case 'api_key':
    case 'oauth_token':
      return 'anthropic';

    // Default to Anthropic for unknown types
    default:
      return 'anthropic';
  }
}

/**
 * Create the appropriate backend based on configuration.
 *
 * @param config - Backend configuration including provider selection
 * @returns An initialized AgentBackend instance
 * @throws Error if the requested provider is not yet implemented
 *
 * @example
 * ```typescript
 * // Create Anthropic (Claude) backend
 * const backend = createBackend({
 *   provider: 'anthropic',
 *   workspace: myWorkspace,
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * // Create Pi backend (routes OpenAI / Copilot / Bedrock / etc. via Pi SDK)
 * const piBackend = createBackend({
 *   provider: 'pi',
 *   workspace: myWorkspace,
 * });
 * ```
 */
export function createBackend(config: BackendConfig): AgentBackend {
  switch (config.provider) {
    case 'anthropic':
      // ClaudeAgent implements AgentBackend directly
      return new ClaudeAgent(config);

    case 'pi':
      // PiAgent implements AgentBackend directly
      // Auth is API key based via Pi's AuthStorage
      return new PiAgent(config);

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

/**
 * Create the appropriate agent based on configuration.
 * Alias for createBackend - prefer this name for new code.
 */
export const createAgent = createBackend;

/**
 * Create backend from a pre-resolved context and provider-agnostic core config.
 * Provider-specific runtime resolution happens via internal driver registry.
 */
export function createBackendFromResolvedContext(args: {
  context: ResolvedBackendContext;
  coreConfig: CoreBackendConfig;
  hostRuntime: BackendHostRuntimeContext;
  providerOptions?: BackendProviderOptions;
}): AgentBackend {
  const { context, coreConfig, hostRuntime, providerOptions } = args;
  const { driver, resolvedPaths } = resolveDriverRuntime(context.provider, hostRuntime);

  const buildArgs = {
    context,
    coreConfig,
    hostRuntime,
    resolvedPaths,
    providerOptions,
  };

  driver.prepareRuntime?.(buildArgs);
  const runtime = driver.buildRuntime(buildArgs);

  const config: ResolvedBackendConfig = {
    ...coreConfig,
    provider: context.provider,
    providerType: context.connection?.providerType ?? getDefaultProviderType(context.provider),
    authType: context.authType || getDefaultAuthType(context.provider),
    model: context.resolvedModel,
    connectionSlug: context.connection?.slug,
    runtime,
  };

  return createBackend(config);
}

/**
 * Initialize backend host runtime wiring once at app startup.
 * Keeps runtime/bootstrap details (Claude SDK executable, Pi interceptor bundle)
 * behind backend internals.
 */
export function initializeBackendHostRuntime(args: {
  hostRuntime: BackendHostRuntimeContext;
}): void {
  const { hostRuntime } = args;

  for (const provider of getAvailableProviders()) {
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, hostRuntime);
    driver.initializeHostRuntime?.({ hostRuntime, resolvedPaths });
  }
}

/**
 * Resolve backend-managed host tooling paths (e.g. ripgrep) from generic host runtime metadata.
 */
export function resolveBackendHostTooling(args: {
  hostRuntime: BackendHostRuntimeContext;
}): {
  ripgrepPath?: string;
} {
  return resolveHostToolingPaths(args.hostRuntime);
}

/**
 * Create backend from an LLM connection slug.
 *
 * @param connectionSlug - The LLM connection slug
 * @param baseConfig - Base backend config (workspace, session, etc.)
 * @returns An initialized AgentBackend instance
 * @throws Error if connection not found or has invalid provider-auth combination
 */
export function createBackendFromConnection(
  connectionSlug: string,
  baseConfig: Omit<BackendConfig, 'provider' | 'authType'>,
  hostRuntime?: BackendHostRuntimeContext,
  providerOptions?: BackendProviderOptions,
): AgentBackend {
  const connection = getLlmConnection(connectionSlug);
  if (!connection) {
    throw new Error(`LLM connection not found: ${connectionSlug}`);
  }

  // Validate provider-auth combination before creating backend
  // This catches invalid configurations early with a clear error message
  if (!isValidProviderAuthCombination(connection.providerType, connection.authType)) {
    throw new Error(
      `Invalid LLM connection configuration: provider '${connection.providerType}' ` +
      `does not support auth type '${connection.authType}'. ` +
      `Please update the connection settings for '${connection.name}'.`
    );
  }

  const context: ResolvedBackendContext = {
    connection,
    provider: providerTypeToAgentProvider(connection.providerType || 'anthropic'),
    authType: connectionAuthTypeToBackendAuthType(connection.authType),
    resolvedModel: resolveModelForProvider(
      providerTypeToAgentProvider(connection.providerType || 'anthropic'),
      baseConfig.model,
      connection
    ),
    capabilities: BACKEND_CAPABILITIES[providerTypeToAgentProvider(connection.providerType || 'anthropic')],
  };

  if (hostRuntime) {
    return createBackendFromResolvedContext({
      context,
      coreConfig: baseConfig,
      hostRuntime,
      providerOptions,
    });
  }

  const config = createConfigFromConnection(connection, {
    ...baseConfig,
    model: context.resolvedModel,
  });
  return createBackend(config);
}
