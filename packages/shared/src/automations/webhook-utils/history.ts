/** Automation history entries and URL redaction. */
import { DEFAULT_WEBHOOK_METHOD, HISTORY_FIELD_MAX_LENGTH } from "../constants.ts";

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
