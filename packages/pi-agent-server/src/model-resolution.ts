import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';
import { isModelAllowedForAuthProvider, PI_PREFERRED_DEFAULTS } from '../../shared/src/config/llm-connections.ts';

// Re-export from shared so the auth-aware mini-model denylist has a single
// source of truth (also used by `getMiniModel()` at selection time).
export { isDeniedMiniModelId } from '../../shared/src/config/llm-connections.ts';

// Re-export the PiModel type used by callers
type PiModel = ReturnType<PiModelRegistry['find']>;

/**
 * Codex sessions must pass an explicit eligible model to the SDK, including
 * when the host has no selection: otherwise the SDK can restore a retired
 * model from its own settings/history without passing through our resolver.
 * Other providers retain their existing implicit-default behavior.
 */
export function resolveInitialPiModel(
  modelRegistry: PiModelRegistry,
  modelId: string | undefined,
  piAuthProvider?: string,
  preferCustomEndpoint?: boolean,
): PiModel {
  if (modelId) return requireExplicitPiModel(modelRegistry, modelId, piAuthProvider, preferCustomEndpoint);
  if (piAuthProvider !== 'openai-codex') return undefined;

  const candidates = [
    ...(PI_PREFERRED_DEFAULTS[piAuthProvider] ?? []),
    ...modelRegistry.getAll().filter(model => model.provider === piAuthProvider).map(model => model.id),
  ];
  for (const candidate of new Set(candidates)) {
    const model = resolvePiModel(modelRegistry, candidate, piAuthProvider);
    // An implicit choice must not switch to a custom endpoint or another provider.
    if (model?.provider === piAuthProvider) return model;
  }
  throw new Error(`No supported Pi model is available for provider "${piAuthProvider}"`);
}

/** Preserve model eligibility across dynamic custom-endpoint registration. */
export function resolvePiModelWithCustomFallback(
  modelRegistry: PiModelRegistry,
  modelId: string,
  piAuthProvider?: string,
  preferCustomEndpoint?: boolean,
  registerCustomModel?: (bareId: string) => void,
): PiModel {
  if (!isModelAllowedForAuthProvider(modelId, piAuthProvider)) return undefined;
  const model = resolvePiModel(modelRegistry, modelId, piAuthProvider, preferCustomEndpoint);
  if (model || !registerCustomModel) return model;
  const bareId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  registerCustomModel(bareId);
  return resolvePiModel(modelRegistry, modelId, piAuthProvider, preferCustomEndpoint);
}

/**
 * Resolve the chosen Pi SDK model within the configured provider.
 *
 * Resolution order:
 * 1. Explicit custom endpoint or configured authentication provider
 * 2. Exact model ID/name within that provider
 * 3. Legacy provider-less connections: one unambiguous model match only
 */
export function resolvePiModel(
  modelRegistry: PiModelRegistry,
  modelId: string,
  piAuthProvider?: string,
  preferCustomEndpoint?: boolean,
): PiModel {
  // Reject stale selections before any fallback, including custom endpoints.
  // Also check each resolved ID: registry lookups may accept a display-name alias.
  if (!isModelAllowedForAuthProvider(modelId, piAuthProvider)) return undefined;
  const isAllowedModel = (model: NonNullable<PiModel>): boolean =>
    isModelAllowedForAuthProvider(model.id, piAuthProvider)
    && isModelAllowedForAuthProvider(model.id, model.provider);

  // Strip Craft's pi/ prefix — Pi SDK uses bare model IDs (e.g. "claude-sonnet-4-6")
  const bareId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;

  // The configured endpoint/provider is a strict boundary. Its missing model
  // must not silently resolve through another provider with the same model ID.
  const provider = preferCustomEndpoint ? 'custom-endpoint' : piAuthProvider;
  if (provider) {
    const exact = modelRegistry.find(provider, bareId)
      ?? modelRegistry.getAll().find(model => (model.id === bareId || model.name === bareId) && model.provider === provider);
    if (exact && isAllowedModel(exact) && provider === 'minimax-cn' && exact.id.startsWith('MiniMax-')) {
      return { ...exact, id: exact.id.slice('MiniMax-'.length) };
    }
    return exact && isAllowedModel(exact) ? exact : undefined;
  }

  // Legacy connections without a provider can resolve one unambiguous model.
  // An ambiguous ID requires an explicit connection choice.
  const matches = modelRegistry.getAll().filter(model =>
    (model.id === bareId || model.name === bareId) && isAllowedModel(model));
  if (matches.length === 1) return matches[0];

  return undefined;
}

/**
 * Resolve a model that the user selected explicitly.
 *
 * Callers must not omit the model from session options when this fails: doing
 * so makes Pi silently select its own default model, which can route a request
 * to a provider/model the user did not choose.
 */
export function requireExplicitPiModel(
  modelRegistry: PiModelRegistry,
  modelId: string,
  piAuthProvider?: string,
  preferCustomEndpoint?: boolean,
): NonNullable<PiModel> {
  const model = resolvePiModel(modelRegistry, modelId, piAuthProvider, preferCustomEndpoint);
  if (!model) {
    throw new Error(
      `Explicitly selected Pi model "${modelId}" could not be resolved for provider "${piAuthProvider ?? '(unknown)'}"`,
    );
  }

  const expectedProvider = preferCustomEndpoint ? 'custom-endpoint' : piAuthProvider;
  if (expectedProvider && model.provider !== expectedProvider) {
    throw new Error(
      `Explicitly selected Pi model "${modelId}" resolved to incompatible provider "${model.provider}" (expected "${expectedProvider}")`,
    );
  }

  return model;
}

/**
 * Recognize an unavailable requested model without authorizing a replacement.
 * Matches both the standard OpenAI "model not found"
 * shapes and the ChatGPT-account Codex "… is not supported" refusal.
 */
export function isModelNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('model_not_found') ||
    normalized.includes('does not exist') ||
    normalized.includes('no such model') ||
    normalized.includes('is not supported') ||
    (normalized.includes('requested model') && normalized.includes('not') && normalized.includes('exist'))
  );
}
