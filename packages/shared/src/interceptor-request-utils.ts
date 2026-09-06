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
 * Normalize legacy Responses API options that GPT-6 Astra rejects.
 *
 * Pi 0.80.3 can still emit sampling/logprob fields and the former 24-hour
 * prompt-cache option. Astra uses fixed sampling and the newer 30-minute cache
 * configuration, so adapt only requests targeting that exact model.
 *
 * Mutates and returns `body`, matching the interceptor's other request helpers.
 */
export function normalizeGpt6AstraResponsesRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const model = typeof body.model === 'string' ? body.model.replace(/^pi\//, '') : '';
  if (model !== 'gpt-6-astra') return body;

  delete body.temperature;
  delete body.top_p;
  delete body.top_logprobs;
  delete body.logprobs;

  if (Array.isArray(body.include)) {
    const include = body.include.filter(item => item !== 'message.output_text.logprobs');
    if (include.length > 0) body.include = include;
    else delete body.include;
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
