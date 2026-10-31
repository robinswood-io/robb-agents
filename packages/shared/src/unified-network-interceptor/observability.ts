import { isJsonObject, parseJsonObject, isUnknownArray } from '../utils/json.ts';
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
import { DEBUG, debugLog, setStoredError } from "../interceptor-common.ts";
import type { HeadersInitType } from './configuration.ts';
import { PROXY_URL, redactProxyUrl } from './configuration.ts';
import type { ApiAdapter } from './tool-metadata.ts';
import { MalformedBodyError } from './tool-metadata.ts';

// ============================================================================
// ERROR CAPTURE (shared across all adapters)
// ============================================================================

/**
 * Capture API errors from responses for the error handler.
 */
async function captureApiError(response: Response, url: string): Promise<void> {
  if (response.status < 400) return;

  debugLog(`[Attempting to capture error for ${response.status} response]`);
  const errorClone = response.clone();
  try {
    const errorText = await errorClone.text();
    let errorMessage = response.statusText;
    let isHtmlResponse = false;

    try {
      const errorJson = parseJsonObject(errorText);
      const nested = errorJson["error"];
      if (isJsonObject(nested) && typeof nested["message"] === "string") {
        errorMessage = nested["message"];
      } else if (typeof errorJson["message"] === "string") {
        errorMessage = errorJson["message"];
      }
    } catch {
      if (errorText) {
        isHtmlResponse = errorText.trimStart().startsWith('<');
        errorMessage = errorText;
      }
    }

    // An HTML response to a JSON API call means something intercepted the request —
    // a proxy, CDN, captive portal, or firewall. Never show raw HTML to the user.
    if (isHtmlResponse) {
      if (PROXY_URL) {
        errorMessage = `Received an unexpected HTML error page (HTTP ${response.status}) instead of a JSON API response. This may be caused by your network proxy (${redactProxyUrl(PROXY_URL)}). Check your proxy settings in Settings > Network.`;
      } else {
        errorMessage = `Received an unexpected HTML error page (HTTP ${response.status}) instead of a JSON API response. This could be caused by a firewall, captive portal, or network issue.`;
      }
      debugLog(`[Detected HTML error response — replaced raw HTML with clean message]`);
    }

    // Empty-body 400 (#613): some upstreams (Chinese OpenAI-compat relays,
    // misconfigured DeepSeek endpoints) return 400 with no body, leaving
    // users with `400 status code (no body)` and nothing to debug. Attach
    // a sanitized summary of the last outgoing request so the user — and
    // we — have something concrete to act on.
    if (response.status === 400 && !errorText.trim()) {
      const summary = getLastOutgoingRequest(url);
      if (summary) {
        const emptyNames = summary.toolNames.filter(n => n === '<empty>').length;
        const dupIds = summary.toolCallIds.length - new Set(summary.toolCallIds).size;
        const hints: string[] = [];
        if (emptyNames > 0) hints.push(`${emptyNames} tool call(s) with empty name`);
        if (dupIds > 0) hints.push(`${dupIds} duplicate tool_call_id(s)`);
        if (hints.length > 0) {
          errorMessage = `Endpoint rejected the request with no body. Likely cause: ${hints.join(', ')}. ` +
            `This usually means the upstream relay's tool-call streaming is broken — try a different ` +
            `model or endpoint. Last request had ${summary.toolCallIds.length} tool call(s) and ` +
            `${summary.toolResults} tool result(s) over ${summary.historyLength} history entries.`;
        } else {
          errorMessage = `Endpoint rejected the request with no body (no obvious shape problem). ` +
            `Last request: ${summary.toolCallIds.length} tool call(s), ${summary.toolResults} tool ` +
            `result(s), ${summary.historyLength} history entries. Try a different endpoint.`;
        }
        debugLog(`[Empty-body 400 enriched: ${errorMessage}]`);
      }
    }

    setStoredError({
      status: response.status,
      statusText: response.statusText,
      message: errorMessage,
      timestamp: Date.now(),
    });
    debugLog(`[Captured API error: ${response.status} ${errorMessage}]`);
  } catch (e) {
    setStoredError({
      status: response.status,
      statusText: response.statusText,
      message: response.statusText,
      timestamp: Date.now(),
    });
    debugLog(`[Error reading body, capturing basic info: ${e}]`);
  }
}

