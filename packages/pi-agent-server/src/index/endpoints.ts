import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelRegistry as PiModelRegistry } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAuthenticatedModelRuntime } from "../authenticated-model-runtime.ts";
import { registerSupplementalCatalogModels } from "../catalog-model-registration.ts";
import { buildCustomEndpointModelDef, normalizeCustomEndpointBaseUrl, normalizeCustomEndpointModelEntry } from "../custom-endpoint-models.ts";
import type { CustomEndpointModelEntry } from "../custom-endpoint-models.ts";
import { registerGoogleCodeAssistProvider } from "../google-code-assist-provider.ts";
import type { CustomEndpointApi } from "./contracts.ts";
import type { PiRuntimeState } from "./runtime-state.ts";
import { debugLog } from "./stdio.ts";

// ============================================================
// Pi Session Management
// ============================================================
export function resolvedCwd(runtimeState: PiRuntimeState): string {
    const wd = runtimeState.initConfig?.cwd || runtimeState.initConfig?.workingDirectory || process.cwd();
    if (wd.startsWith('~/'))
        return join(homedir(), wd.slice(2));
    if (wd === '~')
        return homedir();
    return wd;
}

// Helper: derive preferCustomEndpoint flag from init config
export function shouldPreferCustomEndpoint(runtimeState: PiRuntimeState): boolean {
    return Boolean(runtimeState.initConfig?.customEndpoint && runtimeState.initConfig?.baseUrl?.trim());
}

/**
 * Expose the active Pi model API/provider/base URL to the interceptor process.
 * This gives the interceptor a robust routing hint (instead of brittle URL-only matching).
 */
export function setInterceptorApiHints(model: {
    api?: string;
    provider?: string;
    baseUrl?: string;
} | undefined): void {
    if (!model) {
        delete process.env["CRAFT_PI_MODEL_API"];
        delete process.env["CRAFT_PI_MODEL_PROVIDER"];
        delete process.env["CRAFT_PI_MODEL_BASE_URL"];
        return;
    }
    process.env["CRAFT_PI_MODEL_API"] = model.api || '';
    process.env["CRAFT_PI_MODEL_PROVIDER"] = model.provider || '';
    process.env["CRAFT_PI_MODEL_BASE_URL"] = model.baseUrl || '';
    debugLog(`[interceptor-hint] api=${process.env["CRAFT_PI_MODEL_API"] || '-'} provider=${process.env["CRAFT_PI_MODEL_PROVIDER"] || '-'} baseUrl=${process.env["CRAFT_PI_MODEL_BASE_URL"] || '-'}`);
}

/**
 * Resolve the API key for custom endpoint auth.
 * Returns empty string for local endpoints (Ollama etc.) that don't need auth.
 */
export function resolveCustomEndpointApiKey(runtimeState: PiRuntimeState): string {
    if (runtimeState.initConfig?.piAuth?.credential?.type === 'api_key') {
        return runtimeState.initConfig.piAuth.credential.key;
    }
    const key = runtimeState.initConfig?.apiKey || '';
    if (!key && runtimeState.initConfig?.baseUrl) {
        if (isLocalhostUrl(runtimeState.initConfig.baseUrl)) {
            // Local endpoints (Ollama, LM Studio) don't need auth.
            // Pi SDK requires a truthy apiKey to register models, so use a placeholder.
            return 'not-needed';
        }
        debugLog('[custom-endpoint] Warning: no API key found for non-localhost endpoint — requests will likely fail');
    }
    return key;
}

export function isLocalhostUrl(url: string): boolean {
    try {
        const hostname = new URL(url).hostname;
        const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
            ? hostname.slice(1, -1)
            : hostname;
        return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
    }
    catch {
        return false;
    }
}

export function isStrictLocalEndpointMode(runtimeState: PiRuntimeState): boolean {
    return Boolean(runtimeState.initConfig?.baseUrl
        && isLocalhostUrl(runtimeState.initConfig.baseUrl)
        && process.env["ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS"] !== '1');
}

