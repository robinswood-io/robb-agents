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
import type { AgentProvider } from "../types.ts";
import { getLlmConnection, getDefaultLlmConnection, type LlmConnection } from "../../../config/storage.ts";
// Import deprecated type for legacy migration function only
import type { CustomEndpointConfig } from "../../../config/llm-connections.ts";
import type { BackendResolutionContext } from "../internal/driver-types.ts";
import { resolveModelForProvider } from './connection-models.ts';
import { BACKEND_CAPABILITIES, connectionAuthTypeToBackendAuthType, providerTypeToAgentProvider } from './provider-policy.ts';

/**
 * Get LLM connection for a session.
 * Resolution order: session.llmConnection > workspace.defaults.defaultLlmConnection > global default
 *
 * @param sessionConnection - Connection slug from session (may be undefined)
 * @param workspaceDefaultConnection - Workspace default connection (may be undefined)
 * @returns The resolved LLM connection or null if not found
 */
export function resolveSessionConnection(
  sessionConnection?: string,
  workspaceDefaultConnection?: string
): LlmConnection | null {
  // 1. Session-level connection (locked after first message)
  if (sessionConnection) {
    return getLlmConnection(sessionConnection);
  }

  // 2. Workspace default
  if (workspaceDefaultConnection) {
    return getLlmConnection(workspaceDefaultConnection);
  }

  // 3. Global default
  const defaultSlug = getDefaultLlmConnection();
  if (!defaultSlug) return null;
  return getLlmConnection(defaultSlug);
}

/**
 * Provider-agnostic resolution result used by session/ipc orchestration.
 */
export interface ResolvedBackendContext extends BackendResolutionContext {}

/**
 * Resolve connection + provider/auth/model/capabilities in one call.
 * This keeps main-process orchestration free from provider-specific branching.
 */
export function resolveBackendContext(args: {
  sessionConnectionSlug?: string | undefined;
  workspaceDefaultConnectionSlug?: string | undefined;
  managedModel?: string | undefined;
}): ResolvedBackendContext {
  const connection = resolveSessionConnection(
    args.sessionConnectionSlug,
    args.workspaceDefaultConnectionSlug
  );

  if (!connection && (args.sessionConnectionSlug || args.workspaceDefaultConnectionSlug || getDefaultLlmConnection())) {
    throw new Error('The selected LLM connection is unavailable. Select a configured connection before continuing.');
  }

  const provider = connection
    ? providerTypeToAgentProvider(connection.providerType || 'anthropic')
    : 'anthropic';

  const authType = connection
    ? connectionAuthTypeToBackendAuthType(connection.authType)
    : undefined;

  const resolvedModel = resolveModelForProvider(provider, args.managedModel, connection);

  return {
    connection,
    provider,
    ...(authType !== undefined ? { authType } : {}),
    resolvedModel,
    capabilities: BACKEND_CAPABILITIES[provider],
  };
}

/**
 * Resolve provider hint for setup-time connection tests.
 * Keeps provider-specific hint mapping out of Electron main IPC handlers.
 */
export function resolveSetupTestConnectionHint(args: {
  provider: AgentProvider;
  baseUrl?: string;
  piAuthProvider?: string;
  customEndpoint?: CustomEndpointConfig;
}): Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'> {
  if (args.provider === 'pi') {
    if (args.customEndpoint && args.baseUrl?.trim()) {
      return {
        providerType: 'pi_compat',
        piAuthProvider: args.customEndpoint.api === 'anthropic-messages' ? 'anthropic' : 'openai',
        customEndpoint: args.customEndpoint,
      };
    }

    return {
      providerType: 'pi',
      ...(args.piAuthProvider !== undefined ? { piAuthProvider: args.piAuthProvider } : {}),
    };
  }

  return {
    providerType: args.baseUrl ? 'pi_compat' : 'anthropic',
  };
}
