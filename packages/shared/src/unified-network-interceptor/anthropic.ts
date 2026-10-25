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
import { debugLog, isRichToolDescriptionsEnabled, is1MContextEnabled, toolMetadataStore } from "../interceptor-common.ts";
import { FAST_MODE_BETA, appendBetaHeader, getConfiguredBaseUrl, sanitizeEmptyTextCacheControl, shouldEnableFastMode, stripBetaHeader, upgradePromptCacheTtl } from './cache-control.ts';
import type { HeadersInitType } from './configuration.ts';
import type { ApiAdapter } from './tool-metadata.ts';
import { captureMetadataFromInput, injectMetadataIntoToolSchema, stripMetadataFieldsFromRawJson } from './tool-metadata.ts';

/** State for a tracked tool_use block during Anthropic SSE streaming */
interface TrackedToolBlock {
  id: string;
  name: string;
  index: number;
  bufferedJson: string;
}

const SSE_EVENT_RE = /^event:\s*(.+)$/;

const SSE_DATA_RE = /^data:\s*(.+)$/;

/**
 * Creates a TransformStream that intercepts Anthropic SSE events,
 * buffers tool_use input deltas, extracts _intent/_displayName into the metadata
 * store, and re-emits clean events without those fields.
 */
export function createAnthropicSseStrippingStream(): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const trackedBlocks = new Map<number, TrackedToolBlock>();
  let lineBuffer = '';
  let currentEventType = '';
  let currentData = '';
  let eventCount = 0;

  function processEvent(eventType: string, dataStr: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    eventCount++;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    if (eventType === 'content_block_start') {
      const contentBlock = data.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (contentBlock?.type === 'tool_use' && contentBlock.id && contentBlock.name != null) {
        const index = data.index as number;
        trackedBlocks.set(index, {
          id: contentBlock.id,
          name: contentBlock.name,
          index,
          bufferedJson: '',
        });
      }
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = data.index as number;
      const delta = data.delta as { type?: string; partial_json?: string } | undefined;

      if (delta?.type === 'input_json_delta' && trackedBlocks.has(index)) {
        const block = trackedBlocks.get(index)!;
        block.bufferedJson += delta.partial_json ?? '';
        return;
      }
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = data.index as number;
      const block = trackedBlocks.get(index);

      if (block) {
        trackedBlocks.delete(index);
        emitBufferedBlock(block, index, controller);
        emitSseEvent(eventType, dataStr, controller);
        return;
      }
      emitSseEvent(eventType, dataStr, controller);
      return;
    }

    emitSseEvent(eventType, dataStr, controller);
  }

  function emitBufferedBlock(
    block: TrackedToolBlock,
    index: number,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (!block.bufferedJson) {
      return;
    }

    try {
      const parsed = JSON.parse(block.bufferedJson);

      captureMetadataFromInput(block.id, block.name, parsed);
      delete parsed._intent;
      delete parsed._displayName;

      const cleanJson = JSON.stringify(parsed);

      const deltaEvent = {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: cleanJson,
        },
      };
      emitSseEvent('content_block_delta', JSON.stringify(deltaEvent), controller);
    } catch {
      debugLog(`[SSE Strip] Failed to parse buffered JSON for ${block.name} (${block.id}), stripping via regex`);
      const stripped = stripMetadataFieldsFromRawJson(block.bufferedJson);
      const deltaEvent = {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: stripped,
        },
      };
      emitSseEvent('content_block_delta', JSON.stringify(deltaEvent), controller);
    }
  }

  function emitSseEvent(
    eventType: string,
    dataStr: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    const sseText = `event: ${eventType}\ndata: ${dataStr}\n\n`;
    controller.enqueue(encoder.encode(sseText));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = lineBuffer + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === '') {
          if (currentEventType && currentData) {
            processEvent(currentEventType, currentData, controller);
          }
          currentEventType = '';
          currentData = '';
          continue;
        }

        const eventMatch = trimmed.match(SSE_EVENT_RE);
        if (eventMatch) {
          currentEventType = eventMatch[1]!.trim();
          continue;
        }

        const dataMatch = trimmed.match(SSE_DATA_RE);
        if (dataMatch) {
          currentData = currentData ? `${currentData}\n${dataMatch[1]!}` : dataMatch[1]!;
          continue;
        }
      }
    },

    flush(controller) {
      if (lineBuffer.trim()) {
        const lines = lineBuffer.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed === '') {
            if (currentEventType && currentData) {
              processEvent(currentEventType, currentData, controller);
            }
            currentEventType = '';
            currentData = '';
            continue;
          }
          const eventMatch = trimmed.match(SSE_EVENT_RE);
          if (eventMatch) {
            currentEventType = eventMatch[1]!.trim();
            continue;
          }
          const dataMatch = trimmed.match(SSE_DATA_RE);
          if (dataMatch) {
            currentData = currentData ? `${currentData}\n${dataMatch[1]!}` : dataMatch[1]!;
          }
        }

        if (currentEventType && currentData) {
          processEvent(currentEventType, currentData, controller);
        }
      }

      for (const [index, block] of trackedBlocks) {
        emitBufferedBlock(block, index, controller);
      }
      trackedBlocks.clear();
      lineBuffer = '';
      debugLog(`[SSE] Stream flush complete. Total events processed: ${eventCount}`);
    },
  });
}

