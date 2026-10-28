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
import { debugLog } from "../interceptor-common.ts";
import { MalformedBodyError } from './tool-metadata.ts';

/**
 * Validate an outgoing OpenAI Chat Completions body before it hits the wire.
 * Throws {@link MalformedBodyError} on the structural problems that produce
 * `400 Duplicate value for 'tool_call_id'` and similar opaque upstream
 * failures (#613). Exported for focused unit tests.
 */
/**
 * Strip `tool_calls` entries with an empty/missing `id` from assistant
 * messages, and drop orphan `role: "tool"` results that reference them.
 *
 * Recovers sessions whose history was persisted by the pre-fix strip stream
 * — that version emitted args-only SSE deltas (no id, no name) which Pi SDK
 * recorded as separate empty-id tool_calls. Without this sanitizer, every
 * replay of such history hits `validateOpenAiChatBody` with
 * `missing_tool_call_id` and the session is bricked.
 *
 * Mutates `body.messages` in place. Logs structured info if anything was
 * dropped. Exported for focused unit tests.
 */
export function sanitizeOpenAiHistoryInPlace(body: Record<string, unknown>): {
  droppedToolCalls: number;
  droppedToolResults: number;
} {
  const messages = body["messages"] as Array<{
    role?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }> | undefined;
  if (!isUnknownArray(messages)) {
    return { droppedToolCalls: 0, droppedToolResults: 0 };
  }

  let droppedToolCalls = 0;
  const knownIds = new Set<string>();

  for (const message of messages) {
    if (message.role === 'assistant' && isUnknownArray(message.tool_calls)) {
      const cleaned = message.tool_calls.filter(tc => {
        if (typeof tc.id !== 'string' || tc.id === '') {
          droppedToolCalls++;
          return false;
        }
        knownIds.add(tc.id);
        return true;
      });
      if (cleaned.length !== message.tool_calls.length) {
        if (cleaned.length === 0) {
          delete message.tool_calls;
        } else {
          message.tool_calls = cleaned;
        }
      }
    }
  }

  let droppedToolResults = 0;
  if (droppedToolCalls > 0) {
    const filtered = messages.filter(message => {
      if (message.role !== 'tool') return true;
      const tcid = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (!tcid || !knownIds.has(tcid)) {
        droppedToolResults++;
        return false;
      }
      return true;
    });
    if (filtered.length !== messages.length) {
      body["messages"] = filtered;
    }
    debugLog(`[OpenAI History] Sanitized poisoned history: dropped ${droppedToolCalls} empty-id tool_call(s) and ${droppedToolResults} orphan tool result(s)`);
  }

  return { droppedToolCalls, droppedToolResults };
}

export function validateOpenAiChatBody(body: Record<string, unknown>): void {
  const messages = body["messages"] as Array<{
    role?: string;
    tool_call_id?: unknown;
    tool_calls?: Array<{
      id?: unknown;
      type?: string;
      function?: { name?: unknown };
    }>;
  }> | undefined;
  if (!isUnknownArray(messages)) return;

  // Track every tool_call id we've seen on assistant messages. Duplicates
  // across messages are also illegal — OpenAI requires globally unique ids
  // within a single request.
  const seenIds = new Set<string>();
  const knownIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === 'assistant' && isUnknownArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const id = typeof tc.id === 'string' ? tc.id : '';
        if (!id) {
          throw new MalformedBodyError({
            code: 'missing_tool_call_id',
            detail: `messages[${i}].tool_calls[*] missing id`,
            adapter: 'openai',
          });
        }
        if (seenIds.has(id)) {
          throw new MalformedBodyError({
            code: 'duplicate_tool_call_id',
            detail: `messages[${i}].tool_calls[*] reuses id "${id}" already seen earlier`,
            adapter: 'openai',
          });
        }
        seenIds.add(id);
        knownIds.add(id);

        const fnName = typeof tc.function?.name === 'string' ? tc.function.name.trim() : '';
        if (!fnName) {
          throw new MalformedBodyError({
            code: 'empty_tool_name',
            detail: `messages[${i}].tool_calls[*] (id="${id}") has empty function.name`,
            adapter: 'openai',
          });
        }
      }
    }

    if (msg.role === 'tool') {
      const tcid = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
      if (!tcid) {
        throw new MalformedBodyError({
          code: 'missing_tool_call_id',
          detail: `messages[${i}] (role=tool) missing tool_call_id`,
          adapter: 'openai',
        });
      }
      if (!knownIds.has(tcid)) {
        // Tool result references an id that no preceding assistant message
        // emitted — usually the symptom of a failed reassembly.
        throw new MalformedBodyError({
          code: 'orphaned_function_call_output',
          detail: `messages[${i}] (role=tool) references unknown tool_call_id "${tcid}"`,
          adapter: 'openai',
        });
      }
    }
  }
}

