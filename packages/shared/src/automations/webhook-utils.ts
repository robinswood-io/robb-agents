/**
 * Webhook Execution Utilities
 *
 * Shared webhook HTTP execution logic used by both the production WebhookHandler
 * and the RPC test handler. Centralizes timeout, body consumption, request building,
 * env var expansion, and retry logic so the two code paths can't diverge.
 */

import type { WebhookAction, WebhookActionResult } from './types.ts';
import { expandEnvVars } from './utils.ts';
import { DEFAULT_WEBHOOK_METHOD, HISTORY_FIELD_MAX_LENGTH } from './constants.ts';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Redact a URL for safe logging. Webhook URLs may contain secrets
 * (e.g., Slack webhook paths). Keep scheme + host, truncate long paths.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.length > 20) {
      return `${parsed.origin}${parsed.pathname.slice(0, 15)}...`;
    }
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.slice(0, 30) + '...';
  }
}

/**
 * Create a webhook history entry for appending to the history JSONL file.
 */
export function createWebhookHistoryEntry(opts: {
  matcherId: string;
  ok: boolean;
  method?: string;
  url: string;
  statusCode: number;
  durationMs: number;
  attempts?: number;
  error?: string;
  responseBody?: string;
}): Record<string, unknown> {
  return {
    id: opts.matcherId,
    ts: Date.now(),
    ok: opts.ok,
    webhook: {
      method: opts.method ?? DEFAULT_WEBHOOK_METHOD,
      url: redactUrl(opts.url),
      statusCode: opts.statusCode,
      durationMs: opts.durationMs,
      ...(opts.attempts && opts.attempts > 1 ? { attempts: opts.attempts } : {}),
      ...(opts.error ? { error: opts.error.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
      ...(opts.responseBody ? { responseBody: opts.responseBody.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
    },
  };
}

/**
 * Create a prompt-action history entry for appending to the history JSONL file.
 */
export function createPromptHistoryEntry(opts: {
  matcherId: string;
  ok: boolean;
  sessionId?: string;
  prompt?: string;
  error?: string;
}): Record<string, unknown> {
  return {
    id: opts.matcherId,
    ts: Date.now(),
    ok: opts.ok,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.prompt ? { prompt: opts.prompt.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
    ...(opts.error ? { error: opts.error.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
  };
}

/**
 * Return a copy of a WebhookAction with all env-expandable string fields resolved.
 * Used before enqueueing for deferred retry so the retry scheduler doesn't need
 * the original event environment.
 */
export function expandWebhookAction(action: WebhookAction, env: Record<string, string>): WebhookAction {
  const expanded: WebhookAction = {
    ...action,
    url: expandEnvVars(action.url, env),
  };

  if (action.headers) {
    expanded.headers = {};
    for (const [key, value] of Object.entries(action.headers)) {
      expanded.headers[key] = expandEnvVars(value, env);
    }
  }

  if (typeof action.body === 'string') {
    expanded.body = expandEnvVars(action.body, env);
  } else if (action.body !== undefined && typeof action.body === 'object' && action.body !== null) {
    expanded.body = JSON.parse(expandEnvVars(JSON.stringify(action.body), env));
  }

  if (action.auth) {
    if (action.auth.type === 'basic') {
      expanded.auth = {
        type: 'basic',
        username: expandEnvVars(action.auth.username, env),
        password: expandEnvVars(action.auth.password, env),
      };
    } else if (action.auth.type === 'bearer') {
      expanded.auth = {
        type: 'bearer',
        token: expandEnvVars(action.auth.token, env),
      };
    }
  }

  return expanded;
}

const WEBHOOK_SECRET_REF_RE = /\$(?:\{)?CRAFT_WH_[A-Z0-9_]+(?:\})?/i;
const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;

function requiresSecretReference(value: string, label: string): void {
  if (!WEBHOOK_SECRET_REF_RE.test(value)) {
    throw new Error(`${label} must reference a CRAFT_WH_* variable before it can be persisted for deferred retry`);
  }
}

/**
 * Expand event-derived values while preserving CRAFT_WH_* references. This is
 * the only action shape safe to write to retry/dead-letter JSONL files.
 */
export function prepareWebhookActionForDeferredRetry(
  action: WebhookAction,
  env: Record<string, string>,
): WebhookAction {
  if (action.auth?.type === 'basic') {
    requiresSecretReference(action.auth.password, 'Basic-auth password');
  } else if (action.auth?.type === 'bearer') {
    requiresSecretReference(action.auth.token, 'Bearer token');
  }
  for (const [key, value] of Object.entries(action.headers ?? {})) {
    if (SENSITIVE_HEADER_RE.test(key)) requiresSecretReference(value, `Sensitive header "${key}"`);
  }

  try {
    const parsed = new URL(action.url.replace(WEBHOOK_SECRET_REF_RE, 'placeholder.example'));
    if (parsed.username || parsed.password) {
      throw new Error('Webhook URL credentials cannot be persisted for deferred retry');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('cannot be persisted')) throw error;
    // A URL made entirely from an env reference is valid after just-in-time expansion.
    if (!WEBHOOK_SECRET_REF_RE.test(action.url)) {
      throw new Error('Webhook URL must be a valid URL or a CRAFT_WH_* reference');
    }
  }

  const persistenceEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    persistenceEnv[key] = key.startsWith('CRAFT_WH_') ? `\${${key}}` : value;
  }
  return expandWebhookAction(action, persistenceEnv);
}

/** Default fetch timeout in milliseconds (30 seconds, matching Claude Code's HTTP hook default) */
const DEFAULT_TIMEOUT_MS = 30_000;
// Keep the address families in separate lists. Besides making the policy
// explicit, this avoids cross-family matching differences between Node and Bun.
const WEBHOOK_IPV4_BLOCKLIST = new BlockList();
const WEBHOOK_IPV6_BLOCKLIST = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  WEBHOOK_IPV4_BLOCKLIST.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  WEBHOOK_IPV6_BLOCKLIST.addSubnet(network, prefix, 'ipv6');
}

type WebhookHostnameResolver = (hostname: string) => Promise<readonly string[]>;

async function resolveWebhookHostname(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address }) => address);
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isBlockedWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return WEBHOOK_IPV4_BLOCKLIST.check(address, 'ipv4');
  if (family === 6) return WEBHOOK_IPV6_BLOCKLIST.check(address, 'ipv6');
  return true;
}

async function validateWebhookDestination(
  url: URL,
  resolveHostname: WebhookHostnameResolver,
): Promise<string | undefined> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Invalid URL scheme "${url.protocol}" — only http and https are allowed`;
  }
  if (url.username || url.password) {
    return 'Webhook URL credentials are not allowed';
  }

  const hostname = normalizedHostname(url);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return 'Webhook destination is blocked by the private-network policy';
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily === 0
    ? await resolveHostname(hostname)
    : [hostname];
  if (addresses.length === 0) {
    return 'Webhook destination did not resolve to an IP address';
  }
  if (addresses.some(isBlockedWebhookAddress)) {
    return 'Webhook destination is blocked by the private-network policy';
  }

  return undefined;
}

export interface RetryConfig {
  /** Max retry attempts (default: 0 = no retry) */
  maxAttempts: number;
  /** Initial delay in ms (default: 1000). Doubles each attempt. */
  initialDelayMs?: number;
  /** Max delay cap in ms (default: 10000) */
  maxDelayMs?: number;
}

export interface ExecuteWebhookOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Environment variables for $VAR expansion. If undefined, no expansion is performed (raw mode for tests) */
  env?: Record<string, string>;
  /** Retry config for transient failures. Disabled by default. */
  retry?: RetryConfig;
  /** Resolve a hostname before connecting. Primarily injectable for deterministic tests. */
  resolveHostname?: WebhookHostnameResolver;
  /** HTTP implementation. Primarily injectable for deterministic tests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Execute a single webhook HTTP request.
 *
 * Handles: request building, env var expansion, timeout via AbortController,
 * response body consumption (prevents memory leaks), and error wrapping.
 * Includes durationMs in the result for observability.
 *
 * @param action - The webhook action definition from automations config
 * @param options - Execution options (timeout, env vars for expansion)
 * @returns WebhookActionResult with status, success flag, timing, and any error
 */
export async function executeWebhookRequest(
  action: WebhookAction,
  options?: ExecuteWebhookOptions,
): Promise<WebhookActionResult> {
  const env = options?.env;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const method = action.method ?? DEFAULT_WEBHOOK_METHOD;
  const url = env ? expandEnvVars(action.url, env) : action.url;

  // Validate URL and resolve all DNS records before connecting. Redirects are
  // disabled below so a public endpoint cannot bounce the request into a
  // private network after this validation.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    const destinationError = await validateWebhookDestination(
      parsedUrl,
      options?.resolveHostname ?? resolveWebhookHostname,
    );
    if (destinationError) {
      return {
        type: 'webhook', url, statusCode: 0, success: false,
        error: destinationError,
        durationMs: 0,
      };
    }
  } catch (error) {
    return {
      type: 'webhook', url, statusCode: 0, success: false,
      error: error instanceof Error && error.message.includes('getaddrinfo')
        ? 'Webhook destination could not be resolved'
        : 'Invalid webhook URL after variable expansion',
      durationMs: 0,
    };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build headers
    const headers: Record<string, string> = {};

    // Apply auth shorthand (before custom headers, so headers can override)
    if (action.auth) {
      if (action.auth.type === 'basic') {
        const user = env ? expandEnvVars(action.auth.username, env) : action.auth.username;
        const pass = env ? expandEnvVars(action.auth.password, env) : action.auth.password;
        headers['Authorization'] = `Basic ${btoa(`${user}:${pass}`)}`;
      } else if (action.auth.type === 'bearer') {
        const token = env ? expandEnvVars(action.auth.token, env) : action.auth.token;
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    if (action.headers) {
      for (const [key, value] of Object.entries(action.headers)) {
        headers[key] = env ? expandEnvVars(value, env) : value;
      }
    }

    // Build body
    let requestBody: string | undefined;
    if (method !== 'GET' && action.body !== undefined) {
      const bodyFormat = action.bodyFormat ?? 'json';

      if (bodyFormat === 'json') {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        if (typeof action.body === 'string') {
          requestBody = env ? expandEnvVars(action.body, env) : action.body;
        } else {
          const raw = JSON.stringify(action.body);
          requestBody = env ? expandEnvVars(raw, env) : raw;
        }
      } else if (bodyFormat === 'form') {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        if (typeof action.body === 'object' && action.body !== null) {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(action.body as Record<string, unknown>)) {
            const val = String(v ?? '');
            params.append(k, env ? expandEnvVars(val, env) : val);
          }
          requestBody = params.toString();
        } else {
          const raw = String(action.body);
          requestBody = env ? expandEnvVars(raw, env) : raw;
        }
      } else {
        // Raw body
        const raw = String(action.body);
        requestBody = env ? expandEnvVars(raw, env) : raw;
      }
    }

    const executeFetch = options?.fetch ?? globalThis.fetch;
    const response = await executeFetch(parsedUrl, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
      redirect: 'error',
    });

    const success = response.status >= 200 && response.status < 300;

    // Consume response body to release the TCP connection and prevent memory leaks.
    // Optionally capture it when requested (truncated to 4KB).
    const MAX_RESPONSE_SIZE = 4096;
    let responseBody: string | undefined;
    try {
      const text = await response.text();
      if (action.captureResponse) {
        responseBody = text.length > MAX_RESPONSE_SIZE
          ? text.slice(0, MAX_RESPONSE_SIZE) + '...(truncated)'
          : text;
      }
    } catch {
      // Body consumption failed — not fatal
    }

    return {
      type: 'webhook',
      url,
      statusCode: response.status,
      success,
      error: success ? undefined : `HTTP ${response.status} ${response.statusText}`,
      durationMs: Date.now() - start,
      ...(responseBody !== undefined ? { responseBody } : {}),
    };
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    const error = isTimeout
      ? `Request timed out after ${timeoutMs}ms`
      : err instanceof Error ? err.message : 'Unknown error';

    return {
      type: 'webhook',
      url,
      statusCode: 0,
      success: false,
      error,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determine if a webhook result represents a transient failure worth retrying.
 * - 5xx server errors: likely transient
 * - Timeout / connection errors (statusCode 0): likely transient
 * - 4xx client errors: not retryable (bad request, auth issues, etc.)
 * - 2xx success: obviously not
 */
export function isTransientFailure(result: WebhookActionResult): boolean {
  if (result.success) return false;
  // 4xx = client error, not retryable
  if (result.statusCode >= 400 && result.statusCode < 500) return false;
  // 5xx or 0 (timeout/connection error) = retryable
  return true;
}

/**
 * Execute a webhook request with optional retry for transient failures.
 *
 * Wraps executeWebhookRequest with exponential backoff + jitter.
 * If retry is not configured (or maxAttempts=0), behaves identically to executeWebhookRequest.
 *
 * @param action - The webhook action definition
 * @param options - Execution options including retry config
 * @returns WebhookActionResult with attempts count and total duration
 */
export async function executeWithRetry(
  action: WebhookAction,
  options?: ExecuteWebhookOptions,
): Promise<WebhookActionResult> {
  const maxAttempts = options?.retry?.maxAttempts ?? 0;

  // No retry configured — single attempt
  if (maxAttempts <= 0) {
    const result = await executeWebhookRequest(action, options);
    return { ...result, attempts: 1 };
  }

  const initialDelay = options?.retry?.initialDelayMs ?? 1000;
  const maxDelay = options?.retry?.maxDelayMs ?? 10_000;
  const totalStart = Date.now();

  let lastResult: WebhookActionResult | undefined;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    lastResult = await executeWebhookRequest(action, options);

    // Success or non-transient failure — return immediately
    if (!isTransientFailure(lastResult)) {
      return {
        ...lastResult,
        attempts: attempt + 1,
        durationMs: Date.now() - totalStart,
      };
    }

    // Last attempt — don't delay, just return
    if (attempt === maxAttempts) break;

    // Exponential backoff with jitter (±10%)
    const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
    const jitter = delay * 0.1 * (Math.random() * 2 - 1); // ±10%
    await new Promise(r => setTimeout(r, delay + jitter));
  }

  return {
    ...lastResult!,
    attempts: maxAttempts + 1,
    durationMs: Date.now() - totalStart,
  };
}
