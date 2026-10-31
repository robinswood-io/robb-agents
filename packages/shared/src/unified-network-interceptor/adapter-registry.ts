import { anthropicAdapter } from './anthropic.ts';
import { openAiAdapter } from './openai-chat.ts';
import { openAiResponsesAdapter } from './openai-responses.ts';
import type { ApiAdapter } from './tool-metadata.ts';

// ============================================================================
// ADAPTER REGISTRY
// ============================================================================

const adapters: ApiAdapter[] = [anthropicAdapter, openAiResponsesAdapter, openAiAdapter];

/**
 * Resolve Pi model API hint (if provided by pi-agent-server).
 * Example values: anthropic-messages, openai-completions, openai-responses.
 */
function getPiApiHint(): string | undefined {
  const hint = process.env["CRAFT_PI_MODEL_API"]?.trim();
  return hint || undefined;
}

/**
 * Map Pi API hint to adapter name.
 * Exported for focused unit testing.
 */
export function resolveAdapterNameFromPiApiHint(piApiHint?: string): 'anthropic' | 'openai' | 'openai-responses' | undefined {
  if (!piApiHint) return undefined;
  if (piApiHint === 'anthropic-messages') return 'anthropic';
  if (piApiHint === 'openai-completions') return 'openai';
  if (piApiHint === 'openai-responses' || piApiHint === 'azure-openai-responses' || piApiHint === 'openai-codex-responses') {
    return 'openai-responses';
  }
  return undefined;
}

/**
 * Find the matching adapter for a request.
 * Priority:
 * 1) Pi API hint (robust, provider-native)
 * 2) URL pattern fallback (legacy/non-Pi requests)
 */
export function findAdapter(url: string): ApiAdapter | undefined {
  const piApiHint = getPiApiHint();
  const hintedAdapter = resolveAdapterNameFromPiApiHint(piApiHint);
  if (hintedAdapter === 'anthropic') return anthropicAdapter;
  if (hintedAdapter === 'openai') return openAiAdapter;
  if (hintedAdapter === 'openai-responses') return openAiResponsesAdapter;

  return adapters.find(a => a.shouldIntercept(url));
}