/**
 * Validate an outgoing OpenAI Responses-API body before it hits the wire.
 * Throws {@link MalformedBodyError} on the structural problems that produce
 * `400 Missing required parameter: input[N].call_id` (#613). Run after
 * {@link repairResponsesHistoryInPlace}, which fixes the recoverable cases.
 * Exported for focused unit tests.
 */
export function validateOpenAiResponsesBody(body: Record<string, unknown>): void {
  const input = body["input"] as Array<Record<string, unknown>> | undefined;
  if (!isUnknownArray(input)) return;

  const seenCallIds = new Set<string>();
  const knownCallIds = new Set<string>();

  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    if (!entry) continue;
    if (entry["type"] === 'function_call') {
      const callId = typeof entry["call_id"] === 'string' ? entry["call_id"] : '';
      if (!callId) {
        throw new MalformedBodyError({
          code: 'missing_call_id',
          detail: `input[${i}] (type=function_call) missing call_id`,
          adapter: 'openai-responses',
        });
      }
      if (seenCallIds.has(callId)) {
        throw new MalformedBodyError({
          code: 'duplicate_tool_call_id',
          detail: `input[${i}] (type=function_call) reuses call_id "${callId}"`,
          adapter: 'openai-responses',
        });
      }
      seenCallIds.add(callId);
      knownCallIds.add(callId);

      const name = typeof entry["name"] === 'string' ? entry["name"].trim() : '';
      if (!name) {
        throw new MalformedBodyError({
          code: 'empty_tool_name',
          detail: `input[${i}] (type=function_call, call_id="${callId}") has empty name`,
          adapter: 'openai-responses',
        });
      }
    } else if (entry["type"] === 'function_call_output') {
      const callId = typeof entry["call_id"] === 'string' ? entry["call_id"] : '';
      if (!callId) {
        throw new MalformedBodyError({
          code: 'missing_call_id',
          detail: `input[${i}] (type=function_call_output) missing call_id`,
          adapter: 'openai-responses',
        });
      }
      if (!knownCallIds.has(callId)) {
        throw new MalformedBodyError({
          code: 'orphaned_function_call_output',
          detail: `input[${i}] (type=function_call_output) references unknown call_id "${callId}"`,
          adapter: 'openai-responses',
        });
      }
    }
  }
}

/**
 * In-place repair of Responses-API `input[]` arrays that arrive with structural
 * defects we can recover from. Mutates `input` and returns the number of repairs.
 *
 * - `function_call` entries missing `call_id` get a deterministic synthesized id.
 * - `function_call_output` entries referencing an unknown `call_id` are dropped
 *   (the upstream would 400 anyway; better to lose one tool result than the turn).
 *
 * Exported for focused unit tests.
 */
export function repairResponsesHistoryInPlace(input: Array<Record<string, unknown>>): {
  synthesizedCallIds: number;
  droppedOrphans: number;
} {
  let synthesizedCallIds = 0;
  let droppedOrphans = 0;
  const knownCallIds = new Set<string>();

  // First pass: synthesize missing call_ids on function_call entries so later
  // entries can reference them.
  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    if (!entry) continue;
    if (entry["type"] !== 'function_call') continue;
    if (typeof entry["call_id"] === 'string' && entry["call_id"].length > 0) {
      knownCallIds.add(entry["call_id"]);
      continue;
    }
    const name = typeof entry["name"] === 'string' ? entry["name"] : 'unknown';
    const argsHash = typeof entry["arguments"] === 'string'
      ? hashShortString(entry["arguments"])
      : '0';
    const synthetic = `repaired_${i}_${name}_${argsHash}`;
    entry["call_id"] = synthetic;
    knownCallIds.add(synthetic);
    synthesizedCallIds++;
    debugLog(`[OpenAI Responses Repair] Synthesized call_id "${synthetic}" for input[${i}] (name=${name})`);
  }

  if (synthesizedCallIds === 0 && input.every(e => e["type"] !== 'function_call_output')) {
    return { synthesizedCallIds, droppedOrphans };
  }

  // Second pass: drop orphan function_call_output entries.
  for (let i = input.length - 1; i >= 0; i--) {
    const entry = input[i];
    if (!entry) continue;
    if (entry["type"] !== 'function_call_output') continue;
    const callId = typeof entry["call_id"] === 'string' ? entry["call_id"] : '';
    if (!callId || !knownCallIds.has(callId)) {
      input.splice(i, 1);
      droppedOrphans++;
      debugLog(`[OpenAI Responses Repair] Dropped orphan function_call_output at input[${i}] (call_id="${callId}")`);
    }
  }

  return { synthesizedCallIds, droppedOrphans };
}

/** Tiny stable hash for synthesizing deterministic call_ids. Not a security primitive. */
function hashShortString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
