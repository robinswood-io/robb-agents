/**
 * LLM Connections
 *
 * Named provider configurations that users can add, configure, and switch between.
 * Each session locks to a specific connection after the first message.
 * Workspaces can set a default connection.
 */
// Import model types and lists from centralized registry
// NOTE: Pi SDK functions (getPiModelsForAuthProvider, getAllPiModels) are NOT imported
// here because @earendil-works/pi-ai transitively pulls in @aws-sdk which uses Node.js
// `stream` module — breaking the Vite renderer build. Instead, Pi model resolution is
// injected at app startup via registerPiModelResolver().
import { type ModelDefinition } from "../models";
import type { CredentialManager } from "../../credentials/manager.ts";
import type { LlmConnection, LlmConnectionType } from './connection-types.ts';
import { migrateAuthType, migrateConnectionType } from './legacy-types.ts';
import { isAnthropicProvider } from './provider-policy.ts';

// ============================================================
// Auth Environment Variable Resolution
// ============================================================

const CLAUDE_BEDROCK_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
] as const

const CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET = new Set<string>(
  CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
)

const MANAGED_ANTHROPIC_AUTH_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...CLAUDE_BEDROCK_ROUTING_ENV_KEYS,
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const

function getRuntimeEnvValue(key: string): string | undefined {
  if (typeof process === 'undefined' || !process?.env) {
    return undefined
  }
  return process.env[key]
}

const MANAGED_ANTHROPIC_AUTH_ENV_BASELINE: Record<string, string | undefined> =
  Object.fromEntries(
    MANAGED_ANTHROPIC_AUTH_ENV_KEYS.map((key) => [
      key,
      CLAUDE_BEDROCK_ROUTING_ENV_KEY_SET.has(key)
        ? undefined
        : getRuntimeEnvValue(key),
    ]),
  )

export function clearClaudeBedrockRoutingEnvVars(
  targetEnv: Record<string, string | undefined> = process.env,
): void {
  for (const key of CLAUDE_BEDROCK_ROUTING_ENV_KEYS) {
    delete targetEnv[key]
  }
}

export function resetManagedAnthropicAuthEnvVars(): void {
  if (typeof process === 'undefined' || !process?.env) {
    return
  }

  for (const key of MANAGED_ANTHROPIC_AUTH_ENV_KEYS) {
    const originalValue = MANAGED_ANTHROPIC_AUTH_ENV_BASELINE[key]
    if (originalValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = originalValue
    }
  }
}

/**
 * Result of resolving auth env vars for an LLM connection.
 */
export interface ResolvedAuthEnvVars {
  /** Environment variables to set (e.g., ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN) */
  envVars: Record<string, string>;
  /** Whether credentials were successfully resolved */
  success: boolean;
  /** Warning message if auth resolution encountered issues */
  warning?: string;
}

/**
 * Resolve authentication environment variables for an LLM connection.
 *
 * Provider-agnostic: switches on providerType to determine which env vars
 * to set and how to retrieve credentials. Shared by:
 * - `SessionManager.reinitializeAuth()` (applies to process.env)
 * - `ClaudeAgent.postInit()` (applies to process.env + envOverrides)
 *
 * Providers that handle auth internally (openai, copilot, pi) return
 * empty envVars — their auth is managed in postInit() via native mechanisms.
 *
 * @param connection - The LLM connection config
 * @param connectionSlug - Connection slug for credential lookup
 * @param credentialManager - Credential manager instance
 * @param getValidOAuthToken - Function to get a valid (refreshed) OAuth token
 * @returns Resolved env vars and status
 */
export async function resolveAuthEnvVars(
  connection: LlmConnection,
  connectionSlug: string,
  credentialManager: CredentialManager,
  getValidOAuthToken: (slug: string) => Promise<{ accessToken?: string | null }>,
  expectedCredentialBindingId?: string,
): Promise<ResolvedAuthEnvVars> {
  const envVars: Record<string, string> = {};

  // Only Anthropic-SDK-based providers use env var auth
  // OpenAI (Codex), Copilot, and Pi handle auth internally in their postInit()
  if (!isAnthropicProvider(connection.providerType)) {
    return { envVars, success: true };
  }

  // Set base URL if configured
  if (connection.baseUrl) {
    envVars.ANTHROPIC_BASE_URL = connection.baseUrl;
  }

  const authType = connection.authType;

  if (authType === 'api_key' || authType === 'api_key_with_endpoint' || authType === 'bearer_token') {
    const apiKey = await credentialManager.getLlmApiKey(connectionSlug, expectedCredentialBindingId);
    if (apiKey) {
      envVars.ANTHROPIC_API_KEY = apiKey;
    } else if (connection.baseUrl) {
      // Keyless provider (e.g. Ollama)
      envVars.ANTHROPIC_API_KEY = 'not-needed';
    } else {
      return { envVars, success: false, warning: `No API key found for: ${connectionSlug}` };
    }
  } else if (authType === 'oauth') {
    if (connection.providerType === 'anthropic') {
      const exactCredential = expectedCredentialBindingId
        ? await credentialManager.getLlmOAuth(connectionSlug, expectedCredentialBindingId)
        : null;
      // A governed route must not consult the legacy global Claude slot. Its
      // exact connection generation is the authority; expiry fails closed.
      const tokenResult = expectedCredentialBindingId
        ? { accessToken: exactCredential?.expiresAt !== undefined
            && exactCredential.expiresAt <= Date.now()
          ? null
          : exactCredential?.accessToken }
        : await getValidOAuthToken(connectionSlug);
      const accessToken = tokenResult.accessToken;
      if (accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = accessToken;
      } else {
        return { envVars, success: false, warning: `Failed to get OAuth token for: ${connectionSlug}` };
      }
    } else {
      // Fallback OAuth path (should not be reached after legacy migration)
      const llmOAuth = await credentialManager.getLlmOAuth(connectionSlug, expectedCredentialBindingId);
      if (llmOAuth?.accessToken) {
        envVars.CLAUDE_CODE_OAUTH_TOKEN = llmOAuth.accessToken;
      } else {
        return { envVars, success: false, warning: `No OAuth token found for: ${connectionSlug}` };
      }
    }
  } else if (authType === 'environment') {
    // Environment auth — credentials come from process.env, nothing to inject
    return { envVars, success: true };
  }

  return { envVars, success: true };
}

/**
 * Migrate a legacy LlmConnection to the new format.
 * Creates a new connection object with providerType instead of type.
 *
 * @param legacy - Legacy connection with 'type' field
 * @returns Migrated connection with 'providerType' field
 */
export function migrateLlmConnection(legacy: {
  slug: string;
  name: string;
  type: LlmConnectionType;
  baseUrl?: string;
  authType: 'api_key' | 'oauth' | 'none';
  models?: ModelDefinition[];
  defaultModel?: string;
  createdAt: number;
  lastUsedAt?: number;
}): LlmConnection {
  const providerType = migrateConnectionType(legacy.type);
  const hasCustomEndpoint = !!legacy.baseUrl && legacy.type !== 'anthropic';
  const authType = migrateAuthType(legacy.authType, hasCustomEndpoint);

  return {
    slug: legacy.slug,
    name: legacy.name,
    providerType,
    type: legacy.type, // Keep for backwards compatibility
    baseUrl: legacy.baseUrl,
    authType,
    models: legacy.models,
    defaultModel: legacy.defaultModel,
    createdAt: legacy.createdAt,
    lastUsedAt: legacy.lastUsedAt,
  };
}
