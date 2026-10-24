import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, recordedPiEvent, eventOfType } from './fixtures/pi-event-fixtures.ts';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

describe('PiEventAdapter — correlation', () => {
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

describe('sub-turnId isolation', () => {
    it('should generate unique sub-turnIds for text blocks', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      // First text block
      const events1 = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'First' },
      })));

      // Tool between text blocks
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      })));
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
      })));

      // Second text block
      const events2 = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Second' },
      })));

      expect(eventOfType(events1[0], 'text_complete').turnId).not.toBe(eventOfType(events2[0], 'text_complete').turnId);
      expect(eventOfType(events1[0], 'text_complete').turnId).toMatch(/^pi-turn-1__m/);
      expect(eventOfType(events2[0], 'text_complete').turnId).toMatch(/^pi-turn-1__m/);
    });

    it('should use streaming sub-turnId when deltas preceded text_complete', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      // Stream deltas first
      const deltaEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      })));

      // Then text_complete
      const completeEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello world' },
      })));

      // text_complete should reuse the delta's sub-turnId
      expect(eventOfType(completeEvents[0], 'text_complete').turnId).toBe(eventOfType(deltaEvents[0], 'text_delta').turnId);
    });

    it('should reset sub-turnId counter across turns', () => {
      // First turn
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      const events1 = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 1' },
      })));

      // End turn, start new one
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_end' })));
      adapter.startTurn();
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      const events2 = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 2' },
      })));

      // Sub-turn counter resets: both should end with m0
      expect(eventOfType(events1[0], 'text_complete').turnId).toBe('pi-turn-1__m0');
      expect(eventOfType(events2[0], 'text_complete').turnId).toBe('pi-turn-2__m0');
    });
  });

describe('full multi-turn flow', () => {
    it('should handle intermediate → tool → final message flow', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      // 1. Intermediate commentary
      const intermediateEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check the file...',
        },
      })));

      // 2. Tool execution
      const toolStartEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/src/index.ts' },
      })));

      const toolEndEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'file contents here',
        isError: false,
      })));

      // 3. Final response
      const finalEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'The file contains your code.',
        },
      })));

      // Verify complete flow
      expect(intermediateEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: true,
        text: 'Let me check the file...',
      });
      expect(toolStartEvents[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Read',
      });
      expect(toolEndEvents[0]).toMatchObject({
        type: 'tool_result',
        toolName: 'Read',
      });
      expect(finalEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: false,
        text: 'The file contains your code.',
      });

      // All events should have pi-turn-1 prefix
      expect(eventOfType(intermediateEvents[0], 'text_complete').turnId).toMatch(/^pi-turn-1/);
      expect(eventOfType(toolStartEvents[0], 'tool_start').turnId).toMatch(/^pi-turn-1/);
      expect(eventOfType(finalEvents[0], 'text_complete').turnId).toMatch(/^pi-turn-1/);
    });
  });
});
