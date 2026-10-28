import { isUnknownArray } from '../utils/json.ts';
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
import { debugLog, isExtendedPromptCacheEnabled } from "../interceptor-common.ts";
import { FEATURE_FLAGS } from "../feature-flags.ts";
import type { HeadersInitType } from './configuration.ts';

// ============================================================================
// ANTHROPIC ADAPTER
// ============================================================================

/**
 * Get the configured API base URL at request time.
 * Reads from env var (set by auth/sessions before SDK starts) with Anthropic default fallback.
 */
export function getConfiguredBaseUrl(): string {
  return process.env["ANTHROPIC_BASE_URL"]?.trim() || 'https://api.anthropic.com';
}

export const FAST_MODE_BETA = 'fast-mode-2026-02-01';

/**
 * Strip cache_control from empty text blocks in API request bodies.
 *
 * The Claude Agent SDK's auto-mode classifier can assign cache_control to
 * content blocks without checking whether their text is empty. The Anthropic
 * API rejects this with "cache_control cannot be set for empty text blocks".
 *
 * Exported for focused unit tests.
 */
export function sanitizeEmptyTextCacheControl(body: Record<string, unknown>): number {
  const messages = body["messages"] as Array<{ content?: Array<Record<string, unknown>> }> | undefined;
  if (!messages) return 0;

  let stripped = 0;
  for (const message of messages) {
    if (!isUnknownArray(message.content)) continue;
    for (const block of message.content) {
      if (
        block["type"] === 'text' &&
        block["cache_control"] &&
        (typeof block["text"] !== 'string' || !block["text"].trim())
      ) {
        delete block["cache_control"];
        stripped++;
      }
    }
  }

  if (stripped > 0) {
    debugLog(`[Anthropic] Stripped cache_control from ${stripped} empty text block(s)`);
  }
  return stripped;
}

/**
 * Strip explicit TTL from all ephemeral cache_control blocks.
 *
 * When extendedPromptCache is disabled, the SDK may still send ttl: "1h"
 * natively (via prompt-caching-scope beta). This function removes the ttl
 * field so blocks fall back to the API default (5 min).
 *
 * Walks tools, system, message content, and top-level cache_control. The
 * Anthropic API processes blocks in order `tools → system → messages` and
 * rejects requests where a 1h block appears after a 5m block, so the tools
 * walk must stay in sync with the upgrade path below.
 */
function stripPromptCacheTtl(body: Record<string, unknown>): number {
  let stripped = 0;

  const tools = body["tools"] as Array<Record<string, unknown>> | undefined;
  if (isUnknownArray(tools)) {
    for (const tool of tools) {
      const cc = tool["cache_control"] as Record<string, unknown> | undefined;
      if (cc?.["type"] === 'ephemeral' && 'ttl' in cc) {
        delete cc["ttl"];
        stripped++;
      }
    }
  }

  const system = body["system"] as Array<Record<string, unknown>> | undefined;
  if (isUnknownArray(system)) {
    for (const block of system) {
      const cc = block["cache_control"] as Record<string, unknown> | undefined;
      if (cc?.["type"] === 'ephemeral' && 'ttl' in cc) {
        delete cc["ttl"];
        stripped++;
      }
    }
  }

  const messages = body["messages"] as Array<{ content?: unknown }> | undefined;
  if (messages) {
    for (const message of messages) {
      if (!isUnknownArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        const cc = block["cache_control"] as Record<string, unknown> | undefined;
        if (cc?.["type"] === 'ephemeral' && 'ttl' in cc) {
          delete cc["ttl"];
          stripped++;
        }
      }
    }
  }

  const topLevel = body["cache_control"] as Record<string, unknown> | undefined;
  if (topLevel?.["type"] === 'ephemeral' && 'ttl' in topLevel) {
    delete topLevel["ttl"];
    stripped++;
  }

  if (stripped > 0) {
    debugLog(`[Anthropic] Stripped TTL from ${stripped} cache_control block(s) (extendedPromptCache=false)`);
  }
  return stripped;
}

