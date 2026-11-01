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
import type { BackendHostRuntimeContext } from "../types.ts";
import { getLlmConnection, type LlmConnection } from "../../../config/storage.ts";
import { parseValidationError } from "../../../config/llm-validation.ts";
import type { ModelFetchResult } from "../../../config/model-fetcher.ts";
import { getCredentialManager } from "../../../credentials/index.ts";
import type { BackendModelFetchCredentials, StoredConnectionValidationResult } from "../internal/driver-types.ts";
import { providerTypeToAgentProvider } from './provider-policy.ts';
import { resolveDriverRuntime } from './provider-registry.ts';

/**
 * Provider-agnostic model discovery for model refresh flows.
 * Dispatches to provider drivers and keeps provider-specific SDK usage internal.
 */
export async function fetchBackendModels(args: {
  connection: LlmConnection;
  credentials: BackendModelFetchCredentials;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
}): Promise<ModelFetchResult> {
  const provider = providerTypeToAgentProvider(args.connection.providerType);
  const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);
  const timeoutMs = args.timeoutMs ?? 30_000;

  driver.initializeHostRuntime?.({
    hostRuntime: args.hostRuntime,
    resolvedPaths,
  });

  if (!driver.fetchModels) {
    throw new Error(`Model discovery not implemented for provider: ${provider}`);
  }

  return driver.fetchModels({
    connection: args.connection,
    credentials: args.credentials,
    hostRuntime: args.hostRuntime,
    resolvedPaths,
    timeoutMs,
  });
}

/**
 * Provider-agnostic stored-connection validation.
 * Moves provider/auth branching out of Electron main IPC handlers.
 */
export async function validateStoredBackendConnection(args: {
  slug: string;
  hostRuntime: BackendHostRuntimeContext;
}): Promise<StoredConnectionValidationResult> {
  try {
    const connection = getLlmConnection(args.slug);
    if (!connection) {
      return { success: false, error: 'Connection not found' };
    }

    const credentialManager = getCredentialManager();
    const hasCredentials = await credentialManager.hasLlmCredentials(
      args.slug,
      connection.authType,
      connection.providerType,
    );

    if (!hasCredentials && connection.authType !== 'none') {
      return { success: false, error: 'No credentials configured' };
    }

    const provider = providerTypeToAgentProvider(connection.providerType);
    const { driver, resolvedPaths } = resolveDriverRuntime(provider, args.hostRuntime);

    driver.initializeHostRuntime?.({
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });

    if (!driver.validateStoredConnection) {
      return { success: true };
    }

    return driver.validateStoredConnection({
      slug: args.slug,
      connection,
      credentialManager,
      hostRuntime: args.hostRuntime,
      resolvedPaths,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, error: parseValidationError(msg) };
  }
}
