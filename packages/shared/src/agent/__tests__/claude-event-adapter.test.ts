import { describe, it, expect, beforeEach } from 'bun:test';import { ClaudeEventAdapter } from '../backend/claude/event-adapter.ts';
import { createCallbacks, adaptRecordedClaudeMessage } from './fixtures/claude-event-fixtures.ts';

describe('ClaudeEventAdapter', () => {
let adapter: ClaudeEventAdapter;

beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

describe('stream_event: message_start', () => {
    it('should capture turn ID from message_start', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg-123' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      // No events emitted for message_start itself
      expect(events).toHaveLength(0);

      // Subsequent events should include the turn ID
      const textEvents = await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      expect(textEvents).toHaveLength(1);
      expect(textEvents[0]).toMatchObject({
        type: 'text_delta',
        text: 'hello',
        turnId: 'msg-123',
      });
    });
  });

describe('stream_event: text_delta', () => {
    it('should emit text_delta for content_block_delta', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Hello world' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_delta',
        text: 'Hello world',
      });
    });

    it('should include parentToolUseId from SDK message', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'nested' },
        },
        parent_tool_use_id: 'task-001',
        session_id: 'sess-1',
      });

      expect(events[0]).toMatchObject({
        type: 'text_delta',
        parentToolUseId: 'task-001',
      });
    });
  });

describe('stream_event: message_delta (text_complete)', () => {
    it('should emit text_complete when message_delta arrives with pending text', async () => {
      // First: assistant message sets pending text
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Final answer' }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      // Then: message_delta triggers text_complete
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      const textComplete = events.find(e => e.type === 'text_complete');
      expect(textComplete).toBeDefined();
      expect(textComplete).toMatchObject({
        type: 'text_complete',
        text: 'Final answer',
        isIntermediate: false,
      });
    });

    it('should set isIntermediate=true when stop_reason is tool_use', async () => {
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Let me check...' }],
          usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      const textComplete = events.find(e => e.type === 'text_complete');
      expect(textComplete).toMatchObject({
        isIntermediate: true,
      });
    });
  });

describe('assistant message', () => {
    it('should skip replayed messages', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'replayed' }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: true,
      });

      expect(events).toHaveLength(0);
    });

    it('should emit usage_update for non-sidechain messages', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [],
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
          },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      const usageEvent = events.find(e => e.type === 'usage_update');
      expect(usageEvent).toBeDefined();
      expect(usageEvent).toMatchObject({
        type: 'usage_update',
        usage: {
          inputTokens: 1700, // 1000 + 500 + 200
        },
      });
    });

    it('should not emit usage_update for sidechain messages', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: 'task-001', // sidechain
        session_id: 'sess-1',
        isReplay: false,
      });

      const usageEvent = events.find(e => e.type === 'usage_update');
      expect(usageEvent).toBeUndefined();
    });

    it('should handle SDK errors via callback', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [], usage: {} },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'typed_error',
        error: {
          message: 'Mock error for rate_limit',
        },
      });
    });
  });

describe('flushPending', () => {
    it('should flush pending text', async () => {
      // Set pending text via assistant message
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'unflushed text' }],
          usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      const flushed = adapter.flushPending();
      expect(flushed).toMatchObject({
        type: 'text_complete',
        text: 'unflushed text',
        isIntermediate: false,
      });

      // Second flush should return null
      expect(adapter.flushPending()).toBeNull();
    });

    it('should return null when nothing pending', () => {
      expect(adapter.flushPending()).toBeNull();
    });
  });

describe('unknown message types', () => {
    it('should log and return empty for unknown types', async () => {
      const debugMessages: string[] = [];
      const adapter = new ClaudeEventAdapter(createCallbacks({
        onDebug: (msg) => debugMessages.push(msg),
      }));
      adapter.startTurn();

      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'unknown_type',
        session_id: 'sess-1',
      });

      expect(events).toHaveLength(0);
      expect(debugMessages.some(m => m.includes('Unhandled SDK message type'))).toBe(true);
    });
  });
});
