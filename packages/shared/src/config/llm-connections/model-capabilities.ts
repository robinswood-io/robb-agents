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
import { type ModelDefinition, ANTHROPIC_MODELS } from "../models";
import type { LlmConnection, LlmProviderType } from './connection-types.ts';
import { _piModelResolver } from './connection-types.ts';
import { isCompatProvider } from './provider-policy.ts';

/**
 * Return a new LlmConnection with the given model's `supportsImages` override set.
 *
 * Centralizes the string-vs-object normalization for `connection.models[]`:
 *   - string entry → promoted to `{ id, name, shortName, supportsImages: enabled }`
 *   - object entry → only `supportsImages` is updated
 *   - model not in array → connection returned unchanged (defensive)
 *
 * Pure function — does not mutate the input. Storage round-trip is handled
 * upstream via `saveLlmConnection`. The stored object form for custom-endpoint
 * models is `{ id, name?, shortName?, contextWindow?, supportsImages? }`
 * (passthrough-validated by the storage schema). `name` and `shortName` default
 * to the model's `id` when promoting so that downstream renderer surfaces that
 * read `m.name` (the trigger button display, picker row labels) keep showing a
 * label after the toggle promotes a string entry. The `ModelDefinition` cast
 * matches the existing shape produced by `ApiKeyInput.tsx` and the Pi driver.
 */
export function setModelSupportsImages(
  connection: LlmConnection,
  modelId: string,
  enabled: boolean,
): LlmConnection {
  if (!connection.models) return connection;
  const idOf = (m: ModelDefinition | string) => (typeof m === 'string' ? m : m.id);
  const idx = connection.models.findIndex(m => idOf(m) === modelId);
  if (idx === -1) return connection;

  const entry = connection.models[idx]!;
  const nextEntry =
    typeof entry === 'string'
      ? { id: entry, name: entry, shortName: entry, supportsImages: enabled }
      : { ...entry, supportsImages: enabled };

  const nextModels = connection.models.slice();
  nextModels[idx] = nextEntry as ModelDefinition;
  return { ...connection, models: nextModels };
}

/**
 * Resolve whether a given model on a connection accepts image input.
 *
 * For `pi_compat` (custom-endpoint) connections this mirrors the precedence used
 * by Pi's `buildCustomEndpointModelDef`:
 *   per-model `supportsImages` override
 *   ?? connection-level `customEndpoint.supportsImages` default
 *   ?? false
 *
 * Built-in catalogs also carry provider capabilities. Honor an explicit value
 * there before keeping the historical true fallback for unknown native models.
 */
export function modelSupportsImages(
  connection: Pick<LlmConnection, 'providerType' | 'models' | 'customEndpoint'>,
  modelId: string,
): boolean {
  const entry = connection.models?.find(m =>
    (typeof m === 'string' ? m : m.id) === modelId,
  );
  if (entry && typeof entry !== 'string' && typeof entry.supportsImages === 'boolean') {
    return entry.supportsImages;
  }
  return isCompatProvider(connection.providerType)
    ? connection.customEndpoint?.supportsImages ?? false
    : true;
}

/**
 * Get the default model list for a provider type from the registry.
 * For *_compat providers, returns empty array - those should use connection.models instead.
 *
 * @param providerType - Provider type
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Model list from registry, or empty array for compat providers
 */
export function getModelsForProviderType(providerType: LlmProviderType, piAuthProvider?: string): ModelDefinition[] {
  // Compat providers require explicit model lists from the connection
  if (isCompatProvider(providerType)) {
    return [];
  }

  // Pi: fetch models via registered resolver (avoids Pi SDK import in renderer)
  if (providerType === 'pi') {
    return _piModelResolver(piAuthProvider);
  }

  // Anthropic uses Claude models with bare Anthropic IDs.
  return ANTHROPIC_MODELS;
}
