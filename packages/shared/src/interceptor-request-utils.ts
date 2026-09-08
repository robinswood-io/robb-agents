/**
 * Resolve method/body/headers from fetch(input, init), including Request inputs.
 */
export async function resolveRequestContext(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<{ bodyStr?: string; normalizedInit: RequestInit }> {
  // Prefer explicit init body (already detached from Request stream)
  if (typeof init?.body === 'string') {
    return { bodyStr: init.body, normalizedInit: init };
  }

  // Fallback: parse Request body when caller used fetch(new Request(...))
  if (input instanceof Request) {
    try {
      const bodyStr = await input.clone().text();
      const normalizedInit: RequestInit = {
        method: init?.method ?? input.method,
        headers: init?.headers ?? input.headers,
        body: init?.body ?? bodyStr,
      };
      return { bodyStr, normalizedInit };
    } catch {
      // Ignore body read errors — interception will be skipped
    }
  }

  return { bodyStr: undefined, normalizedInit: init ?? {} };
}

/**
 * Normalize legacy Responses API options for the current OpenAI models.
 *
 * Pi 0.80.3 can still emit sampling/logprob fields and the former 24-hour
 * prompt-cache option. GPT-5.6 and Astra use the 30-minute cache configuration;
 * Astra also rejects sampling fields. Preserve all other model requests.
 *
 * Mutates and returns `body`, matching the interceptor's other request helpers.
 */
export function normalizeOpenAiResponsesRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const model = typeof body.model === 'string' ? body.model.replace(/^pi\//, '') : '';
  const isAstra = model === 'gpt-6-astra';
  const usesCurrentPromptCache = isAstra || [
    'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ].includes(model);
  if (!usesCurrentPromptCache) return body;

  if (isAstra) {
    delete body.temperature;
    delete body.top_p;
    delete body.top_logprobs;
    delete body.logprobs;

    if (Array.isArray(body.include)) {
      const include = body.include.filter(item => item !== 'message.output_text.logprobs');
      if (include.length > 0) body.include = include;
      else delete body.include;
    }
  }

  if (typeof body.prompt_cache_retention === 'string') {
    const existingOptions = body.prompt_cache_options;
    body.prompt_cache_options = {
      ...(existingOptions && typeof existingOptions === 'object' && !Array.isArray(existingOptions)
        ? existingOptions as Record<string, unknown>
        : {}),
      ttl: '30m',
    };
  }
  delete body.prompt_cache_retention;

  return body;
}

/**
 * Pi 0.80.3 only recognizes the older dotted Medium 3.5 alias when selecting
 * Mistral's adjustable reasoning. Its canonical ID and 2604 snapshot otherwise
 * receive the legacy Magistral prompt mode. Correct the serialized native API
 * request while preserving the selected model, explicit effort and history.
 * https://docs.mistral.ai/studio/conversations/reasoning
 */
export function normalizeMistralChatRequest(
  url: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    return body;
  }
  if (endpoint.hostname !== 'api.mistral.ai' || endpoint.pathname !== '/v1/chat/completions') return body;
  if (body.model !== 'mistral-medium-3-5' && body.model !== 'mistral-medium-2604') return body;
  if (body.prompt_mode !== 'reasoning') return body;

  if (body.reasoning_effort === undefined) body.reasoning_effort = 'high';
  delete body.prompt_mode;
  return body;
}
