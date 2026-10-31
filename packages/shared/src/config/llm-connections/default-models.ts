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
import type { LlmConnectionWithStatus, LlmProviderType } from './connection-types.ts';
import { _piModelResolver } from './connection-types.ts';
import { isModelAllowedForAuthProvider } from './model-selection.ts';

/**
 * Get the default model list for a connection's provider type.
 * Unlike getModelsForProviderType(), this handles compat providers by returning
 * the appropriate compat-prefixed model IDs instead of an empty array.
 *
 * Use this whenever you need to populate or backfill a connection's models.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model list (ModelDefinition[] for standard, string[] for compat)
 */
/**
 * Preferred default model IDs per Pi auth provider.
 * The Pi SDK returns models in arbitrary order (alphabetical by ID), which means
 * deprecated models like claude-3-5-haiku-20241022 can end up first.
 * This map ensures getDefaultModelForConnection() picks a modern, capable model.
 *
 * Format: bare model IDs (without pi/ prefix). Matched against pi/{id} or pi/{id}-*.
 */
export const PI_PREFERRED_DEFAULTS: Record<string, string[]> = {
  anthropic: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  // Keep Sol as the default/utility model. Adaptive routing selects Astra only
  // for work whose policy classification requires the flagship tier.
  openai: ['gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-pro', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  'openai-codex': ['gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-pro', 'gpt-5.3-codex', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o'],
  // Stable models first so the connection-setup test (which uses
  // getDefaultModelForConnection) lands on a reliable model.
  // gemini-3-pro-preview and gemini-3.1-pro-preview are intermittently
  // unresponsive on generateContent — verified against the live API in
  // April 2026 — and are deliberately excluded from defaults.
  google: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it'],
  'google-gemini-code-assist': ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'],
  'google-antigravity': [
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gemini-3.7-flash-high',
    'gemini-3.7-flash-medium',
    'gemini-3.7-flash-low',
    'gemini-3.1-pro-high',
    'gpt-oss-120b-medium',
  ],
  // Mistral Medium 3.5 is Mistral's frontier agentic/coding model; Small 4
  // is its efficient unified instruct/reasoning/coding alternative. Keep a
  // lightweight Ministral option last for mini/summarization work.
  mistral: ['mistral-medium-3-5', 'mistral-medium-3.5', 'mistral-medium-2604', 'mistral-small-latest', 'ministral-3b-latest', 'devstral-latest', 'codestral-latest'],
  // Mistral Vibe manages the selected model inside the authenticated Vibe
  // profile. Robb intentionally stores no token or model API credential.
  'mistral-vibe': ['mistral-vibe'],
  deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  'github-copilot': ['claude-fable-5', 'claude-opus-4.8', 'claude-opus-4.7', 'claude-sonnet-4.6', 'claude-sonnet-4-6', 'gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gpt-5.4', 'gpt-5.3-codex', 'gpt-5', 'o4-mini', 'claude-haiku-4.5', 'claude-haiku-4-5'],
  'amazon-bedrock': ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  xai: ['grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-code-fast-1', 'grok-4-fast-reasoning'],
  zai: ['glm-5.2', 'glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-5v-turbo', 'glm-4.7', 'glm-4.7-flash'],
  minimax: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
  'minimax-cn': ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed'],
  'kimi-coding': ['k2p7', 'kimi-for-coding', 'kimi-k2-thinking', 'k2p5'],
  groq: ['openai/gpt-oss-120b', 'qwen/qwen3-32b', 'meta-llama/llama-4-maverick-17b-128e-instruct', 'meta-llama/llama-4-scout-17b-16e-instruct', 'openai/gpt-oss-20b'],
  cerebras: ['gpt-oss-120b', 'zai-glm-4.7', 'qwen-3-235b-a22b-instruct-2507'],
};

export function getDefaultModelsForConnection(providerType: LlmProviderType, piAuthProvider?: string): Array<ModelDefinition | string> {
  if (providerType === 'pi') {
    const models = _piModelResolver(piAuthProvider)
      .filter(model => isModelAllowedForAuthProvider(model.id, piAuthProvider));
    // Sort preferred defaults first so getDefaultModelForConnection picks a modern model.
    // For Bedrock models, the Pi SDK returns IDs like pi/us.anthropic.claude-opus-4-8
    // but preferred defaults use bare IDs. Strip the transport namespace only:
    // legacy migration helpers would rank an old model as its newer replacement
    // while leaving the old request ID unchanged.
    const preferred = (piAuthProvider && PI_PREFERRED_DEFAULTS[piAuthProvider]) || [];
    if (preferred.length > 0) {
      const findPreferredIndex = (id: string): number => {
        const bare = id.startsWith('pi/') ? id.slice(3) : id
        const modelId = piAuthProvider === 'amazon-bedrock'
          ? bare.replace(/^(?:(?:[a-z]{2}|global)\.)?anthropic\./, '').replace(/-v\d+(?::\d+)?$/, '')
          : bare
        const exact = preferred.indexOf(modelId)
        return exact >= 0 ? exact : preferred.findIndex(p => modelId.startsWith(`${p}-`))
      }
      models.sort((a, b) => {
        const aPrio = findPreferredIndex(a.id) ?? preferred.length;
        const bPrio = findPreferredIndex(b.id) ?? preferred.length;
        return (aPrio >= 0 ? aPrio : preferred.length) - (bPrio >= 0 ? bPrio : preferred.length);
      });
    }
    return models;
  }
  if (providerType === 'pi_compat') return [];  // Dynamic — user specifies
  // anthropic
  return ANTHROPIC_MODELS;
}

/**
 * Get the default model ID for a connection's provider type.
 * Derived from the first entry in getDefaultModelsForConnection() — single source of truth.
 *
 * @param providerType - Provider type from the connection
 * @param piAuthProvider - Optional Pi auth provider for filtering Pi models
 * @returns Default model ID string
 */
export function getDefaultModelForConnection(providerType: LlmProviderType, piAuthProvider?: string): string {
  const models = getDefaultModelsForConnection(providerType, piAuthProvider);
  const first = models[0];
  if (!first) return '';  // Dynamic provider — no default
  return typeof first === 'string' ? first : first.id;
}

/**
 * Resolve the effective LLM connection slug from available fallbacks.
 *
 * Single source of truth for the fallback chain used everywhere in the UI:
 *   1. Explicit session connection (locked after first message)
 *   2. Workspace-level default override
 *   3. Global default (isDefault flag on a connection)
 *   4. First available connection
 *
 * @param sessionConnection  - Per-session connection slug (session.llmConnection)
 * @param workspaceDefault   - Workspace-level default connection slug
 * @param connections        - All available connections (with status metadata)
 * @returns The resolved slug, or undefined when no connections exist
 */
export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  return sessionConnection
    ?? workspaceDefault
    ?? connections.find(c => c.isDefault)?.slug
    ?? connections[0]?.slug
}

/**
 * Check if a session's locked connection is unavailable (deleted/removed).
 * Returns true only when a session has an explicit llmConnection that doesn't
 * match any current connection. Sessions without a stored connection (using
 * the fallback chain) are never "unavailable".
 *
 * @param sessionConnection - Per-session connection slug (session.llmConnection)
 * @param connections - All available connections
 * @returns true if the session's connection no longer exists
 */
export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  if (!sessionConnection) return false
  return !connections.some(c => c.slug === sessionConnection)
}
