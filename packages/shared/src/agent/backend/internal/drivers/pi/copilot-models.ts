import { isUnknownArray } from '../../../../../utils/json.ts';
import type { ModelDefinition } from "../../../../../config/models.ts";
import { getPiModelsForAuthProvider, isDeprecatedClaudeOpus46Model } from "../../../../../config/models-pi.ts";
import { deriveGitHubCopilotApiBaseUrl, getUnstableProviderContract, getUnstableProviderContractStatus, redactProviderDiagnostic } from "@craft-agent/core";

// ── Copilot model types ────────────────────────────────────────────────
type RawCopilotModel = {
  id: string;
  name: string;
  supportedReasoningEfforts?: string[];
  policy?: { state: string };
  contextWindow?: number;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !isUnknownArray(value);
}

// ── Direct HTTP approach ─────────────────────────────────────────────

const COPILOT_PROVIDER_CONTRACT = getUnstableProviderContract('github-copilot-proxy');

/** Headers versioned alongside the exact Pi SDK contract. */
const COPILOT_HEADERS = COPILOT_PROVIDER_CONTRACT.staticHeaders;

/**
 * Fetch models directly from the Copilot API via HTTP.
 *
 * 1. Exchange GitHub OAuth token → Copilot API token (via Pi SDK)
 * 2. Extract base URL from token's proxy-ep field
 * 3. GET /models to list available models with policy state
 *
 * No CLI subprocess, no PATH issues, no env contamination.
 */
async function listModelsViaHttp(
  githubToken: string,
  timeoutMs: number,
): Promise<RawCopilotModel[]> {
  const { refreshGitHubCopilotToken } = await import("../../../../../auth/copilot-oauth.ts");

  // Step 1: Exchange GitHub OAuth token → Copilot API token
  const creds = await refreshGitHubCopilotToken(githubToken);
  const copilotToken = creds.access;

  // Step 2: Extract base URL from token
  const baseUrl = deriveGitHubCopilotApiBaseUrl(copilotToken);
  if (!baseUrl) {
    throw new Error('Could not extract API base URL from Copilot token (missing proxy-ep)');
  }

  console.warn(`[listModelsViaHttp] token exchange OK, baseUrl=${baseUrl}`);

  // Step 3: GET /models
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `${baseUrl}${COPILOT_PROVIDER_CONTRACT.endpoint.operationPaths!["listModels"]}`,
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${copilotToken}`,
          ...COPILOT_HEADERS,
        },
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Copilot API ${res.status}: ${redactProviderDiagnostic(text, [copilotToken, githubToken]).slice(0, 300)}`,
      );
    }

    const data: unknown = await res.json();
    if (!isRecord(data)) throw new Error('Copilot models API returned an invalid envelope');
    // Handle both { models: [...] } and { data: [...] } response formats.
    const rawModels: unknown = data["models"] || data["data"] || [];
    if (!isUnknownArray(rawModels)) throw new Error('Copilot models API returned an invalid model list');
    const models = rawModels.flatMap((model: unknown): RawCopilotModel[] => {
      if (!isRecord(model) || typeof model["id"] !== 'string') return [];
      const reasoning = model["supportedReasoningEfforts"] || model["supported_reasoning_efforts"];
      const policy = model["policy"];
      const capabilities = model["capabilities"];
      const limits = isRecord(capabilities) ? capabilities["limits"] : undefined;
      const contextWindow = isRecord(limits) ? limits["max_context_window_tokens"] : undefined;
      return [{
        id: model["id"],
        name: typeof model["name"] === 'string' && model["name"] ? model["name"] : model["id"],
        ...(isUnknownArray(reasoning) && reasoning.every((entry: unknown): entry is string => typeof entry === 'string') ? { supportedReasoningEfforts: reasoning } : {}),
        ...(isRecord(policy) && typeof policy["state"] === 'string' ? { policy: { state: policy["state"] } } : {}),
        ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      }];
    });
    console.warn(`[listModelsViaHttp] GET /models returned ${models.length} models`);
    return models;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Copilot models API timed out');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Model ID prefixes to exclude — legacy models that clutter the selector. */
