import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, adaptRecordedPiEvent, eventOfType } from './fixtures/pi-event-fixtures.ts';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

describe('PiEventAdapter — tool-metadata', () => {
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
it('should emit tool_start for tool_execution_start', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_123',
        toolName: 'bash',
        args: { command: 'ls -la', description: 'List files' },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_123',
        input: { command: 'ls -la', description: 'List files' },
        displayName: 'Run Command',
      });
    });

it('should fallback to args metadata when store has no entry', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_no_store',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Run unit tests',
          _displayName: 'Run Tests',
        },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_no_store',
        intent: 'Run unit tests',
        displayName: 'Run Tests',
      });
    });

it('should preserve edits[] for Pi edit tools while deriving legacy diff fields', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_edit',
        toolName: 'edit',
        args: {
          path: '/src/app.ts',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Edit',
        toolUseId: 'call_edit',
        input: {
          file_path: '/src/app.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 2',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      });
    });

it('should prefer store metadata over args metadata when both exist', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      toolMetadataStore.set('call_store_wins', {
        intent: 'Stored intent',
        displayName: 'Stored name',
        timestamp: Date.now(),
      });

      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_store_wins',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Args intent',
          _displayName: 'Args name',
        },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_store_wins',
        intent: 'Stored intent',
        displayName: 'Stored name',
      });
    });

it('should use canonical metadata from event payload', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_canonical',
        toolName: 'bash',
        args: { command: 'npm test' },
        toolMetadata: {
          intent: 'Canonical intent',
          displayName: 'Canonical name',
          source: 'interceptor',
        },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_canonical',
        intent: 'Canonical intent',
        displayName: 'Canonical name',
      });
    });

it('should fallback to base id metadata when toolCallId includes a pipe suffix', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      toolMetadataStore.set('call_base_id', {
        intent: 'Stored base intent',
        displayName: 'Stored base name',
        timestamp: Date.now(),
      });

      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_base_id|fc_123',
        toolName: 'bash',
        args: { command: 'npm test' },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_base_id|fc_123',
        intent: 'Stored base intent',
        displayName: 'Stored base name',
      });
    });

it('should prefer canonical metadata over store and args', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      toolMetadataStore.set('call_canonical_wins', {
        intent: 'Stored intent',
        displayName: 'Stored name',
        timestamp: Date.now(),
      });

      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_canonical_wins',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Args intent',
          _displayName: 'Args name',
        },
        toolMetadata: {
          intent: 'Canonical intent',
          displayName: 'Canonical name',
          source: 'interceptor',
        },
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_canonical_wins',
        intent: 'Canonical intent',
        displayName: 'Canonical name',
      });
    });

it('should resolve Pi lowercase tool names to PascalCase', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));

      const toolTests = [
        { piName: 'read', expected: 'Read' },
        { piName: 'write', expected: 'Write' },
        { piName: 'edit', expected: 'Edit' },
        { piName: 'grep', expected: 'Grep' },
        { piName: 'find', expected: 'Find' },
        { piName: 'ls', expected: 'Ls' },
      ];

      for (const { piName, expected } of toolTests) {
        const events = collect(adaptRecordedPiEvent(adapter, {
          type: 'tool_execution_start',
          toolCallId: `call_${piName}`,
          toolName: piName,
          args: {},
        }));

        expect(eventOfType(events[0], 'tool_start').toolName).toBe(expected);
      }
    });

it('should use description as intent for bash tools', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'npm test', description: 'Run unit tests' },
      }));

      expect(eventOfType(events[0], 'tool_start').intent).toBe('Run unit tests');
    });

it('keeps the Bash identity and command for read-like starts and results', () => {
      collect(adaptRecordedPiEvent(adapter, { type: 'turn_start' }));
      const events = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'cat /path/to/file.ts' },
      }));

      expect(events).toHaveLength(1);
      expect(eventOfType(events[0], 'tool_start').toolName).toBe('Bash');
      expect(eventOfType(events[0], 'tool_start').input).toEqual({ command: 'cat /path/to/file.ts' });
      expect(eventOfType(events[0], 'tool_start').displayName).toBe('Read File');

      const results = collect(adaptRecordedPiEvent(adapter, {
        type: 'tool_execution_end', toolCallId: 'call_1',
        result: { content: [{ type: 'text', text: 'file contents' }], details: { executed: true } },
        isError: false,
      }));
      expect(results[0]).toMatchObject({ toolName: 'Bash', result: 'file contents',
        input: { command: 'cat /path/to/file.ts' }, executed: true });
    });
});
});
