import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, adaptRecordedPiEvent, eventOfType } from './fixtures/pi-event-fixtures.ts';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

describe('PiEventAdapter — messages', () => {
let adapter: PiEventAdapter;

let sessionDir: string;

beforeEach(() => {
    adapter = new PiEventAdapter();
    sessionDir = mkdtempSync(join(tmpdir(), 'pi-adapter-'));
    adapter.setSessionDir(sessionDir);
    toolMetadataStore.setSessionDir(sessionDir);
    adapter.startTurn();
  });

afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

describe('message events', () => {
    it('should emit nothing for message_start', () => {
      const events = collect(adaptRecordedPiEvent(adapter, { type: 'message_start' }));
      expect(events).toHaveLength(0);
    });

    it('should emit text_delta for message_update with text_delta', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_delta',
        text: 'Hello',
      });
      expect(eventOfType(events[0], 'text_delta').turnId).toMatch(/^pi-turn-1__m0$/);
    });

    it('should skip message_update without text_delta type', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_update',
        assistantMessageEvent: { type: 'usage_delta', delta: null },
      }));
      expect(events).toHaveLength(0);
    });

    it('should skip message_update with empty delta', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '' },
      }));
      expect(events).toHaveLength(0);
    });

    it('should reuse same sub-turnId for consecutive deltas', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      const events1 = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      }));
      const events2 = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: ' World' },
      }));

      expect(eventOfType(events1[0], 'text_delta').turnId).toBe(eventOfType(events2[0], 'text_delta').turnId);
    });

    it('should emit text_complete for final assistant message_end', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello there' },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Hello there',
        isIntermediate: false,
      });
    });

    it('should attach sdkMessageId from message_end onto the text_complete', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        sdkMessageId: 'msg_pi_abc123',
        message: { role: 'assistant', stopReason: 'stop', content: 'Anchored output', id: 'msg_pi_abc123' },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Anchored output',
        sdkMessageId: 'msg_pi_abc123',
      });
      // sdkTurnAnchor is delivered separately by a follow-up pi_turn_anchor event.
      expect((events[0] as { sdkTurnAnchor?: string }).sdkTurnAnchor).toBeUndefined();
    });

    it('should attach per-message native model provenance to text_complete', () => {
      adapter.setContextWindow(1_000_000);
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      const dynamicallyRouted = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Checking with a tool',
          model: 'openrouter/auto',
          responseModel: 'anthropic/claude-sonnet-4.6',
          provider: 'openrouter',
          api: 'openai-completions',
        },
      }));
      const directModel = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Final answer',
          model: 'openai-codex/gpt-5.6-sol',
          provider: 'openai-codex',
          api: 'openai-codex-responses',
        },
      }));

      expect(dynamicallyRouted[0]).toMatchObject({
        type: 'text_complete',
        modelProvenance: {
          model: 'anthropic/claude-sonnet-4.6',
          requestedModel: 'openrouter/auto',
          provider: 'openrouter',
          api: 'openai-completions',
          contextWindow: 1_000_000,
        },
      });
      expect(directModel[0]).toMatchObject({
        type: 'text_complete',
        modelProvenance: {
          model: 'openai-codex/gpt-5.6-sol',
          requestedModel: 'openai-codex/gpt-5.6-sol',
          provider: 'openai-codex',
          api: 'openai-codex-responses',
          contextWindow: 1_000_000,
        },
      });
    });

    it('should forward pi_turn_anchor events as Craft AgentEvents', () => {
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
        sdkTurnAnchor: 'entry_abc123',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
        sdkTurnAnchor: 'entry_abc123',
      });
    });

    it('should drop pi_turn_anchor events with missing fields', () => {
      // No sdkTurnAnchor — useless to consumers.
      const e1 = collect(adaptRecordedPiEvent(adapter, {
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
      }));
      expect(e1).toHaveLength(0);
      // No sdkMessageId — cannot correlate.
      const e2 = collect(adaptRecordedPiEvent(adapter, {
        type: 'pi_turn_anchor',
        sdkTurnAnchor: 'entry_abc123',
      }));
      expect(e2).toHaveLength(0);
    });

    it('should skip non-assistant message_end', () => {
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: { role: 'user', content: 'Hello' },
      }));
      expect(events).toHaveLength(0);
    });

    it('should skip toolResult message_end', () => {
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: { role: 'toolResult', content: 'result' },
      }));
      expect(events).toHaveLength(0);
    });

    it('should extract text from content array', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: ' Part 2' },
          ],
        },
      }));

      expect(events).toHaveLength(1);
      expect(eventOfType(events[0], 'text_complete').text).toBe('Part 1 Part 2');
    });

    it('should skip message_end with no text content', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'tool_use', id: 'tool1' }],
        },
      }));
      expect(events).toHaveLength(0);
    });
  });

describe('intermediate text classification', () => {
    it('should set isIntermediate: true when stopReason is toolUse', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check that...',
        },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Let me check that...',
        isIntermediate: true,
      });
    });

    it('should set isIntermediate: false when stopReason is stop', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Here is the final answer.',
        },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Here is the final answer.',
        isIntermediate: false,
      });
    });

    it('should allow multiple intermediate messages in a turn', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      // First intermediate message
      const events1 = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me read the file...',
        },
      }));

      // Simulate tool execution between intermediates
      collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      }));
      collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'file content',
        isError: false,
      }));

      // Second intermediate message
      const events2 = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Now let me check the tests...',
        },
      }));

      expect(events1).toHaveLength(1);
      expect(eventOfType(events1[0], 'text_complete').isIntermediate).toBe(true);

      expect(events2).toHaveLength(1);
      expect(eventOfType(events2[0], 'text_complete').isIntermediate).toBe(true);
    });

    it('should block duplicate final messages in same turn', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      // First final message
      const events1 = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Final answer',
        },
      }));

      // Duplicate final message (should be blocked)
      const events2 = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Duplicate final',
        },
      }));

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(0);
    });

    it('should allow final message after tool completion resets state', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      // Intermediate message
      collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      }));

      // Tool execution
      collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: {},
      }));
      collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'output',
        isError: false,
      }));

      // Final message after tool — should work because tool_execution_end resets hasEmittedFinalText
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Here is the answer.' },
      }));

      expect(events).toHaveLength(1);
      expect(eventOfType(events[0], 'text_complete').isIntermediate).toBe(false);
    });
  });
});