// ============================================================================
// DEBUG LOGGING (shared)
// ============================================================================

/**
 * Convert headers to cURL -H flags, redacting sensitive values
 */
function headersToCurl(headers: HeadersInitType | undefined): string {
  if (!headers) return '';

  const normalized = isUnknownArray(headers) ? headers.map((pair): [string, string] => {
    const [name, value] = pair;
    if (name === undefined || value === undefined) throw new TypeError('Invalid header pair');
    return [name, value];
  }) : headers;
  const headerObj = Object.fromEntries(new Headers(normalized).entries());

  const sensitiveKeys = [
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
  ];

  return Object.entries(headerObj)
    .map(([key, value]) => {
      const redacted = sensitiveKeys.includes(key.toLowerCase())
        ? '[REDACTED]'
        : value;
      return `-H '${key}: ${redacted}'`;
    })
    .join(' \\\n  ');
}

/**
 * Format a fetch request as a cURL command
 */
export function toCurl(url: string, init?: RequestInit): string {
  const method = init?.method?.toUpperCase() ?? 'GET';
  const headers = headersToCurl(init?.headers as HeadersInitType | undefined);

  let curl = `curl -X ${method}`;
  if (headers) {
    curl += ` \\\n  ${headers}`;
  }
  if (init?.body && typeof init.body === 'string') {
    const escapedBody = init.body.replace(/'/g, "'\\''");
    curl += ` \\\n  -d '${escapedBody}'`;
  }
  curl += ` \\\n  '${url}'`;

  return curl;
}

/**
 * Log response and capture API errors.
 */
export async function logResponse(response: Response, url: string, startTime: number, adapter?: ApiAdapter): Promise<Response> {
  const duration = Date.now() - startTime;

  // Capture API errors (runs regardless of DEBUG mode)
  if (adapter) {
    await captureApiError(response, url);
  }

  if (!DEBUG) return response;

  debugLog(`\n\u2190 RESPONSE ${response.status} ${response.statusText} (${duration}ms)`);
  debugLog(`  URL: ${url}`);

  const sensitiveRespKeys = new Set([
    'set-cookie',
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
  ]);
  const respHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    respHeaders[key] = sensitiveRespKeys.has(key.toLowerCase()) ? '[REDACTED]' : value;
  });
  debugLog('  Headers:', respHeaders);

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    debugLog('  Body: [SSE stream - not logged]');
    return response;
  }

  const clone = response.clone();
  try {
    const text = await clone.text();
    const maxLogSize = 5000;
    if (text.length > maxLogSize) {
      debugLog(`  Body (truncated to ${maxLogSize} chars):\n${text.substring(0, maxLogSize)}...`);
    } else {
      debugLog(`  Body:\n${text}`);
    }
  } catch (e) {
    debugLog('  Body: [failed to read]', e);
  }

  return response;
}

// ============================================================================
// REQUEST DIAGNOSTICS
// ============================================================================

/**
 * Sanitized snapshot of the most recent intercepted request body. Captured so
 * the empty-body 400 diagnostic can attach actionable context (which tools the
 * model tried to call) instead of letting users see "400 status code (no
 * body)" with nothing to act on.
 *
 * Tool arguments are NEVER stored — only counts, ids, and names. The data
 * never leaves this process; it's read by {@link captureApiError} and woven
 * into the stored error message.
 */
