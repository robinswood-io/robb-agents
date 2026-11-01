import { parseJsonObject } from '../utils/json.ts';
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
import { debugLog, isRichToolDescriptionsEnabled, toolMetadataStore } from "../interceptor-common.ts";
import { normalizeMistralChatRequest } from "../interceptor-request-utils.ts";
import { DEBUG_SSE_RAW } from './configuration.ts';
import { sanitizeOpenAiHistoryInPlace, validateOpenAiChatBody } from './history-validation.ts';
import type { ApiAdapter } from './tool-metadata.ts';
import { captureMetadataFromInput, injectMetadataIntoToolSchema } from './tool-metadata.ts';

// ============================================================================
// OPENAI ADAPTER
// ============================================================================

/** Tracked tool call during OpenAI SSE streaming */
interface TrackedToolCall {
  id: string;
  name: string;
  type: string;
  choiceIndex: number;
  toolIndex: number;
  /** Args accumulated from same-index deltas (partial JSON pieces). */
  arguments: string;
  /** Phase-2 args (DeepSeek-style "shifted index" chunks). Each element is
   * a complete JSON string that should be merged at the OBJECT level into
   * the final args, not concatenated as a string. */
  shiftedArgs: string[];
}

/**
 * Creates a TransformStream that intercepts OpenAI SSE events,
 * buffers tool_call argument deltas across all upstream chunks, extracts
 * `_intent` / `_displayName` into the metadata store, and emits one
 * consolidated SSE event per logical tool call with `id + name + cleanArgs`
 * together.
 *
 * Output contract — important:
 * - Each logical tool call produces EXACTLY ONE outbound SSE event with
 *   `delta.tool_calls: [{index, id, type, function: {name, arguments}}]`.
 * - We never emit args-only deltas (no id, no name). Some downstream SDKs
 *   (notably Pi SDK) treat such deltas as new tool_calls instead of merging
 *   by index, which produced duplicate empty-id entries on parallel-tool
 *   turns from DeepSeek and other relays.
 * - Non-tool events pass through immediately.
 * - All upstream tool_call chunks are suppressed; the consolidated events
 *   are emitted just before the original `[DONE]` / `finish_reason` event.
 */
