import type { ProviderDriver, DriverTestConnectionArgs } from "../../driver-types.ts";
import type { ModelDefinition } from "../../../../../config/models.ts";
import { getAllPiModels, getPiModelsForAuthProvider } from "../../../../../config/models-pi.ts";
import { getPiProviderBaseUrl } from "../../../../../config/models-pi.ts";
import { testAnthropicCompatible } from './anthropic-connection.ts';
import { fetchCopilotModels } from './copilot-models.ts';

export const piDriver: ProviderDriver = {
  provider: 'pi',
  buildRuntime: ({ context, providerOptions, resolvedPaths }) => {
    const piAuthProvider = providerOptions?.piAuthProvider || context.connection?.piAuthProvider;
    return {
      paths: {
        // Vibe uses the official ACP bridge but deliberately reuses PiAgent's
        // established JSONL lifecycle and permission plumbing.
        piServer: piAuthProvider === 'mistral-vibe'
          ? resolvedPaths.vibeAcpServerPath
          : piAuthProvider === 'google-antigravity'
            ? resolvedPaths.antigravityServerPath
            : resolvedPaths.piServerPath,
        vibeAcpServer: resolvedPaths.vibeAcpServerPath,
        antigravityServer: resolvedPaths.antigravityServerPath,
        interceptor: piAuthProvider === 'mistral-vibe' || piAuthProvider === 'google-antigravity'
          ? undefined
          : resolvedPaths.interceptorBundlePath,
        node: resolvedPaths.nodeRuntimePath,
      },
      piAuthProvider,
      googleCloudProject: context.connection?.googleCloudProject,
      baseUrl: context.connection?.baseUrl,
      customEndpoint: context.connection?.customEndpoint,
      customModels: context.connection?.models?.map(m => {
        if (typeof m === 'string') return m;
        const supportsImages = typeof m.supportsImages === 'boolean'
          ? m.supportsImages
          : undefined;
        const supportsThinking = typeof m.supportsThinking === 'boolean'
          ? m.supportsThinking
          : undefined;
        const maxTokens = typeof m.maxOutputTokens === 'number'
          ? m.maxOutputTokens
          : undefined;
        if (m.contextWindow || supportsImages !== undefined || supportsThinking !== undefined || maxTokens !== undefined) {
          return {
            id: m.id,
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
            ...(supportsImages !== undefined ? { supportsImages } : {}),
            ...(supportsThinking !== undefined ? { supportsThinking } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
          };
        }
        return m.id;
      }),
    };
  },
  fetchModels: async ({ connection, credentials, timeoutMs }) => {
    // Copilot OAuth: fetch models directly from the Copilot API via HTTP.
    // Uses the GitHub OAuth token (our refreshToken) to exchange for a
    // Copilot API token, then queries GET /models for the live model list.
    const copilotGitHubToken = credentials.oauthRefreshToken || credentials.oauthAccessToken;
    if (connection.piAuthProvider === 'github-copilot' && copilotGitHubToken) {
      const models = await fetchCopilotModels(copilotGitHubToken, timeoutMs);
      return { models };
    }

    // Local / Custom OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, llama.cpp):
    // Discover installed models directly from GET {baseUrl}/v1/models (or Ollama /api/tags fallback).
    const isCustomOrLocalEndpoint = Boolean(
      connection.baseUrl
      && (!connection.piAuthProvider || connection.providerType === 'pi_compat' || Boolean(connection.customEndpoint)),
    );
    if (isCustomOrLocalEndpoint && connection.baseUrl) {
      const base = connection.baseUrl.trim().replace(/\/+$/, '');
      const modelsUrl = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
      const ollamaOrigin = base.replace(/\/v1$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs || 5_000, 5_000));
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (credentials.apiKey) headers.Authorization = `Bearer ${credentials.apiKey}`;

        const rawIds: string[] = [];
        try {
          const res = await fetch(modelsUrl, { signal: controller.signal, headers });
          if (res.ok) {
            const payload = await res.json() as {
              data?: Array<{ id?: string; name?: string; model?: string }>;
              models?: Array<{ id?: string; name?: string; model?: string }>;
            };
            for (const entry of payload.data ?? payload.models ?? []) {
              const id = entry.id || entry.name || entry.model;
              if (typeof id === 'string' && id.trim().length > 0) {
                rawIds.push(id.trim());
              }
            }
          }
        } catch {
          // Try Ollama /api/tags fallback below
        }

        if (rawIds.length === 0) {
          try {
            const tagsRes = await fetch(`${ollamaOrigin}/api/tags`, { signal: controller.signal, headers });
            if (tagsRes.ok) {
              const payload = await tagsRes.json() as { models?: Array<{ name?: string; model?: string }> };
              for (const entry of payload.models ?? []) {
                const id = entry.name || entry.model;
                if (typeof id === 'string' && id.trim().length > 0) {
                  rawIds.push(id.trim());
                }
              }
            }
          } catch {
            // Local server offline or non-Ollama
          }
        }

        if (rawIds.length > 0) {
          const existingById = new Map<string, ModelDefinition>();
          for (const existing of connection.models ?? []) {
            if (typeof existing !== 'string') {
              existingById.set(existing.id, existing);
            }
          }

          const buildLocalModelDef = (id: string): ModelDefinition => {
            const prev = existingById.get(id);
            const supportsThinking = prev?.supportsThinking
              ?? /(?:deepseek-r1|(?:\b|[-_/:])r1(?:\b|[-_/:])|qwq|qwen3(?!.*coder)|gpt-oss|magistral|kimi-k2-thinking|glm-z1|glm-5|minimax-m2|minimax-m3|thinking|reason|(?:\b|[-_/:])(?:o1|o3|o4)(?:\b|[-_/:])|openthinker|marco-o1|skywork-o1|nemotron-nano|phi-?4-reasoning)/i.test(id);
            const supportsImages = prev?.supportsImages
              ?? /(?:vision|(?:\b|[-_/:])vl(?:\b|[-_/:])|llava|pixtral|gemma-?[34]|llama-?4|minicpm-v|internvl|molmo|glm-[45](?:\.\d+)?v|mistral-small-(?:3\.[12]|4))/i.test(id);
            return {
              id,
              name: prev?.name || id,
              shortName: prev?.shortName || id.replace(/:latest$/, ''),
              description: prev?.description || 'Local model discovered via OpenAI-compatible endpoint',
              provider: 'pi',
              contextWindow: prev?.contextWindow ?? 131_072,
              supportsThinking,
              supportsImages,
              ...(prev?.maxOutputTokens ? { maxOutputTokens: prev.maxOutputTokens } : {}),
            };
          };

          const seen = new Set<string>();
          const discovered: ModelDefinition[] = [];
          for (const id of rawIds) {
            if (seen.has(id)) continue;
            seen.add(id);
            discovered.push(buildLocalModelDef(id));
          }
          // Preserve any user-configured model IDs that were not in the live server list
          for (const existing of connection.models ?? []) {
            const id = typeof existing === 'string' ? existing : existing.id;
            if (!id || seen.has(id)) continue;
            seen.add(id);
            discovered.push(buildLocalModelDef(id));
          }

          return {
            models: discovered,
            serverDefault: connection.defaultModel && seen.has(connection.defaultModel)
              ? connection.defaultModel
              : discovered[0]!.id,
          };
        }
      } finally {
        clearTimeout(timer);
      }

      if (connection.providerType === 'pi_compat' || Boolean(connection.customEndpoint)) {
        throw new Error(`No models discovered from custom/local endpoint: ${connection.baseUrl}`);
      }
    }

    // All other Pi providers: use static Pi SDK model registry
    const models = connection.piAuthProvider
      ? getPiModelsForAuthProvider(connection.piAuthProvider)
      : getAllPiModels();

    if (models.length === 0) {
      throw new Error(
        `No Pi models found for provider: ${connection.piAuthProvider ?? 'all'}`,
      );
    }

    return { models };
  },
  testConnection: async (args: DriverTestConnectionArgs): Promise<{ success: boolean; error?: string } | null> => {
    const piAuthProvider = args.connection?.piAuthProvider;
    if (!piAuthProvider) {
      // No provider hint — fall back to generic subprocess path
      return null;
    }

    // Resolve the model's API type from the Pi SDK registry.
    // For anthropic-messages providers, do a lightweight direct HTTP test
    // instead of spawning a full Pi subprocess (which can exceed the timeout).
    let modelApi: string | undefined;
    let modelBaseUrl: string | undefined;
    try {
      const { getModels } = await import('@earendil-works/pi-ai/compat');
      const models = getModels(piAuthProvider as Parameters<typeof getModels>[0]);
      const requestedId = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
      const match = models.find(m => m.id === requestedId) || models[0];
      if (match) {
        modelApi = (match as { api?: string }).api;
        modelBaseUrl = (match as { baseUrl?: string }).baseUrl;
      }
    } catch { /* ignore — fall through to subprocess */ }

    if (modelApi !== 'anthropic-messages') {
      // Non-Anthropic API types need the full Pi SDK — let factory.ts handle it
      return null;
    }

    const baseUrl = args.baseUrl?.trim() || modelBaseUrl || getPiProviderBaseUrl(piAuthProvider);
    if (!baseUrl) {
      return { success: false, error: 'Could not determine API endpoint for provider' };
    }

    // Strip Pi SDK's 'pi/' prefix — Anthropic-compatible endpoints only accept bare model IDs
    let bareModel = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
    // MiniMax CN API doesn't accept the 'MiniMax-' prefix on model names
    if (piAuthProvider === 'minimax-cn' && bareModel.startsWith('MiniMax-')) {
      bareModel = bareModel.slice('MiniMax-'.length);
    }
    return testAnthropicCompatible(args.apiKey, baseUrl, bareModel, args.timeoutMs);
  },
  validateStoredConnection: async ({ slug, connection, credentialManager }) => {
    if (connection.authType === 'oauth') {
      const stored = await credentialManager.getLlmOAuth(slug);
      if (!stored?.accessToken) {
        return { success: false, error: 'No OAuth token found. Please sign in again.' };
      }
      // Check if expired or about to expire (within 60s)
      if (stored.expiresAt && Date.now() > stored.expiresAt - 60_000) {
        if (!stored.refreshToken) {
          return { success: false, error: 'OAuth token has expired and cannot be refreshed. Please sign in again.' };
        }
        try {
          if (connection.piAuthProvider === 'openai-codex') {
            const { refreshChatGptTokens } = await import("../../../../../auth/chatgpt-oauth.ts");
            const refreshed = await refreshChatGptTokens(stored.refreshToken);
            await credentialManager.refreshLlmOAuth(slug, {
              accessToken: refreshed.accessToken,
              idToken: refreshed.idToken,
              refreshToken: refreshed.refreshToken,
              expiresAt: refreshed.expiresAt,
            });
          } else if (connection.piAuthProvider === 'google-gemini-code-assist') {
            const { refreshGoogleGeminiTokens } = await import("../../../../../auth/google-gemini-oauth.ts");
            const refreshed = await refreshGoogleGeminiTokens(stored.refreshToken);
            await credentialManager.refreshLlmOAuth(slug, {
              accessToken: refreshed.accessToken,
              idToken: refreshed.idToken,
              refreshToken: refreshed.refreshToken ?? stored.refreshToken,
              expiresAt: refreshed.expiresAt,
            });
          } else if (connection.piAuthProvider === 'github-copilot') {
            const { refreshGitHubCopilotToken } = await import("../../../../../auth/copilot-oauth.ts");
            const newCreds = await refreshGitHubCopilotToken(stored.refreshToken);
            await credentialManager.refreshLlmOAuth(slug, {
              accessToken: newCreds.access,
              refreshToken: newCreds.refresh,
              expiresAt: newCreds.expires,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, error: `Token refresh failed: ${msg}. Please sign in again.` };
        }
      }
    }
    return { success: true };
  },
};