const EXCLUDED_MODEL_PREFIXES = ['gpt-4', 'gpt-3.5'];

/** Filter raw models to only those explicitly enabled by policy, excluding legacy models. */
function filterEnabledModels(models: RawCopilotModel[]): RawCopilotModel[] {
  return models.filter(m =>
    m.policy?.state === 'enabled'
    && !EXCLUDED_MODEL_PREFIXES.some(prefix => m.id.startsWith(prefix))
    && !isDeprecatedClaudeOpus46Model(m.id),
  );
}

/** Convert raw Copilot models to our ModelDefinition format. */
function toModelDefinitions(models: RawCopilotModel[]): ModelDefinition[] {
  return models.map(m => ({
    id: m.id,
    name: m.name,
    shortName: m.name,
    description: '',
    provider: 'pi' as const,
    contextWindow: m.contextWindow || 200_000,
    supportsThinking: !!(m.supportedReasoningEfforts && m.supportedReasoningEfforts.length > 0),
  }));
}

/** Log a breakdown of models by policy state. */
function logModelBreakdown(tag: string, models: RawCopilotModel[]): void {
  const byState = new Map<string, string[]>();
  for (const m of models) {
    const state = m.policy?.state ?? 'no-policy';
    const list = byState.get(state) ?? [];
    list.push(m.id);
    byState.set(state, list);
  }
  const breakdown = [...byState.entries()].map(([s, ids]) => `${s}=${ids.length}(${ids.join(',')})`).join('; ');
  console.warn(`[fetchCopilotModels] ${tag}: total=${models.length} enabled=${filterEnabledModels(models).length} | ${breakdown}`);
}

/**
 * Fetch Copilot models with a 2-tier fallback chain:
 *
 * 1. **Direct HTTP API** – exchange the Pi SDK's GitHub OAuth token for
 *    a Copilot API token, then GET /models. Returns the live model list
 *    with policy state, so we show only enabled models. No CLI subprocess,
 *    no PATH issues, no env contamination.
 * 2. **Pi SDK static catalog** – hardcoded model registry shipped with
 *    the Pi SDK. Not filtered by the user's policy but always available
 *    as a last resort.
 */
export async function fetchCopilotModels(
  piSdkGitHubToken: string,
  timeoutMs: number,
): Promise<ModelDefinition[]> {

  const contractStatus = getUnstableProviderContractStatus(
    'github-copilot-proxy',
    process.env,
  );

  // ── Tier 1: Direct HTTP API ──────────────────────────────────────
  if (contractStatus.enabled) {
    try {
      const raw = await listModelsViaHttp(piSdkGitHubToken, timeoutMs);
      if (raw.length > 0) {
        logModelBreakdown('tier1-httpApi', raw);
        const enabled = filterEnabledModels(raw);
        if (enabled.length > 0) {
          return toModelDefinitions(enabled);
        }
        // All models disabled by policy — unusual but possible.
        // Log it clearly and fall through to static catalog.
        console.warn(`[fetchCopilotModels] tier1-httpApi: ${raw.length} models returned but 0 enabled by policy`);
      }
    } catch (err) {
      console.warn(
        `[fetchCopilotModels] tier1-httpApi failed: ${redactProviderDiagnostic(err, [piSdkGitHubToken])}`,
      );
    }
  } else {
    console.warn(
      `[fetchCopilotModels] tier1-httpApi disabled by provider contract (${contractStatus.source ?? contractStatus.reason})`,
    );
  }

  // ── Tier 2: Pi SDK static catalog (last resort) ──────────────────
  const staticModels = getPiModelsForAuthProvider('github-copilot');
  if (staticModels.length > 0) {
    console.warn(`[fetchCopilotModels] tier2-staticCatalog: falling back to ${staticModels.length} Pi SDK models`);
    return staticModels;
  }

  throw new Error('No Copilot models available from any source.');
}