export const anthropicAdapter: ApiAdapter = {
  name: 'anthropic',

  shouldIntercept(url: string): boolean {
    const baseUrl = getConfiguredBaseUrl();
    return url.startsWith(baseUrl) && url.includes('/messages');
  },

  addMetadataToTools(body: Record<string, unknown>): Record<string, unknown> {
    const tools = body.tools as Array<{
      name?: string;
      input_schema?: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }> | undefined;

    if (!tools || !Array.isArray(tools)) {
      return body;
    }

    const richDescriptions = isRichToolDescriptionsEnabled();
    let modifiedCount = 0;
    for (const tool of tools) {
      // MCP tools always get metadata regardless of the feature flag — they're
      // lower-volume than built-in tools and the metadata drives source-specific
      // UI (tool intents, display names in the sidebar).
      const isMcpTool = tool.name?.startsWith('mcp__');
      if (!richDescriptions && !isMcpTool) {
        continue;
      }

      if (!tool.input_schema || typeof tool.input_schema !== 'object') {
        continue;
      }

      const updatedSchema = injectMetadataIntoToolSchema(tool.input_schema);
      tool.input_schema.properties = updatedSchema.properties;
      tool.input_schema.required = updatedSchema.required;
      // External MCP servers may set additionalProperties: false which would
      // cause the API to reject _intent/_displayName in tool inputs.
      if ((tool.input_schema as Record<string, unknown>).additionalProperties === false) {
        delete (tool.input_schema as Record<string, unknown>).additionalProperties;
      }
      modifiedCount++;
    }

    if (modifiedCount > 0) {
      debugLog(`[Anthropic Schema] Added _intent and _displayName to ${modifiedCount} tools`);
    }

    return body;
  },

  injectMetadataIntoHistory(body: Record<string, unknown>): Record<string, unknown> {
    const messages = body.messages as Array<{
      role?: string;
      content?: Array<{
        type?: string;
        id?: string;
        input?: Record<string, unknown>;
      }>;
    }> | undefined;

    if (!messages) return body;

    let injectedCount = 0;

    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        if (block.type !== 'tool_use' || !block.id || !block.input) continue;

        const hasIntent = '_intent' in block.input;
        const hasDisplayName = '_displayName' in block.input;
        if (hasIntent && hasDisplayName) continue;

        const stored = toolMetadataStore.get(block.id);
        if (stored) {
          const newInput: Record<string, unknown> = {};
          if (!hasDisplayName && stored.displayName) newInput._displayName = stored.displayName;
          if (!hasIntent && stored.intent) newInput._intent = stored.intent;
          if (Object.keys(newInput).length > 0) {
            Object.assign(newInput, block.input);
            block.input = newInput;
            injectedCount++;
          }
        }
      }
    }

    if (injectedCount > 0) {
      debugLog(`[Anthropic History] Re-injected metadata into ${injectedCount} tool_use blocks`);
    }

    return body;
  },

  createSseProcessor(): TransformStream<Uint8Array, Uint8Array> {
    return createAnthropicSseStrippingStream();
  },

  stripsSseMetadata: true,

  modifyRequest(_url: string, init: RequestInit, body: Record<string, unknown>): { init: RequestInit; body: Record<string, unknown> } {
    sanitizeEmptyTextCacheControl(body);
    upgradePromptCacheTtl(body);

    // Strip SDK-injected 1M context beta when setting disables it.
    // The SDK adds this header automatically for Opus/Sonnet 4.6 models,
    // but the user may want 200K context to conserve usage limits.
    if (!is1MContextEnabled()) {
      debugLog('[Anthropic] Stripping context-1m beta header (enable1MContext=false)');
      init = {
        ...init,
        headers: stripBetaHeader(init?.headers as HeadersInitType | undefined, 'context-1m-2025-08-07'),
      };
    }

    const fastMode = shouldEnableFastMode(body.model);
    if (fastMode) {
      body.speed = 'fast';
      debugLog(`[Fast Mode] Enabled for model=${body.model}`);
      return {
        init: {
          ...init,
          headers: appendBetaHeader(init?.headers as HeadersInitType | undefined, FAST_MODE_BETA),
        },
        body,
      };
    }
    return { init, body };
  },
};
