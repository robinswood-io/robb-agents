import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, recordedPiEvent, eventOfType } from './fixtures/pi-event-fixtures.ts';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

describe('PiEventAdapter — tool-results', () => {
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

describe('tool events', () => {
it('should emit tool_result for tool_execution_end', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      // Start tool first
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      })));

      // End tool
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      })));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_1',
        toolName: 'Read',
        input: { file_path: '/foo.ts' },
        result: 'file contents',
        isError: false,
      });
    });

it('correlates the exact semantic input for non-built-in tool results', () => {
      const input = {
        messageId: '1a0a917ea946a540',
        expectedRecipientEmail: 'alice@example.com',
        body: 'Merci.',
        isHtml: false,
        nested: { values: ['one', 'two'] },
      };
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'gmail-preflight',
        toolName: 'mcp__google-contacts__gmail_reply_preflight',
        args: input,
      })));

      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'gmail-preflight',
        result: { content: [{ type: 'text', text: '{"ok":true}' }] },
        isError: false,
      })));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'gmail-preflight',
        input,
      });
    });

it('poisons repeated Pi tool ids instead of correlating either terminal', () => {
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'colliding-id',
        toolName: 'mcp__google-contacts__gmail_reply_preflight',
        args: { messageId: '1a0a917ea946a540', body: 'Premier' },
      })));
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'colliding-id',
        toolName: 'mcp__google-contacts__gmail_reply_bound',
        args: { messageId: '1a0a917ea946a540', body: 'Deuxième' },
      })));

      for (const result of ['first terminal', 'second terminal', 'duplicate terminal'] as const) {
        const terminal = collect(adapter.adaptEvent(recordedPiEvent({
          type: 'tool_execution_end',
          toolCallId: 'colliding-id',
          result,
          isError: false,
        })))[0];
        expect(terminal).toMatchObject({
          type: 'tool_result',
          toolUseId: 'colliding-id',
          toolName: 'tool',
        });
        expect(eventOfType(terminal, 'tool_result').input).toBeUndefined();
      }
    });

it('drops cached tool inputs after terminal results and lifecycle resets', () => {
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'terminal-cleanup',
        toolName: 'mcp__example__read',
        args: { value: 'terminal' },
      })));
      expect(eventOfType(collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'terminal-cleanup',
        result: 'done',
        isError: false,
      })))[0], 'tool_result').input).toEqual({ value: 'terminal' });
      expect(eventOfType(collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'terminal-cleanup',
        result: 'duplicate terminal',
        isError: false,
      })))[0], 'tool_result').input).toBeUndefined();

      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'runtime-reset',
        toolName: 'mcp__example__read',
        args: { value: 'stale runtime' },
      })));
      adapter.resetOverflowState();
      expect(eventOfType(collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'runtime-reset',
        result: 'late runtime result',
        isError: false,
      })))[0], 'tool_result').input).toBeUndefined();

      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'turn-reset',
        toolName: 'mcp__example__read',
        args: { value: 'stale turn' },
      })));
      adapter.startTurn();
      expect(eventOfType(collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'turn-reset',
        result: 'late turn result',
        isError: false,
      })))[0], 'tool_result').input).toBeUndefined();
    });

it('should handle string result in tool_execution_end', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      })));

      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'command output',
        isError: false,
      })));

      expect(eventOfType(events[0], 'tool_result').result).toBe('command output');
    });

it('should preserve a structured non-execution checkpoint from tool details', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_budget',
        toolName: 'bash',
        args: {},
      })));

      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_budget',
        result: {
          content: [{ type: 'text', text: 'Tool-call checkpoint reached.' }],
          details: {
            costControlBlocked: true,
            continuationRequired: true,
            executed: false,
            checkpoint: {
              schemaVersion: 1,
              kind: 'tool-call-budget',
              reason: 'Tool-call checkpoint reached.',
            },
          },
        },
        isError: false,
      })));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        isError: false,
        continuationRequired: true,
        executed: false,
        checkpoint: {
          schemaVersion: 1,
          kind: 'tool-call-budget',
          reason: 'Tool-call checkpoint reached.',
        },
      });
    });