export function createOpenAiSseStrippingStream(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const trackedCalls = new Map<string, TrackedToolCall>();
  /**
   * Per-choice fallback for relays that drop `tc.index` on argument-delta
   * chunks. We pin argument deltas to the most recently opened tool call in
   * the same choice instead of letting them collide on key 0.
   */
  const lastOpenedToolIndexByChoice = new Map<number, number>();
  let lineBuffer = '';
  /** Track whether we're currently buffering tool_call argument deltas */
  let bufferingToolCalls = false;

  function emitSseLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW OUT openai] ${dataStr.slice(0, 4000)}`);
    controller.enqueue(encoder.encode(`data: ${dataStr}\n\n`));
  }

  function flushTrackedCalls(controller: TransformStreamDefaultController<Uint8Array>): void {
    // Iterate in toolIndex order so downstream sees a stable sequence.
    const sorted = Array.from(trackedCalls.values()).sort((a, b) => {
      if (a.choiceIndex !== b.choiceIndex) return a.choiceIndex - b.choiceIndex;
      return a.toolIndex - b.toolIndex;
    });

    for (const tc of sorted) {
      // Merge in this priority: phase-1 args (partial-JSON concatenation)
      // first, then any phase-2 "shifted index" args (each a complete JSON
      // object) via object spread. Phase-2 wins on key conflicts since it
      // carries the model's actual content (DeepSeek emits real args there;
      // phase-1 carries only `_intent` / `_displayName` for those calls).
      let merged: Record<string, unknown> = {};
      let parseFailed = false;

      if (tc.arguments) {
        try {
          const parsed: unknown = JSON.parse(tc.arguments);
          if (parsed && typeof parsed === 'object' && !isUnknownArray(parsed)) {
            merged = { ...merged, ...(parsed as Record<string, unknown>) };
          }
        } catch {
          parseFailed = true;
          debugLog(`[OpenAI SSE] Failed to parse phase-1 arguments for ${tc.name} (${tc.id}), passing through raw`);
        }
      }

      for (const piece of tc.shiftedArgs) {
        try {
          const parsed: unknown = JSON.parse(piece);
          if (parsed && typeof parsed === 'object' && !isUnknownArray(parsed)) {
            merged = { ...merged, ...(parsed as Record<string, unknown>) };
          }
        } catch {
          parseFailed = true;
          debugLog(`[OpenAI SSE] Failed to parse phase-2 arguments for ${tc.name} (${tc.id}), passing through raw`);
        }
      }

      let outArgs: string;
      if (parseFailed && !tc.shiftedArgs.length) {
        // Pure phase-1 parse failure with no phase-2 to recover from —
        // pass through the raw concatenation so downstream sees something.
        outArgs = tc.arguments;
      } else {
        captureMetadataFromInput(tc.id, tc.name, merged);
        delete merged["_intent"];
        delete merged["_displayName"];
        outArgs = JSON.stringify(merged);
      }

      // Consolidated tool_call event: id + type + name + cleanArgs together.
      // Downstream SDKs see one event per logical tool call — no merging
      // by index, no orphan args-only deltas.
      const consolidatedEvent = {
        choices: [{
          index: tc.choiceIndex,
          delta: {
            tool_calls: [{
              index: tc.toolIndex,
              id: tc.id,
              type: tc.type,
              function: { name: tc.name, arguments: outArgs },
            }],
          },
        }],
      };
      emitSseLine(JSON.stringify(consolidatedEvent), controller);
    }
    trackedCalls.clear();
    bufferingToolCalls = false;
  }

  function processDataLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW IN  openai] ${dataStr.slice(0, 4000)}`);
    if (dataStr === '[DONE]') {
      flushTrackedCalls(controller);
      emitSseLine(dataStr, controller);
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = parseJsonObject(dataStr);
    } catch {
      emitSseLine(dataStr, controller);
      return;
    }

    const choices = data["choices"] as Array<{
      index?: number;
      delta?: {
        tool_calls?: Array<{
          index?: number;
          id?: string;
          type?: string;
          function?: {
            name?: string;
            arguments?: string;
          };
        }>;
      };
      finish_reason?: string | null;
    }> | undefined;

    if (!choices || choices.length === 0) {
      emitSseLine(dataStr, controller);
      return;
    }

    let handledToolCalls = false;

    // Buffer tool_call argument deltas (across all choices). All upstream
    // tool_call chunks are suppressed; we emit one consolidated event per
    // logical tool call at flush time — see flushTrackedCalls.
    //
    // Relay quirks handled here:
    //   - id-repeat relays (DeepSeek, some Chinese OpenAI-compat hosts) send
    //     `tc.id` on every chunk instead of only the first. We treat the
    //     second-and-later occurrences with a matching id as argument-only
    //     deltas (no new tracked entry).
    //   - index-dropping relays send argument-delta chunks without `tc.index`.
    //     We fall back to "the most recently opened tracked call for this
    //     choice" so parallel tool calls don't collide on key 0.
    //   - index-shifting relays (DeepSeek extended-thinking) emit the
    //     argument payload at a NEW `tc.index` with empty id/name. We attach
    //     those args to the matching phase-1 entry by walking the open calls
    //     in order rather than allocating a new bucket for them.
    for (const choice of choices) {
      if (!choice?.delta?.tool_calls) continue;
      handledToolCalls = true;

      const choiceIndex = choice.index ?? 0;
      for (const tc of choice.delta.tool_calls) {
        // Resolve the bucket key. If `tc.index` is missing, prefer the most
        // recently opened call in this choice so we don't collide on key 0.
        const fallbackIndex = lastOpenedToolIndexByChoice.get(choiceIndex);
        const toolIndex = tc.index ?? fallbackIndex ?? 0;
        const key = `${choiceIndex}:${toolIndex}`;

        if (tc.id) {
          const existing = trackedCalls.get(key);
          if (existing && existing.id === tc.id) {
            // Relay repeated the id on a subsequent chunk. Treat this as an
            // argument-delta only.
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            // If a later chunk carries the function name we hadn't seen yet,
            // upgrade the tracked entry rather than letting it stay 'unknown'.
            if (tc.function?.name && existing.name === 'unknown') {
              existing.name = tc.function.name;
            }
            continue;
          }

          // First chunk for a logical tool call — record id/name/type and
          // any initial args. We do NOT emit an init event; the consolidated
          // event is emitted on flush.
          trackedCalls.set(key, {
            id: tc.id,
            name: tc.function?.name || 'unknown',
            type: tc.type || 'function',
            choiceIndex,
            toolIndex,
            arguments: tc.function?.arguments || '',
            shiftedArgs: [],
          });
          lastOpenedToolIndexByChoice.set(choiceIndex, toolIndex);
          bufferingToolCalls = true;
        } else {
          // Subsequent argument delta with no id. Three patterns to handle:
          //  (a) Same `tc.index` as a phase-1 entry → append (partial JSON).
          //  (b) Missing `tc.index` → fall back to last-opened, append.
          //  (c) NEW `tc.index` past the last-opened (DeepSeek's
          //      "phase-2 args at shifted index" shape). Attach to the
          //      matching phase-1 entry by ordinal position. These chunks
          //      carry a COMPLETE JSON object, not a partial string — store
          //      them separately and merge at the object level on flush.
          const existingByKey = trackedCalls.get(key);
          if (existingByKey) {
            // (a) or (b) — partial JSON delta, append.
            if (tc.function?.arguments) {
              existingByKey.arguments += tc.function.arguments;
            }
          } else {
            // (c) — find the phase-1 entry in this choice by position.
            const phase1 = Array.from(trackedCalls.values())
              .filter(t => t.choiceIndex === choiceIndex)
              .sort((a, b) => a.toolIndex - b.toolIndex);
            const lastOpened = lastOpenedToolIndexByChoice.get(choiceIndex);
            if (
              typeof lastOpened === 'number' &&
              tc.index !== undefined &&
              tc.index > lastOpened &&
              phase1.length > 0 &&
              tc.function?.arguments
            ) {
              const ord = tc.index - (lastOpened + 1);
              if (ord >= 0 && ord < phase1.length) {
                phase1[ord]!.shiftedArgs.push(tc.function.arguments);
              }
            }
          }
        }
      }
    }

    // Suppress all upstream tool_call delta payloads. Consolidated events
    // are emitted on flush.
    if (handledToolCalls) {
      return;
    }

    // On finish, flush buffered tool calls with clean args BEFORE emitting finish event
    const hasFinish = choices.some(choice => choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop');
    if (hasFinish) {
      if (bufferingToolCalls) {
        flushTrackedCalls(controller);
      }
      emitSseLine(dataStr, controller);
      return;
    }

    // Non-tool events pass through
    emitSseLine(dataStr, controller);
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = lineBuffer + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        if (trimmed.startsWith('data: ')) {
          processDataLine(trimmed.slice(6), controller);
        } else {
          // Pass through non-data SSE lines (comments, event types, etc.)
          controller.enqueue(encoder.encode(trimmed + '\n'));
        }
      }
    },

    flush(controller) {
      if (lineBuffer.trim()) {
        const trimmed = lineBuffer.trim();
        if (trimmed.startsWith('data: ')) {
          processDataLine(trimmed.slice(6), controller);
        }
      }
      // Flush any remaining tracked calls on stream end
      if (trackedCalls.size > 0) {
        flushTrackedCalls(controller);
      }
      lineBuffer = '';
    },
  });
}

