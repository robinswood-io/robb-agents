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
import { normalizeOpenAiResponsesRequest } from "../interceptor-request-utils.ts";
import { DEBUG_SSE_RAW } from './configuration.ts';
import { repairResponsesHistoryInPlace, validateOpenAiResponsesBody } from './history-validation.ts';
import type { ApiAdapter } from './tool-metadata.ts';
import { captureMetadataFromInput, injectMetadataIntoToolSchema } from './tool-metadata.ts';

/**
 * Creates a TransformStream for OpenAI Responses API SSE.
 *
 * We capture metadata and strip it at the stable "done" boundaries where full
 * function-call arguments are available as JSON strings:
 * - response.function_call_arguments.done
 * - response.output_item.done (item.type === 'function_call')
 */
export function createOpenAiResponsesSseStrippingStream(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let lineBuffer = '';

  function emitSseLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW OUT openai-responses] ${dataStr.slice(0, 4000)}`);
    controller.enqueue(encoder.encode(`data: ${dataStr}\n\n`));
  }

  function processDataLine(dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (DEBUG_SSE_RAW) debugLog(`[SSE RAW IN  openai-responses] ${dataStr.slice(0, 4000)}`);
    if (dataStr === '[DONE]') {
      emitSseLine(dataStr, controller);
      return;
    }

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      emitSseLine(dataStr, controller);
      return;
    }

    const eventType = data.type;
    if (eventType === 'response.function_call_arguments.done') {
      const callId = typeof data.call_id === 'string' ? data.call_id : undefined;
      const argsStr = typeof data.arguments === 'string' ? data.arguments : undefined;
      if (callId && argsStr) {
        try {
          const parsed = JSON.parse(argsStr) as Record<string, unknown>;
          captureMetadataFromInput(callId, 'response:function_call', parsed);
          delete parsed._intent;
          delete parsed._displayName;
          data.arguments = JSON.stringify(parsed);
        } catch {
          // pass through unchanged
        }
      }
      emitSseLine(JSON.stringify(data), controller);
      return;
    }

    if (eventType === 'response.output_item.done') {
      const item = data.item as {
        type?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      } | undefined;

      if (item?.type === 'function_call' && typeof item.arguments === 'string') {
        const toolId = typeof item.call_id === 'string' ? item.call_id : undefined;
        const toolName = typeof item.name === 'string' ? item.name : 'response:function_call';
        if (toolId) {
          try {
            const parsed = JSON.parse(item.arguments) as Record<string, unknown>;
            captureMetadataFromInput(toolId, toolName, parsed);
            delete parsed._intent;
            delete parsed._displayName;
            item.arguments = JSON.stringify(parsed);
          } catch {
            // pass through unchanged
          }
        }
      }

      emitSseLine(JSON.stringify(data), controller);
      return;
    }

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
      lineBuffer = '';
    },
  });
}

export const openAiResponsesAdapter: ApiAdapter = {
  name: 'openai-responses',

  shouldIntercept(url: string): boolean {
    return url.includes('/responses');
  },

  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown> {
    const tools = body.tools as Array<{
      type?: string;
      name?: string;
      parameters?: {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }> | undefined;

    if (!tools || !Array.isArray(tools)) return body;

    const richDescriptions = isRichToolDescriptionsEnabled();
    let modifiedCount = 0;

    for (const tool of tools) {
      if (tool.type !== 'function' || !tool.parameters) continue;

      const isMcpTool = tool.name?.startsWith('mcp__');
      if (!richDescriptions && !isMcpTool) continue;

      const params = tool.parameters;
      const updatedSchema = injectMetadataIntoToolSchema(params);
      params.properties = updatedSchema.properties;
      params.required = updatedSchema.required;
      if ((params as Record<string, unknown>).additionalProperties === false) {
        delete (params as Record<string, unknown>).additionalProperties;
      }
      modifiedCount++;
    }

    if (modifiedCount > 0) {
      debugLog(`[OpenAI Responses Schema] Added _intent and _displayName to ${modifiedCount} tools`);
    }

    return body;
  },

  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown> {
    const input = body.input as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(input)) return body;

    // Pass 1: repair structurally-broken history before metadata injection.
    // Real-world cause: some Pi SDK code paths (notably DeepSeek + custom
    // OpenAI-compatible endpoints) occasionally drop `call_id` on replayed
    // function_call entries, or emit a function_call_output that doesn't
    // reference any earlier function_call. The upstream replies with an
    // opaque 400 (#613). We synthesize a deterministic id and drop true
    // orphans so the request reaches the API in a usable shape.
    repairResponsesHistoryInPlace(input);

    let injectedCount = 0;

    for (const entry of input) {
      if (entry.type !== 'function_call' || typeof entry.call_id !== 'string' || typeof entry.arguments !== 'string') continue;

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(entry.arguments) as Record<string, unknown>;
      } catch {
        continue;
      }

      const hasIntent = '_intent' in args;
      const hasDisplayName = '_displayName' in args;
      if (hasIntent && hasDisplayName) continue;

      const stored = toolMetadataStore.get(entry.call_id);
      if (!stored) continue;

      const newArgs: Record<string, unknown> = {};
      if (!hasDisplayName && stored.displayName) newArgs._displayName = stored.displayName;
      if (!hasIntent && stored.intent) newArgs._intent = stored.intent;
      if (Object.keys(newArgs).length > 0) {
        Object.assign(newArgs, args);
        entry.arguments = JSON.stringify(newArgs);
        injectedCount++;
      }
    }

    if (injectedCount > 0) {
      debugLog(`[OpenAI Responses History] Re-injected metadata into ${injectedCount} function_call items`);
    }

    return body;
  },

  validateOutgoingBody(body: Record<string, unknown>): void {
    validateOpenAiResponsesBody(body);
  },

  modifyRequest(_url: string, init: RequestInit, body: Record<string, unknown>) {
    return { init, body: normalizeOpenAiResponsesRequest(body) };
  },

  createSseProcessor(): TransformStream<Uint8Array, Uint8Array> {
    return createOpenAiResponsesSseStrippingStream();
  },

  stripsSseMetadata: true,
};
