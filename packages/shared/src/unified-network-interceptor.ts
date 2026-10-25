/**
 * Unified fetch interceptor for all AI API requests (Anthropic + OpenAI format).
 *
 * Loaded via --preload (Bun) or --require (Node) into SDK subprocesses.
 * Patches globalThis.fetch before any SDK captures it.
 *
 * Features:
 * - Adds _intent and _displayName metadata to all tool schemas (request)
 * - Re-injects stored metadata into conversation history (request)
 * - Processes SSE response streams per API format:
 *   - Anthropic: STRIPS metadata from stream (SDK validates immediately)
 *   - OpenAI: CAPTURES metadata passthrough (hook strips before execution)
 * - Captures API errors (4xx/5xx) for error handler
 * - Fast mode support for Anthropic (Opus 4.7)
 *
 * Auto-detects API format based on request URL:
 * - Anthropic: baseUrl + /messages
 * - OpenAI: /chat/completions
 */
// Shared infrastructure (toolMetadataStore, error capture, logging, config)
import { DEBUG, debugLog } from "./interceptor-common.ts";
import "./feature-flags.ts";
import { resolveRequestContext } from "./interceptor-request-utils.ts";

import { findAdapter } from './unified-network-interceptor/adapter-registry.ts';
import { NO_PROXY, PROXY_URL, getProxyForUrl, redactProxyUrl } from './unified-network-interceptor/configuration.ts';
import { logResponse, rememberLastOutgoingRequest, synthesizeMalformedBodyResponse, toCurl } from './unified-network-interceptor/observability.ts';
import { MalformedBodyError, stripMetadataFieldsFromRawJson } from './unified-network-interceptor/tool-metadata.ts';

if (PROXY_URL) {
  debugLog(`[proxy] Configured: ${redactProxyUrl(PROXY_URL)}${NO_PROXY ? `, NO_PROXY: ${NO_PROXY}` : ''}`);
}

// ============================================================================
// INTERCEPTED FETCH
// ============================================================================

const originalFetch = globalThis.fetch.bind(globalThis);

function isLoopbackFetchUrl(urlStr: string): boolean {
  try {
    const hostname = new URL(urlStr).hostname;
    const normalized = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
  } catch {
    return false;
  }
}

