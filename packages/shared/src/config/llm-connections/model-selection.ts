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
import type { LlmConnection } from './connection-types.ts';
import { isAnthropicProvider, isPiProvider } from './provider-policy.ts';

// ============================================================
// Helpers
// ============================================================

/**
 * Auth-specific model eligibility shared by catalogs, saved selections and
 * runtime resolution. ChatGPT-account Codex auth only exposes models that the
 * authenticated Codex endpoint can actually execute. Keep this list tied to
 * observed provider rejections rather than the broader Pi registry: the same
 * model ids can remain valid with a regular OpenAI API key.
 * This module is renderer-safe: keep this policy independent of the Pi SDK.
 */
export function isModelAllowedForAuthProvider(modelId: string, piAuthProvider?: string): boolean {
  if (piAuthProvider !== 'openai-codex') return true;
  const bare = modelId.trim().toLowerCase().replace(/^pi\//, '').replace(/^openai-codex\//, '');
  return bare !== 'gpt-5.4'
    && bare !== 'gpt-5.4-mini'
    && bare !== 'gpt-5.3-codex-spark';
}

/**
 * Returns true when `modelId` must NOT be used as the metadata utility model
 * given the current auth flavor.
 *
 * - `codex-mini-latest` is always denied (Pi SDK rejects it outright).
 * - When `piAuthProvider === 'openai-codex'` (ChatGPT Plus/Pro OAuth or
 *   ChatGPT-JWT API key), all `*codex-mini*` variants (e.g. `gpt-5.1-codex-mini`)
 *   are denied — the ChatGPT backend refuses them with: "The '<model>' model is
 *   not supported when using Codex with a ChatGPT account."
 *   A regular OpenAI API key uses provider `'openai'`, which is unaffected.
 */
export function isDeniedMiniModelId(modelId: string, piAuthProvider?: string): boolean {
  if (!isModelAllowedForAuthProvider(modelId, piAuthProvider)) return true;
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  if (bare === 'codex-mini-latest') return true;
  if (piAuthProvider === 'openai-codex' && bare.includes('codex-mini')) return true;
  return false;
}

/**
 * Get the mini/utility model ID for a connection.
 * Provider-aware search:
 *   - Anthropic: find any model with "haiku" in its id/name
 *   - Pi: prefer the named Luna routine tier, then "mini" or "flash"
 *   - Otherwise: last model in the list
 *
 * Auth-flavor-aware: skips models that the user's `piAuthProvider` would reject
 * (e.g. `gpt-5.1-codex-mini` under ChatGPT-account auth). See
 * {@link isDeniedMiniModelId}.
 *
 * Used for low-cost utility work such as titles, task helpers, collection
 * summaries and provider-side context compaction. Callers that require a
 * stronger model must select one explicitly instead of relying on this helper.
 */
export function getMiniModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

/**
 * Provider-aware small model resolution.
 * Implementation for getMiniModel().
 *
 *   - Anthropic: find "haiku"
 *   - Pi: prefer "luna", then find "mini" or "flash"
 *   - Otherwise: last model in the list
 *
 * Skips models denied by {@link isDeniedMiniModelId} for the connection's
 * auth flavor.
 */
function findSmallModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  if (!connection.models || connection.models.length === 0) return undefined;

  const toId = (m: ModelDefinition | string) => typeof m === 'string' ? m : m.id;
  // Saved connection lists can outlive a provider's model support. Exclude
  // ineligible models before keyword search and the final-entry fallback.
  const models = connection.models.filter(m => isModelAllowedForAuthProvider(toId(m), connection.piAuthProvider));
  if (models.length === 0) return undefined;

  const toSearchStr = (m: ModelDefinition | string) =>
    typeof m === 'string' ? m.toLowerCase() : `${m.id} ${m.name} ${m.shortName}`.toLowerCase();

  const isAllowedModel = (m: ModelDefinition | string): boolean =>
    !isDeniedMiniModelId(toId(m), connection.piAuthProvider);

  // Provider-aware keyword search
  const keywords: string[] = [];

  if (isAnthropicProvider(connection.providerType)) {
    keywords.push('haiku');
  } else if (isPiProvider(connection.providerType)) {
    // The current OpenAI family names its inexpensive utility tier Luna; it
    // does not contain the historical "mini" keyword. Without this explicit
    // preference the final-entry fallback selects gpt-5.5 from standard saved
    // connection ordering, making titles, summaries and compactions needlessly
    // expensive.
    keywords.push('luna', 'mini', 'flash');
  } else {
    // Aggregator providers (copilot, etc.) — try all common small-model keywords
    keywords.push('mini', 'haiku', 'flash');
  }

  if (keywords.length > 0) {
    // Keyword order is the provider policy. Model order is only a tiebreaker
    // within one tier; otherwise a legacy mini listed before Luna would defeat
    // the explicit Luna preference above.
    for (const keyword of keywords) {
      const match = models.find(m => isAllowedModel(m) && toSearchStr(m).includes(keyword));
      if (match) return toId(match);
    }
  }

  // An implicit utility role may use another eligible configured model.
  // An all-denied list has no valid fallback; never return a rejected model.
  const fallback = [...models].reverse().find(isAllowedModel);
  return fallback ? toId(fallback) : undefined;
}