export const openAiAdapter: ApiAdapter = {
  name: 'openai',

  shouldIntercept(url: string): boolean {
    return url.includes('/chat/completions');
  },

  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown> {
    const tools = body["tools"] as Array<{
      type?: string;
      function?: {
        name?: string;
        parameters?: {
          type?: string;
          properties?: Record<string, unknown>;
          required?: string[];
        };
      };
    }> | undefined;

    if (!tools || !isUnknownArray(tools)) {
      return body;
    }

    const richDescriptions = isRichToolDescriptionsEnabled();
    let modifiedCount = 0;

    for (const tool of tools) {
      if (tool.type !== 'function' || !tool.function?.parameters) continue;

      // MCP tools always get metadata regardless of the feature flag — they're
      // lower-volume than built-in tools and the metadata drives source-specific
      // UI (tool intents, display names in the sidebar).
      const isMcpTool = tool.function.name?.startsWith('mcp__');
      if (!richDescriptions && !isMcpTool) {
        continue;
      }

      const params = tool.function.parameters;
      const updatedSchema = injectMetadataIntoToolSchema(params);
      params.properties = updatedSchema.properties;
      params.required = updatedSchema.required;
      // External MCP servers may set additionalProperties: false which would
      // cause validation to reject _intent/_displayName in tool inputs.
      if ((params as Record<string, unknown>)["additionalProperties"] === false) {
        delete (params as Record<string, unknown>)["additionalProperties"];
      }
      modifiedCount++;
    }

    if (modifiedCount > 0) {
      debugLog(`[OpenAI Schema] Added _intent and _displayName to ${modifiedCount} tools`);
    }

    return body;
  },

  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown> {
    sanitizeOpenAiHistoryInPlace(body);

    const messages = body["messages"] as Array<{
      role?: string;
      tool_call_id?: string;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    }> | undefined;

    if (!messages) return body;

    let injectedCount = 0;

    for (const message of messages) {
      if (message.role !== 'assistant' || !isUnknownArray(message.tool_calls)) continue;

      for (const tc of message.tool_calls) {
        if (!tc.id || !tc.function?.arguments) continue;

        let args: Record<string, unknown>;
        try {
          args = parseJsonObject(tc.function.arguments);
        } catch {
          continue;
        }

        const hasIntent = '_intent' in args;
        const hasDisplayName = '_displayName' in args;
        if (hasIntent && hasDisplayName) continue;

        const stored = toolMetadataStore.get(tc.id);
        if (stored) {
          const newArgs: Record<string, unknown> = {};
          if (!hasDisplayName && stored.displayName) newArgs["_displayName"] = stored.displayName;
          if (!hasIntent && stored.intent) newArgs["_intent"] = stored.intent;
          if (Object.keys(newArgs).length > 0) {
            Object.assign(newArgs, args);
            tc.function.arguments = JSON.stringify(newArgs);
            injectedCount++;
          }
        }
      }
    }

    if (injectedCount > 0) {
      debugLog(`[OpenAI History] Re-injected metadata into ${injectedCount} tool_calls`);
    }

    return body;
  },

  validateOutgoingBody(body: Record<string, unknown>): void {
    validateOpenAiChatBody(body);
  },

  modifyRequest(url: string, init: RequestInit, body: Record<string, unknown>) {
    return { init, body: normalizeMistralChatRequest(url, body) };
  },

  createSseProcessor(): TransformStream<Uint8Array, Uint8Array> {
    return createOpenAiSseStrippingStream();
  },

  stripsSseMetadata: true,
};