async function interceptedFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  if (
    process.env.CRAFT_STRICT_LOCAL_ENDPOINT === '1'
    && process.env.ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS !== '1'
    && !isLoopbackFetchUrl(url)
  ) {
    throw new Error(
      `[Privacy Guard] Blocked outbound network request to "${url}" in strict local model mode. Set ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS=1 to allow external network access.`
    );
  }

  const startTime = Date.now();

  if (DEBUG) {
    debugLog('\n' + '='.repeat(80));
    debugLog('\u2192 REQUEST');
    debugLog(toCurl(url, init));
  }

  // Find matching adapter for this URL
  const adapter = findAdapter(url);

  if (
    adapter &&
    ((init?.method ?? (input instanceof Request ? input.method : undefined))?.toUpperCase() === 'POST')
  ) {
    try {
      const { bodyStr, normalizedInit } = await resolveRequestContext(input, init);
      if (bodyStr) {
        let parsed = JSON.parse(bodyStr);

        // Add _intent and _displayName to all tool schemas
        parsed = adapter.addMetadataToTools(parsed);
        // Re-inject stored metadata into conversation history (also runs the
        // Responses-API repair pass before metadata)
        parsed = adapter.injectMetadataIntoHistory(parsed);

        // Pre-flight validation. If the body is structurally invalid for this
        // adapter (duplicate tool_call_id, missing call_id, empty function
        // name, orphan tool result), short-circuit with a synthetic 400 the
        // SDK can surface clearly instead of dying on `400 status code (no
        // body)` from the upstream.
        if (adapter.validateOutgoingBody) {
          try {
            adapter.validateOutgoingBody(parsed);
          } catch (err) {
            if (err instanceof MalformedBodyError) {
              return synthesizeMalformedBodyResponse(err, url, startTime, adapter);
            }
            throw err;
          }
        }

        // Adapter-specific request modifications (e.g., fast mode)
        let modifiedInit = normalizedInit;
        if (adapter.modifyRequest) {
          const result = adapter.modifyRequest(url, normalizedInit, parsed);
          modifiedInit = result.init;
          parsed = result.body;
        }

        const proxy = getProxyForUrl(url);
        const finalBody = JSON.stringify(parsed);
        const finalInit = {
          ...modifiedInit,
          body: finalBody,
          ...(proxy ? { proxy } : {}),
        };

        // Cache a sanitized request summary for the 400-empty-body diagnostic
        // pathway in captureApiError. Plain-text bodies (sensitive arguments)
        // never leave this process.
        rememberLastOutgoingRequest(url, parsed, adapter);

        debugLog(`[${adapter.name}] Intercepted request to ${url}`);
        const response = await originalFetch(url, finalInit);

        // Process SSE response through adapter's stream processor
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('text/event-stream') && response.body) {
          debugLog(`[${adapter.name}] Creating SSE processor (${adapter.stripsSseMetadata ? 'strip' : 'capture'})`);
          const processor = adapter.createSseProcessor();
          const processedBody = response.body.pipeThrough(processor);
          const processedResponse = new Response(processedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
          return logResponse(processedResponse, url, startTime, adapter);
        }

        // Non-SSE response — strip metadata from JSON body if present
        if (contentType.includes('application/json') && response.body) {
          const text = await response.text();
          const stripped = stripMetadataFieldsFromRawJson(text);
          return logResponse(new Response(stripped, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }), url, startTime, adapter);
        }

        return logResponse(response, url, startTime, adapter);
      }
    } catch (e) {
      debugLog(`[${adapter?.name}] FETCH modification failed:`, e);
    }
  }

  const proxy = getProxyForUrl(url);
  const proxyInit = proxy ? { ...init, proxy } : init;
  const response = await originalFetch(input, proxyInit);
  return logResponse(response, url, startTime);
}

// Create proxy to handle both function calls and static properties (e.g., fetch.preconnect in Bun)
const fetchProxy = new Proxy(interceptedFetch, {
  apply(target, thisArg, args) {
    return Reflect.apply(target, thisArg, args);
  },
  get(target, prop, receiver) {
    if (prop in originalFetch) {
      return (originalFetch as unknown as Record<string | symbol, unknown>)[
        prop
      ];
    }
    return Reflect.get(target, prop, receiver);
  },
});

// Auto-install in runtime subprocesses. Tests can disable this side effect.
if (process.env.CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL !== '1') {
  (globalThis as unknown as { fetch: unknown }).fetch = fetchProxy;
  debugLog('Unified fetch interceptor installed');
}

/** Unified fetch interceptor; native API adapters and observability are kept in adjacent modules. */
export { MalformedBodyError, injectMetadataIntoToolSchema, stripMetadataFieldsFromRawJson } from './unified-network-interceptor/tool-metadata.ts';
export { sanitizeEmptyTextCacheControl, upgradePromptCacheTtl } from './unified-network-interceptor/cache-control.ts';
export { createAnthropicSseStrippingStream } from './unified-network-interceptor/anthropic.ts';
export { createOpenAiSseStrippingStream } from './unified-network-interceptor/openai-chat.ts';
export { createOpenAiResponsesSseStrippingStream } from './unified-network-interceptor/openai-responses.ts';
export { sanitizeOpenAiHistoryInPlace, validateOpenAiChatBody, validateOpenAiResponsesBody, repairResponsesHistoryInPlace } from './unified-network-interceptor/history-validation.ts';
export { resolveAdapterNameFromPiApiHint } from './unified-network-interceptor/adapter-registry.ts';
