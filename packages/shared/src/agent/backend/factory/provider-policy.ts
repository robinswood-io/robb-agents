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
import type { AgentProvider, LlmProviderType, LlmAuthType } from "../types.ts";
// Import deprecated type for legacy migration function only
import type { LlmConnectionType } from "../../../config/llm-connections.ts";

/**
 * Get list of currently available providers.
 *
 * @returns Array of provider identifiers that have working implementations
 */
export function getAvailableProviders(): AgentProvider[] {
  return ['anthropic', 'pi'];
}

/**
 * Check if a provider is available for use.
 *
 * @param provider - Provider to check
 * @returns true if the provider has a working implementation
 */
export function isProviderAvailable(provider: AgentProvider): boolean {
  return getAvailableProviders().includes(provider);
}

// ============================================================
// LLM Connection Support
// ============================================================

/**
 * Map LlmProviderType to AgentProvider (SDK selection).
 *
 * AgentProvider determines which backend class to instantiate:
 * - 'anthropic' → ClaudeAgent
 * - 'pi' → PiAgent
 *
 * @param providerType - The full provider type from LLM connection
 * @returns The agent provider for SDK selection
 */
export function providerTypeToAgentProvider(providerType: LlmProviderType): AgentProvider {
  switch (providerType) {
    // Anthropic SDK backend (direct API only)
    case 'anthropic':
      return 'anthropic';

    // Pi backends (includes former bedrock/vertex/anthropic_compat via migration)
    case 'pi':
    case 'pi_compat':
      return 'pi';

    default:
      // Exhaustive check
      const _exhaustive: never = providerType;
      return 'anthropic';
  }
}

/**
 * @deprecated Use providerTypeToAgentProvider instead.
 * Map legacy LLM connection type to agent provider.
 *
 * @param connectionType - The legacy LLM connection type
 * @returns The corresponding agent provider
 */
export function connectionTypeToProvider(connectionType: LlmConnectionType): AgentProvider {
  switch (connectionType) {
    case 'anthropic':
      return 'anthropic';
    case 'openai':
    case 'openai-compat':
      return 'pi'; // Legacy OpenAI connections are now routed through Pi
    default:
      return 'anthropic';
  }
}

/**
 * @deprecated Use LlmAuthType directly - no mapping needed.
 * Map legacy LLM auth type to backend auth type.
 *
 * @param authType - The legacy LLM connection auth type
 * @returns The corresponding backend auth type
 */
export function connectionAuthTypeToBackendAuthType(
  authType: LlmAuthType
): LlmAuthType | undefined {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'oauth':
    case 'bearer_token':
    case 'iam_credentials':
    case 'service_account_file':
      // Pass through auth types that the backend handles
      return authType;
    case 'none':
    case 'environment':
      // These auth types don't require explicit credential passing
      return undefined;
  }
}

// ============================================================
// Backend Capabilities
// ============================================================

/**
 * Declarative capabilities for each backend provider.
 * Used by the session layer to make decisions without checking provider strings.
 */
export const BACKEND_CAPABILITIES: Record<AgentProvider, {
  /** Whether the backend needs an HTTP pool server (external subprocess can't access McpClientPool directly) */
  needsHttpPoolServer: boolean;
}> = {
  anthropic: { needsHttpPoolServer: false },
  pi: { needsHttpPoolServer: false },
};

// ============================================================
// Auth Type Resolution
// ============================================================

/**
 * Get the default auth type for a provider when none is explicitly specified.
 *
 * - anthropic: undefined (Claude uses env vars, not explicit authType)
 * - pi: 'api_key'
 */
export function getDefaultAuthType(provider: AgentProvider): LlmAuthType | undefined {
  switch (provider) {
    case 'anthropic': return undefined;
    case 'pi':        return 'api_key';
    default:          return undefined;
  }
}