/**
 * Upgrade all cache_control blocks from 5m (default) to 1h TTL.
 * Only active when extendedPromptCache is enabled in config.
 * When disabled, actively strips any SDK-injected TTL so blocks
 * fall back to the API default (5 min).
 *
 * Walks tools, system prompt blocks, message content blocks, and the
 * top-level cache_control field (auto-caching mode). Only upgrades blocks
 * with type: "ephemeral" — leaves other types untouched.
 *
 * The tools walk is required for correctness, not just completeness: the
 * Anthropic API processes blocks in order `tools → system → messages` and
 * rejects requests where a 1h cache_control block appears after a 5m one.
 * If we upgrade only system+messages, a 5m block on a tool (added by the
 * SDK or user) ahead of a 1h block on system produces a 400 with message
 * "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block."
 *
 * Exported for focused unit tests.
 */
export function upgradePromptCacheTtl(body: Record<string, unknown>): number {
  if (!isExtendedPromptCacheEnabled()) return stripPromptCacheTtl(body);

  let upgraded = 0;

  // Upgrade tool cache_control (must run first — tools is processed before
  // system, and a stale 5m block here would invalidate any later 1h upgrade).
  const tools = body["tools"] as Array<Record<string, unknown>> | undefined;
  if (isUnknownArray(tools)) {
    for (const tool of tools) {
      if (tool["cache_control"] && (tool["cache_control"] as Record<string, unknown>)["type"] === 'ephemeral') {
        (tool["cache_control"] as Record<string, unknown>)["ttl"] = '1h';
        upgraded++;
      }
    }
  }

  // Upgrade system prompt cache_control
  const system = body["system"] as Array<Record<string, unknown>> | undefined;
  if (isUnknownArray(system)) {
    for (const block of system) {
      if (block["cache_control"] && (block["cache_control"] as Record<string, unknown>)["type"] === 'ephemeral') {
        (block["cache_control"] as Record<string, unknown>)["ttl"] = '1h';
        upgraded++;
      }
    }
  }

  // Upgrade message content cache_control
  const messages = body["messages"] as Array<{ content?: unknown }> | undefined;
  if (messages) {
    for (const message of messages) {
      if (!isUnknownArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block["cache_control"] && (block["cache_control"] as Record<string, unknown>)["type"] === 'ephemeral') {
          (block["cache_control"] as Record<string, unknown>)["ttl"] = '1h';
          upgraded++;
        }
      }
    }
  }

  // Upgrade top-level cache_control (auto-caching mode)
  const topLevel = body["cache_control"] as Record<string, unknown> | undefined;
  if (topLevel?.["type"] === 'ephemeral') {
    topLevel["ttl"] = '1h';
    upgraded++;
  }

  if (upgraded > 0) {
    debugLog(`[Anthropic] Upgraded ${upgraded} cache_control block(s) to 1h TTL`);
  }
  return upgraded;
}

/**
 * Check if fast mode should be enabled for this request.
 * Only activates for Opus 4.7 on Anthropic's API when the feature flag is on.
 */
export function shouldEnableFastMode(model: unknown): boolean {
  if (!FEATURE_FLAGS.fastMode) return false;
  return typeof model === 'string' && model === 'claude-opus-4-7';
}

/**
 * Append a beta value to the anthropic-beta header, preserving existing values.
 */
export function appendBetaHeader(headers: HeadersInitType | undefined, beta: string): Record<string, string> {
  let headerObj: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { headerObj[key] = value; });
  } else if (isUnknownArray(headers)) {
    for (const [key, value] of headers) {
      headerObj[key as string] = value as string;
    }
  } else if (headers) {
    headerObj = { ...headers };
  }

  const existing = headerObj['anthropic-beta'];
  headerObj['anthropic-beta'] = existing ? `${existing},${beta}` : beta;

  return headerObj;
}

/**
 * Remove a beta value from the anthropic-beta header, preserving other values.
 */
export function stripBetaHeader(headers: HeadersInitType | undefined, beta: string): Record<string, string> {
  let headerObj: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { headerObj[key] = value; });
  } else if (isUnknownArray(headers)) {
    for (const [key, value] of headers) {
      headerObj[key as string] = value as string;
    }
  } else if (headers) {
    headerObj = { ...headers };
  }

  const existing = headerObj['anthropic-beta'];
  if (existing) {
    headerObj['anthropic-beta'] = existing.split(',').filter(b => b.trim() !== beta).join(',');
  }

  return headerObj;
}
