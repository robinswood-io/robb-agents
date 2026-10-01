import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';

// Re-export from shared so the auth-aware mini-model denylist has a single
// source of truth (also used by `getMiniModel()` at selection time).
export { isDeniedMiniModelId } from '../../shared/src/config/llm-connections.ts';

// Re-export the PiModel type used by callers
type PiModel = ReturnType<PiModelRegistry['find']>;

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
  // Strip Craft's pi/ prefix — Pi SDK uses bare model IDs (e.g. "claude-sonnet-4-6")
  const bareId = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;

  // The configured endpoint/provider is a strict boundary. Its missing model
  // must not silently resolve through another provider with the same model ID.
  const provider = preferCustomEndpoint ? 'custom-endpoint' : piAuthProvider;
  if (provider) {
    const exact = modelRegistry.find(provider, bareId)
      ?? modelRegistry.getAll().find(model => (model.id === bareId || model.name === bareId) && model.provider === provider);
    if (exact && provider === 'minimax-cn' && exact.id.startsWith('MiniMax-')) {
      return { ...exact, id: exact.id.slice('MiniMax-'.length) };
    }
    return exact;
  }

  // Legacy connections without a provider can resolve one unambiguous model.
  // An ambiguous ID requires an explicit connection choice.
  const matches = modelRegistry.getAll().filter(model => model.id === bareId || model.name === bareId);
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