export function syncStrictLocalEndpointNetworkGuard(runtimeState: PiRuntimeState): void {
    const strictLocal = isStrictLocalEndpointMode(runtimeState);
    process.env["CRAFT_STRICT_LOCAL_ENDPOINT"] = strictLocal ? '1' : '0';
    if (strictLocal) {
        debugLog(`[privacy-guard] Strict loopback-only network guard active for local endpoint: ${runtimeState.initConfig?.baseUrl}`);
    }
}

export function registerCustomEndpointModels(runtimeState: PiRuntimeState, registry: PiModelRegistry, api: CustomEndpointApi, baseUrl: string, models: CustomEndpointModelEntry[]): void {
    for (const m of models) {
        runtimeState.customEndpointModelIds.add(m.id);
        if (m.contextWindow
            || m.supportsImages !== undefined
            || m.supportsThinking !== undefined
            || m.maxTokens !== undefined) {
            runtimeState.customModelOverrides.set(m.id, {
                ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
                ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
                ...(m.supportsThinking !== undefined ? { supportsThinking: m.supportsThinking } : {}),
                ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
            });
        }
    }
    const allIds = [...runtimeState.customEndpointModelIds];
    const normalizedBaseUrl = normalizeCustomEndpointBaseUrl(baseUrl, api);
    registry.registerProvider('custom-endpoint', {
        baseUrl: normalizedBaseUrl,
        apiKey: resolveCustomEndpointApiKey(runtimeState),
        api,
        authHeader: true,
        models: allIds.map(id => buildCustomEndpointModelDef(id, { supportsImages: runtimeState.initConfig?.customEndpoint?.supportsImages === true }, runtimeState.customModelOverrides.get(id), api)),
    });
    debugLog(`Registered custom endpoint: ${normalizedBaseUrl} with ${allIds.length} model(s) [${allIds.join(', ')}], api: ${api}`);
}

/**
 * Create an in-memory auth storage pre-loaded with the user's credentials
 * and a model registry backed by it. Used by both the main session and
 * ephemeral queryLlm sessions.
 */
export async function createAuthenticatedRegistry(runtimeState: PiRuntimeState) {
    runtimeState.moduleAuthStorage ??= new InMemoryCredentialStore();
    const { modelRuntime, modelRegistry } = await createAuthenticatedModelRuntime(runtimeState.moduleAuthStorage, runtimeState.initConfig?.piAuth, runtimeState.initConfig?.apiKey);
    if (runtimeState.initConfig?.piAuth?.provider) {
        const registeredIds = registerSupplementalCatalogModels(modelRegistry, runtimeState.initConfig.piAuth.provider);
        if (registeredIds.length > 0) {
            debugLog(`Registered supplemental Pi models for ${runtimeState.initConfig.piAuth.provider}: ${registeredIds.join(', ')}`);
        }
    }
    if (runtimeState.initConfig?.piAuth?.provider === 'google-gemini-code-assist') {
        registerGoogleCodeAssistProvider(modelRegistry);
        debugLog('Registered Google Gemini Code Assist provider');
    }
    // Register custom endpoint models dynamically via Pi SDK's registerProvider API.
    // This makes arbitrary OpenAI/Anthropic-compatible endpoints work through the Pi SDK
    // by creating synthetic Model<Api> objects that the SDK requires.
    const hasCustomEndpoint = !!runtimeState.initConfig?.baseUrl?.trim();
    if (hasCustomEndpoint && runtimeState.initConfig?.customEndpoint) {
        const { api } = runtimeState.initConfig.customEndpoint;
        const modelEntries: CustomEndpointModelEntry[] = (runtimeState.initConfig.customModels?.length
            ? runtimeState.initConfig.customModels
            : [runtimeState.initConfig.model || 'default']).map(normalizeCustomEndpointModelEntry);
        runtimeState.customEndpointModelIds = new Set(); // Reset on fresh registry creation
        registerCustomEndpointModels(runtimeState, modelRegistry, api, runtimeState.initConfig.baseUrl!.trim(), modelEntries);
    }
    else if (hasCustomEndpoint && !runtimeState.initConfig?.customEndpoint) {
        debugLog('Custom endpoint without protocol config — models may not resolve. Set customEndpoint.api for proper routing.');
    }
    return { modelRuntime, modelRegistry };
}
