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
import type { AgentProvider, LlmAuthType, BackendHostRuntimeContext } from "../types.ts";
import { type LlmConnection } from "../../../config/storage.ts";
import { type LlmValidationResult } from "../../../config/llm-validation.ts";
// Model resolution utilities
import { DEFAULT_MODEL } from "../../../config/models.ts";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getCredentialManager } from "../../../credentials/index.ts";
import { getSourcePath } from "../../../sources/storage.ts";
import { getDefaultProviderType } from "../internal/driver-types.ts";
import type { ResolvedBackendContext } from './connection-context.ts';
import { BACKEND_CAPABILITIES, providerTypeToAgentProvider } from './provider-policy.ts';
import { createBackendFromResolvedContext, resolveDriverRuntime } from './provider-registry.ts';

// ============================================================
// Runtime Artifact Helpers
// ============================================================

/**
 * Remove backend runtime artifacts for disabled sources.
 * Currently removes bridge credential cache files in source directories.
 */
export async function cleanupSourceRuntimeArtifacts(
  workspaceRootPath: string,
  disabledSourceSlugs: string[],
): Promise<void> {
  for (const sourceSlug of disabledSourceSlugs) {
    try {
      const sourceDir = getSourcePath(workspaceRootPath, sourceSlug);
      const cachePath = join(sourceDir, '.credential-cache.json');
      await rm(cachePath, { force: true });
    } catch {
      // Ignore invalid or traversal slugs
    }
  }
}

// ============================================================
// Provider-Agnostic Connection Testing
// ============================================================

export async function testBackendConnection(args: {
  provider: AgentProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  hostRuntime: BackendHostRuntimeContext;
  timeoutMs?: number;
  allowEmptyApiKey?: boolean;
  connection?: Pick<LlmConnection, 'providerType' | 'piAuthProvider' | 'customEndpoint'>;
}): Promise<{ success: boolean; error?: string }> {
  const trimmedKey = args.apiKey.trim();
  if (!trimmedKey && !args.allowEmptyApiKey) {
    return { success: false, error: 'API key is required' };
  }

  const tempSlug = `__test-${Date.now()}`;
  const cm = getCredentialManager();
  if (trimmedKey) {
    await cm.setLlmApiKey(tempSlug, trimmedKey);
  }

  try {
    const testModel = args.model;
    const providerType = args.connection?.providerType ?? getDefaultProviderType(args.provider);
    const now = Date.now();
    const authType: LlmAuthType = (
      providerType === 'pi_compat'
    )
      ? 'api_key_with_endpoint'
      : 'api_key';

    const syntheticConnection = {
      slug: tempSlug,
      name: 'Temporary Connection Test',
      providerType,
      authType,
      defaultModel: testModel,
      createdAt: now,
      piAuthProvider: args.connection?.piAuthProvider,
      customEndpoint: args.connection?.customEndpoint,
      ...(args.baseUrl?.trim() ? { baseUrl: args.baseUrl.trim() } : {}),
    } as LlmConnection;

    const context: ResolvedBackendContext = {
      connection: syntheticConnection,
      provider: args.provider,
      authType,
      resolvedModel: testModel,
      capabilities: BACKEND_CAPABILITIES[args.provider],
    };

    const { driver, resolvedPaths } = resolveDriverRuntime(args.provider, args.hostRuntime);
    if (driver.testConnection) {
      const driverResult = await driver.testConnection({
        provider: args.provider,
        apiKey: trimmedKey,
        model: testModel,
        baseUrl: args.baseUrl,
        connection: args.connection,
        hostRuntime: args.hostRuntime,
        resolvedPaths,
        timeoutMs: args.timeoutMs ?? 20000,
      });
      // null = driver declined to handle; fall through to generic subprocess test
      if (driverResult !== null) return driverResult;
    }

    const cwd = homedir();
    const agent = createBackendFromResolvedContext({
      context,
      coreConfig: {
        workspace: { id: '__test', name: 'Connection Test', slug: '__test', rootPath: cwd, createdAt: 0 },
        session: { id: `test-${now}`, workspaceRootPath: cwd, createdAt: 0, lastUsedAt: 0 },
        isHeadless: true,
        miniModel: testModel,
        envOverrides: args.provider === 'anthropic'
          ? {
            ANTHROPIC_API_KEY: trimmedKey,
            ...(args.baseUrl?.trim() ? { ANTHROPIC_BASE_URL: args.baseUrl.trim() } : {}),
          }
          : undefined,
      },
      hostRuntime: args.hostRuntime,
      providerOptions: { piAuthProvider: args.connection?.piAuthProvider },
    });

    const readAgentStderr = (): string => {
      const maybe = agent as unknown as { getRecentStderr?: () => string };
      return typeof maybe.getRecentStderr === 'function' ? maybe.getRecentStderr() : '';
    };
    const withStderrContext = (message: string): string => {
      const stderr = readAgentStderr();
      if (!stderr) return `${message} (subprocess produced no stderr output)`;
      return `${message}\n--- subprocess stderr (last ~8KB) ---\n${stderr}`;
    };

    try {
      const timeoutMs = args.timeoutMs ?? 20000;
      const text = await Promise.race([
        agent.runMiniCompletion('Say ok'),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(withStderrContext(`Connection test timed out after ${timeoutMs}ms`))),
            timeoutMs
          )
        ),
      ]);

      return text
        ? { success: true }
        : { success: false, error: 'No response from provider. Check your API key.' };
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      // Avoid double-appending if the timeout branch already included stderr context.
      const enriched = base.includes('subprocess stderr') ? base : withStderrContext(base);
      return { success: false, error: enriched };
    } finally {
      agent.destroy();
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cm.deleteLlmApiKey(tempSlug).catch(() => {});
  }
}

// ============================================================
// Connection Validation
// ============================================================

/**
 * Validate an LLM connection by dispatching to provider-specific validation.
 *
 * - Anthropic/compat/Bedrock/Vertex: validates via Claude Agent SDK (query with maxTurns:1)
 * - OpenAI/Copilot/Pi: returns success (these providers validate on connect, no pre-flight check available)
 *
 * For more thorough provider-specific validation (model list checks, OAuth refresh, etc.),
 * see the IPC handler in apps/electron/src/main/ipc.ts.
 *
 * @param connection - The LLM connection to validate
 * @param credentials - API key or OAuth token for validation
 * @returns Validation result
 */
export async function validateConnection(
  connection: LlmConnection,
  credentials: { apiKey?: string; oauthToken?: string },
): Promise<LlmValidationResult> {
  const provider = providerTypeToAgentProvider(connection.providerType);

  switch (provider) {
    case 'anthropic': {
      // Anthropic-based providers can be validated via the Claude Agent SDK
      const { validateAnthropicConnection } = await import("../../../config/llm-validation.ts");
      return validateAnthropicConnection({
        model: connection.defaultModel || DEFAULT_MODEL,
        apiKey: credentials.apiKey,
        oauthToken: credentials.oauthToken,
        baseUrl: connection.baseUrl,
      });
    }

    case 'pi':
      // Pi validates on connect via its auth storage — no pre-flight check available
      return { success: true };

    default:
      return { success: true };
  }
}