it('normalizes legacy cost-control checkpoint details as non-executed', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_legacy_budget',
        toolName: 'edit',
        args: {},
      })));

      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_legacy_budget',
        result: {
          content: [{ type: 'text', text: 'Legacy checkpoint.' }],
          details: {
            costControlBlocked: true,
            continuationRequired: true,
            checkpoint: 'tool-call-budget',
          },
        },
        isError: false,
      })));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        continuationRequired: true,
        executed: false,
        checkpoint: {
          schemaVersion: 1,
          kind: 'tool-call-budget',
          reason: 'Legacy checkpoint.',
        },
      });
    });

it('should handle error tool results', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      })));

      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: null,
        isError: true,
      })));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        isError: true,
        result: 'Tool execution failed',
      });
    });

it.each([
      ['complete result', { content: [{ type: 'text', text: '200|200' }] }, false, '200|200'],
      ['empty string result', '', false, ''],
      ['empty text result', { content: [{ type: 'text', text: '' }] }, false, ''],
      ['empty content result', { content: [] }, false, ''],
      ['final error', { content: [{ type: 'text', text: 'Command failed' }] }, true, 'Command failed'],
      ['missing error result', undefined, true, 'Tool execution failed'],
      ['missing final result', undefined, false, '200|200'],
      ['null final result', null, false, '200|200'],
    ])('preserves %s after cumulative Pi updates', (_label, result, isError, expected) => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_start', toolCallId: 'call_1',
        toolName: 'bash', args: {} })));
      for (const text of ['200|', '200|200'] as const) {
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_update', toolCallId: 'call_1',
          partialResult: { content: [{ type: 'text', text }] } })));
      }
      const events = collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_end', toolCallId: 'call_1',
        result, isError })));
      expect(events[0]).toMatchObject({ type: 'tool_result', result: expected, isError });
    });

it('never masks a host block with streamed successful output', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_start', toolCallId: 'blocked',
        toolName: 'bash', args: {} })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_update', toolCallId: 'blocked',
        partialResult: { content: [{ type: 'text', text: 'PASS' }] } })));
      adapter.setBlockReason('blocked', 'Application protection denied execution');
      const events = collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_end', toolCallId: 'blocked',
        result: { content: [{ type: 'text', text: 'PASS' }] }, isError: true })));
      expect(events[0]).toMatchObject({ isError: true, result: 'Application protection denied execution' });
    });

it('keeps snapshots scoped to each tool and clears them after a turn', () => {
      for (const [toolCallId, text] of [['one', 'first'], ['two', 'second']] as const) {
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_start', toolCallId,
          toolName: 'bash', args: {} })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_update', toolCallId,
          partialResult: { content: [{ type: 'text', text }] } })));
      }
      const finish = (toolCallId: string) => eventOfType(collect(adapter.adaptEvent(recordedPiEvent({
        type: 'tool_execution_end', toolCallId, result: null, isError: false })))[0], 'tool_result').result;
      expect(finish('two')).toBe('second');
      expect(finish('one')).toBe('first');
      expect(finish('one')).toBe('Success');
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'tool_execution_update', toolCallId: 'stale',
        partialResult: { content: [{ type: 'text', text: 'old' }] } })));
      adapter.startTurn();
      expect(finish('stale')).toBe('Success');
    });

it('should reset hasEmittedFinalText after tool_execution_end', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      // Emit final text
      collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      })));

      // Tool execution
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

      // Another text after tool — should succeed
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Done!' },
      })));

      expect(events).toHaveLength(1);
      expect(eventOfType(events[0], 'text_complete').text).toBe('Done!');
    });
});
});