interface OutgoingRequestSummary {
  url: string;
  adapter: string;
  /** Timestamp the request was prepared (not sent). Used to expire stale entries. */
  preparedAt: number;
  /** Tool-call ids visible in the assistant tool_calls / function_call entries. */
  toolCallIds: string[];
  /** Tool names referenced. Empty strings are reported as "<empty>". */
  toolNames: string[];
  /** Number of tool result / function_call_output entries. */
  toolResults: number;
  /** Number of messages or input entries (whichever the adapter uses). */
  historyLength: number;
}

let lastOutgoingRequest: OutgoingRequestSummary | undefined;

export function rememberLastOutgoingRequest(
  url: string,
  body: Record<string, unknown>,
  adapter: ApiAdapter,
): void {
  const summary: OutgoingRequestSummary = {
    url,
    adapter: adapter.name,
    preparedAt: Date.now(),
    toolCallIds: [],
    toolNames: [],
    toolResults: 0,
    historyLength: 0,
  };

  if (adapter.name === 'openai') {
    const messages = body["messages"] as Array<Record<string, unknown>> | undefined;
    if (isUnknownArray(messages)) {
      summary.historyLength = messages.length;
      for (const msg of messages) {
        if (msg["role"] === 'assistant' && isUnknownArray(msg["tool_calls"])) {
          for (const tc of msg["tool_calls"] as Array<{ id?: unknown; function?: { name?: unknown } }>) {
            if (typeof tc.id === 'string') summary.toolCallIds.push(tc.id);
            const name = typeof tc.function?.name === 'string' ? tc.function.name : '';
            summary.toolNames.push(name || '<empty>');
          }
        }
        if (msg["role"] === 'tool') summary.toolResults++;
      }
    }
  } else if (adapter.name === 'openai-responses') {
    const input = body["input"] as Array<Record<string, unknown>> | undefined;
    if (isUnknownArray(input)) {
      summary.historyLength = input.length;
      for (const entry of input) {
        if (entry["type"] === 'function_call') {
          if (typeof entry["call_id"] === 'string') summary.toolCallIds.push(entry["call_id"]);
          const name = typeof entry["name"] === 'string' ? entry["name"] : '';
          summary.toolNames.push(name || '<empty>');
        } else if (entry["type"] === 'function_call_output') {
          summary.toolResults++;
        }
      }
    }
  }

  lastOutgoingRequest = summary;
}

/** Read by captureApiError; null when no recent request or summary is stale (>30s). */
function getLastOutgoingRequest(forUrl: string): OutgoingRequestSummary | undefined {
  if (!lastOutgoingRequest) return undefined;
  if (Date.now() - lastOutgoingRequest.preparedAt > 30_000) return undefined;
  if (lastOutgoingRequest.url !== forUrl) return undefined;
  return lastOutgoingRequest;
}

/**
 * Build a synthetic 400 Response that mimics OpenAI's error envelope so the
 * SDK surfaces the structured error instead of dying on a generic 400. Used
 * when {@link MalformedBodyError} fires before the request hits the wire.
 */
export function synthesizeMalformedBodyResponse(
  err: MalformedBodyError,
  url: string,
  startTime: number,
  adapter: ApiAdapter,
): Promise<Response> {
  const body = JSON.stringify({
    error: {
      type: 'invalid_request_error',
      code: err.code,
      message: `Robb Agents blocked an outgoing request that the API would reject: ${err.detail}. ` +
        `This typically indicates a streaming-reassembly bug in the upstream endpoint or a stale ` +
        `tool history. Try starting a new session or switching to a different model/endpoint.`,
      param: 'tool_calls',
    },
  });

  debugLog(`[${adapter.name}] Outgoing body validation failed (${err.code}); synthesizing 400 response`);

  setStoredError({
    status: 400,
    statusText: 'Bad Request (blocked by Robb Agents)',
    message: err.detail,
    timestamp: Date.now(),
  });

  return logResponse(
    new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
    }),
    url,
    startTime,
    adapter,
  );
}
