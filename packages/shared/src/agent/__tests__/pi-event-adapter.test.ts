import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, makeUsage, recordedPiEvent, eventOfType } from './fixtures/pi-event-fixtures.ts';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

describe('PiEventAdapter — lifecycle', () => {
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

it('discards only the failed partial before an SDK retry starts a fresh response', () => {
    const first = collect(adapter.adaptEvent(recordedPiEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'FAILED_PARTIAL' },
    })));
    const failedTurn = first.find(event => event.type === 'text_delta')!.turnId;
    if (!failedTurn) throw new Error('Expected failed attempt turn ID');
    const failed = collect(adapter.adaptEvent(recordedPiEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '503 overloaded', content: [{ type: 'text', text: 'FAILED_PARTIAL' }] },
    })));
    expect(failed).toContainEqual({ type: 'text_discard', turnId: failedTurn });
    expect(failed.some(event => event.type === 'text_complete')).toBe(false);
    const recovered = collect(adapter.adaptEvent(recordedPiEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'RECOVERED' },
    })));
    expect(recovered.find(event => event.type === 'text_delta')!.turnId).not.toBe(failedTurn);
    const complete = collect(adapter.adaptEvent(recordedPiEvent({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'RECOVERED' }] },
    })));
    expect(complete.filter(event => event.type === 'text_complete')).toEqual([
      expect.objectContaining({ text: 'RECOVERED' }),
    ]);
  });

describe('agent lifecycle', () => {
    it('should emit nothing for agent_start', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_start' })));
      expect(events).toHaveLength(0);
    });

    it('should emit complete for settled SDK execution', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_settled', aborted: false })));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'complete' });
    });
  });

describe('turn usage aggregation', () => {
    it('sums every assistant call across tool turns while keeping usage_update per call', () => {
      adapter.setContextWindow(200_000);
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      const streamed = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Checking' },
      })));
      const firstCall = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Checking the file',
          usage: makeUsage(100, 20, 40, 10, 0.012),
        },
      })));

      const toolStart = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_usage_read',
        toolName: 'read',
        args: { path: '/repo/file.ts' },
      })));
      const toolEnd = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_usage_read',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      })));

      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_end' })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      const secondCall = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Done',
          usage: makeUsage(250, 30, 150, 25, 0.045),
        },
      })));
      const completed = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_settled', aborted: false })));

      expect(streamed).toMatchObject([{ type: 'text_delta', text: 'Checking' }]);
      expect(firstCall.map(event => event.type)).toEqual(['text_complete', 'usage_update']);
      expect(eventOfType(firstCall[0], 'text_complete').turnId).toBe(eventOfType(streamed[0], 'text_delta').turnId);
      expect(firstCall[1]).toEqual({
        type: 'usage_update',
        usage: { inputTokens: 140, contextWindow: 200_000 },
      });
      expect(toolStart).toMatchObject([{ type: 'tool_start', toolUseId: 'call_usage_read' }]);
      expect(toolEnd).toMatchObject([{ type: 'tool_result', toolUseId: 'call_usage_read' }]);
      expect(secondCall.map(event => event.type)).toEqual(['text_complete', 'usage_update']);
      expect(secondCall[1]).toEqual({
        type: 'usage_update',
        usage: { inputTokens: 400, contextWindow: 200_000 },
      });

      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        type: 'complete',
        usage: {
          inputTokens: 540,
          outputTokens: 50,
          cacheReadTokens: 190,
          cacheCreationTokens: 35,
          contextTokens: 400,
          contextWindow: 200_000,
        },
      });
      expect(eventOfType(completed[0], 'complete').usage?.costUsd).toBeCloseTo(0.057, 10);
    });

    it('resets accumulated usage at the next Craft turn boundary', () => {
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'First turn',
          usage: makeUsage(500, 50, 100, 20, 0.08),
        },
      })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_settled', aborted: false })));

      adapter.startTurn();
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Second turn',
          usage: makeUsage(40, 5, 10, 2, 0.006),
        },
      })));
      const completed = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_settled', aborted: false })));

      expect(completed[0]).toEqual({
        type: 'complete',
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadTokens: 10,
          cacheCreationTokens: 2,
          costUsd: 0.006,
          contextTokens: 50,
          contextWindow: undefined,
        },
      });
    });

    it('includes billed usage from a failed call that the SDK retries', () => {
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'temporary provider failure',
          usage: makeUsage(80, 3, 20, 0, 0.01),
        },
      })));
      expect(collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end', willRetry: true })))).toEqual([]);

      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Recovered',
          usage: makeUsage(90, 7, 30, 5, 0.02),
        },
      })));
      const completed = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_settled', aborted: false })));

      expect(completed).toEqual([{
        type: 'complete',
        usage: {
          inputTokens: 220,
          outputTokens: 10,
          cacheReadTokens: 50,
          cacheCreationTokens: 5,
          costUsd: 0.03,
          contextTokens: 120,
          contextWindow: undefined,
        },
      }]);
    });
  });

describe('turn lifecycle', () => {
    it('should set currentTurnId on turn_start', () => {
      // turn_start is handled internally — emits no events
      const events = collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      expect(events).toHaveLength(0);
    });

    it('should emit nothing on turn_end', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      const events = collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_end' })));
      expect(events).toHaveLength(0);
    });

    it('should generate sequential turn IDs across turns', () => {
      // First turn (turnIndex=1 from beforeEach startTurn)
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      const events1 = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello' },
      })));
      expect(eventOfType(events1[0], 'text_complete').turnId).toMatch(/^pi-turn-1/);

      // End first turn, start second
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_end' })));
      adapter.startTurn();
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      const events2 = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'World' },
      })));
      expect(eventOfType(events2[0], 'text_complete').turnId).toMatch(/^pi-turn-2/);
    });
  });
});
