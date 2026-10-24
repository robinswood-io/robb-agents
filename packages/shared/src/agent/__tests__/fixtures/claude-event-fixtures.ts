import type { SDKMessage, SDKAssistantMessageError } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '../../tool-matching.ts';
import type { ClaudeAdapterCallbacks } from '../../backend/claude/event-adapter.ts';

type RecordedUsage = { input_tokens: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
type RecordedStreamEvent =
  | { type: 'message_start'; message: { id: string } }
  | { type: 'message_delta'; delta: { stop_reason: string | null } }
  | { type: 'content_block_delta'; delta: { type: 'text_delta'; text: string } }
  | { type: 'content_block_start'; content_block: {
      type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } };
type RecordedMessageBody = { content?: ContentBlock[]; usage?: Partial<RecordedUsage> };

/** Sparse messages recorded against earlier SDKs: omitted metadata is irrelevant
 * to these adapter cases. Legacy error/unknown subtypes remain explicit so the
 * tests continue covering tolerant wire handling, without per-case type escapes. */
type RecordedClaudeMessage = { session_id: string; parent_tool_use_id?: string | null;
  isReplay?: boolean } & (
  | { type: 'assistant'; message?: RecordedMessageBody; error?: SDKAssistantMessageError }
  | { type: 'stream_event'; event: RecordedStreamEvent }
  | { type: 'user'; message?: { content: ContentBlock[] }; tool_use_result?: unknown }
  | { type: 'tool_progress'; tool_use_id: string; tool_name: string;
      elapsed_time_seconds: number }
  | { type: 'result'; subtype: 'success' | 'error'; usage: RecordedUsage;
      errors?: string[]; total_cost_usd: number;
      modelUsage: Record<string, { contextWindow: number }> }
  | { type: 'system'; subtype: 'init'; tools: string[] }
  | { type: 'system'; subtype: 'compact_boundary' }
  | { type: 'system'; subtype: 'status'; status: string | null }
  | { type: 'system'; subtype: 'task_notification'; task_id?: string; status?: string;
      output_file?: string; summary?: string }
  | { type: 'auth_status'; error?: string | null }
  | { type: 'unknown_type' }
);

export function recordedClaudeMessage(message: RecordedClaudeMessage): SDKMessage {
  // The single fixture boundary for historical, deliberately sparse SDK data.
  return message as unknown as SDKMessage;
}

export function createCallbacks(overrides?: Partial<ClaudeAdapterCallbacks>): ClaudeAdapterCallbacks {
  return { onDebug: undefined, mapSDKError: async errorCode => ({
    type: 'typed_error', error: { code: 'unknown_error', title: 'Test Error',
      message: 'Mock error for ' + errorCode, details: [], actions: [], canRetry: false },
  }), ...overrides };
}
