import { describe, it, expect, beforeEach } from 'bun:test';import { ClaudeEventAdapter } from '../backend/claude/event-adapter.ts';
import { createCallbacks, adaptRecordedClaudeMessage } from './fixtures/claude-event-fixtures.ts';

describe('ClaudeEventAdapter', () => {
let adapter: ClaudeEventAdapter;

beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

describe('user message (tool results)', () => {
    it('should skip replayed user messages', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'user',
        tool_use_result: 'result data',
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: true,
      });

      expect(events).toHaveLength(0);
    });
  });

describe('tool_progress', () => {
    it('should emit task_progress with elapsed time', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Task',
        parent_tool_use_id: 'parent-1',
        elapsed_time_seconds: 5.2,
        session_id: 'sess-1',
      });

      const progressEvent = events.find(e => e.type === 'task_progress');
      expect(progressEvent).toBeDefined();
      expect(progressEvent).toMatchObject({
        type: 'task_progress',
        toolUseId: 'parent-1', // Uses parent_tool_use_id
        elapsedSeconds: 5.2,
      });
    });

    it('should use tool_use_id when no parent', async () => {
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'tool_progress',
        tool_use_id: 'tool-1',
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: 1.0,
        session_id: 'sess-1',
      });

      const progressEvent = events.find(e => e.type === 'task_progress');
      expect(progressEvent).toMatchObject({
        toolUseId: 'tool-1',
      });
    });
  });

describe('tool start dedup across stream + assistant messages', () => {
    it('should re-emit tool_start with complete input when assistant follows stream', async () => {
      // Stream event arrives first with content_block_start (empty input)
      const streamEvents = await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-dup-1', name: 'Read', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      const streamToolStarts = streamEvents.filter(e => e.type === 'tool_start');
      expect(streamToolStarts).toHaveLength(1);
      expect(streamToolStarts[0]).toMatchObject({ toolUseId: 'tool-dup-1', toolName: 'Read', input: {} });

      // Full assistant message arrives with same tool + complete input
      const assistantEvents = await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-dup-1', name: 'Read', input: { file_path: '/test' } }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      // Should re-emit with complete input (update mechanism for UI)
      const assistantToolStarts = assistantEvents.filter(e => e.type === 'tool_start');
      expect(assistantToolStarts).toHaveLength(1);
      expect(assistantToolStarts[0]).toMatchObject({
        toolUseId: 'tool-dup-1',
        toolName: 'Read',
        input: { file_path: '/test' },
      });
    });

    it('should not re-emit when assistant has no new input', async () => {
      // Stream with empty input
      await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-noinput-1', name: 'Read', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      // Assistant also has empty input (same as stream)
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tool-noinput-1', name: 'Read', input: {} }],
          usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      // No re-emit because input is still empty
      const toolStarts = events.filter(e => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(0);
    });

    it('should handle multiple tools: re-emit known + emit new', async () => {
      // Stream for tool-a (empty input)
      await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'tool-a', name: 'Read', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      // Assistant with tool-a (complete input) + tool-b (new)
      const events = await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'tool-a', name: 'Read', input: { file_path: '/a' } },
            { type: 'tool_use', id: 'tool-b', name: 'Grep', input: { pattern: 'x' } },
          ],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      // tool-a re-emitted with complete input + tool-b is new
      const toolStarts = events.filter(e => e.type === 'tool_start');
      expect(toolStarts).toHaveLength(2);
      expect(toolStarts[0]).toMatchObject({ toolUseId: 'tool-a', input: { file_path: '/a' } });
      expect(toolStarts[1]).toMatchObject({ toolUseId: 'tool-b', input: { pattern: 'x' } });
    });
  });

describe('activeParentTools lifecycle', () => {
    it('should track Task tools and remove them on result', async () => {
      // Task tool start via assistant message
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'task-parent-1', name: 'Task', input: { prompt: 'research' } }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      expect(adapter.getActiveParentTools().has('task-parent-1')).toBe(true);

      // Task tool result via user message
      await adaptRecordedClaudeMessage(adapter, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'task-parent-1',
            content: 'Done',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      expect(adapter.getActiveParentTools().has('task-parent-1')).toBe(false);
    });

    it('should reset activeParentTools on new turn', async () => {
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'task-reset-1', name: 'Task', input: {} }],
          usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      expect(adapter.getActiveParentTools().size).toBe(1);

      adapter.startTurn();
      expect(adapter.getActiveParentTools().size).toBe(0);
    });
  });

describe('toolIndex: tool_start → tool_result matching', () => {
    it('should match tool_result to previously started tool via toolIndex', async () => {
      // Step 1: tool_start via stream event
      await adaptRecordedClaudeMessage(adapter, {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: { type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
      });

      // Step 2: assistant message confirms tool (deduped)
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'ls' } }],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      // Step 3: user message with tool result
      const resultEvents = await adaptRecordedClaudeMessage(adapter, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'bash-1',
            content: 'file1.txt\nfile2.txt',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      const toolResult = resultEvents.find(e => e.type === 'tool_result');
      expect(toolResult).toBeDefined();
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        toolUseId: 'bash-1',
        toolName: 'Bash',
      });
    });

    it('should handle full multi-tool sequence: start → result → start → result', async () => {
      // Tool 1 start
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me read the file.' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/test.ts' } },
          ],
          usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      // Tool 1 result
      const result1Events = await adaptRecordedClaudeMessage(adapter, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'read-1',
            content: 'file contents here',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      expect(result1Events.find(e => e.type === 'tool_result')).toMatchObject({
        toolUseId: 'read-1',
        toolName: 'Read',
      });

      // Tool 2 start
      await adaptRecordedClaudeMessage(adapter, {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Now let me search.' },
            { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'TODO' } },
          ],
          usage: { input_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      // Tool 2 result
      const result2Events = await adaptRecordedClaudeMessage(adapter, {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'grep-1',
            content: 'found 3 matches',
          }],
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      });

      expect(result2Events.find(e => e.type === 'tool_result')).toMatchObject({
        toolUseId: 'grep-1',
        toolName: 'Grep',
      });
    });
  });
});
