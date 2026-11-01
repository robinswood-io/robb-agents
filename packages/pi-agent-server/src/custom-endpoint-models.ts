export type CustomEndpointInput = 'text' | 'image'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
  supportsThinking?: boolean
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  supportsImages?: boolean
  supportsThinking?: boolean
  maxTokens?: number
}

export interface CustomEndpointModelEntry extends CustomEndpointModelOverrides {
  id: string
}

export type CustomEndpointModelConfig = string | {
  id: string
  contextWindow?: number
  supportsImages?: boolean
  supportsThinking?: boolean
  maxTokens?: number
}

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/**
 * Normalize a custom endpoint base URL for the selected protocol.
 *
 * OpenAI-compatible local servers (Ollama on :11434, LM Studio on :1234,
 * vLLM / llama.cpp on :8000/:8080) mount chat completions at `/v1/chat/completions`.
 * When the user enters a bare origin such as `http://localhost:11434`, append
 * `/v1` automatically for `openai-completions` while leaving explicit paths
 * (e.g. `/v1`, `/api/v1`, `/api/coding/paas/v4`) and `anthropic-messages`
 * base URLs intact.
 */
export function normalizeCustomEndpointBaseUrl(
  baseUrl: string,
  api: 'openai-completions' | 'anthropic-messages' | string = 'openai-completions',
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (api !== 'openai-completions') return trimmed

  try {
    const parsed = new URL(trimmed)
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${trimmed}/v1`
    }
  } catch {
    // Non-standard URL string — return trimmed as-is
  }
  return trimmed
}

/**
 * Infer whether a local/custom model ID belongs to a reasoning-capable family
 * when no explicit `supportsThinking` override was configured.
 */
export function inferLocalModelReasoning(id: string): boolean {
  const bare = stripPiPrefix(id).toLowerCase()
  return /(?:deepseek-r1|(?:\b|[-_/:])r1(?:\b|[-_/:])|qwq|qwen3(?!.*coder)|gpt-oss|magistral|kimi-k2-thinking|glm-z1|glm-5|minimax-m2|minimax-m3|thinking|reason|(?:\b|[-_/:])(?:o1|o3|o4)(?:\b|[-_/:])|openthinker|marco-o1|skywork-o1|nemotron-nano|phi-?4-reasoning)/i.test(bare)
}

/**
 * Build safe compatibility overrides for custom/local endpoints so Pi AI does
 * not emit OpenAI-proprietary fields (`store`, `developer` role, `strict: false`,
 * `max_completion_tokens`, or unsupported `reasoning_effort`) that local
 * servers (Ollama, LM Studio, vLLM, llama.cpp, MLX) reject or mishandle.
 */
export function buildCustomEndpointCompat(
  id: string,
  api: 'openai-completions' | 'anthropic-messages' = 'openai-completions',
) {
  if (api === 'anthropic-messages') {
    return {
      supportsEagerToolInputStreaming: false,
      supportsCacheControlOnTools: false,
      supportsLongCacheRetention: false,
    }
  }

  const bare = stripPiPrefix(id)
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: /(?:^|\/)(?:gpt-oss|o1|o3|o4)(?:\b|[-_:])/i.test(bare),
    maxTokensField: 'max_tokens' as const,
    supportsStrictMode: false,
    supportsLongCacheRetention: false,
  }
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keep explicit per-model capability overrides intact. In particular,
 * `supportsImages: false` is meaningful because it can override a global
 * endpoint default of `supportsImages: true` for text-only models.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return {
    id: stripPiPrefix(model.id),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
    ...(model.supportsThinking !== undefined ? { supportsThinking: model.supportsThinking } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
  }
}

/**
 * Build a synthetic model definition for a custom endpoint.
 * Uses reasonable defaults for context window and max tokens since we can't
 * query the endpoint for its actual capabilities. Image and reasoning support
 * can be explicitly enabled either at the connection level or per-model, with
 * automatic reasoning family detection when not explicitly overridden.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
  api: 'openai-completions' | 'anthropic-messages' = 'openai-completions',
) {
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? false
  const reasoning = overrides?.supportsThinking ?? defaults?.supportsThinking ?? inferLocalModelReasoning(id)
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']

  return {
    id,
    name: id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? 131_072,
    maxTokens: overrides?.maxTokens ?? (reasoning ? 16_384 : 8_192),
    compat: buildCustomEndpointCompat(id, api),
  }
}
