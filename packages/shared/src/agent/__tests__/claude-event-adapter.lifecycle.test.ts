import { describe, it, expect, beforeEach } from 'bun:test';
import { ClaudeEventAdapter, buildWindowsSkillsDirError } from '../backend/claude/event-adapter.ts';
import { createCallbacks, recordedClaudeMessage } from './fixtures/claude-event-fixtures.ts';

describe('ClaudeEventAdapter', () => {
let adapter: ClaudeEventAdapter;

beforeEach(() => {
    adapter = new ClaudeEventAdapter(createCallbacks());
    adapter.startTurn();
  });

describe('result', () => {
    it('should emit complete with usage on success', async () => {
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
        total_cost_usd: 0.05,
        modelUsage: {
          'claude-opus': { contextWindow: 200000 },
        },
        session_id: 'sess-1',
      }));

      const completeEvent = events.find(e => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      expect(completeEvent).toMatchObject({
        type: 'complete',
        usage: {
          outputTokens: 500,
          costUsd: 0.05,
          contextWindow: 200000,
        },
      });
    });

    it('does not accept an SDK result marked as an error despite its success subtype', async () => {
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'result', subtype: 'success', is_error: true,
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0,
        modelUsage: {}, session_id: 'sess-1',
      }));
      expect(events[0]).toMatchObject({ type: 'error', message: expect.stringContaining('OAuth session expired') });
    });

    it('marks a failed OAuth refresh as requiring re-authentication', async () => {
      for (const text of [
        'Failed to authenticate: OAuth session expired and could not be refreshed',
        'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
      ]) {
        const events = await adapter.adapt(recordedClaudeMessage({
          type: 'assistant', error: 'authentication_failed', session_id: 'sess-1',
          message: { content: [{ type: 'text', text }] },
        }));
        expect(events[0]).toMatchObject({ type: 'typed_error', error: {
          code: 'expired_oauth_token', canRetry: false,
          message: expect.stringContaining('Reconnect this account'),
        } });
      }
    });

    it('should emit error then complete on failure', async () => {
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'result',
        subtype: 'error',
        errors: ['Something went wrong', 'Another error'],
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        total_cost_usd: 0.01,
        modelUsage: {},
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Something went wrong, Another error',
      });
      expect(events[1]).toMatchObject({
        type: 'complete',
      });
    });

    it('should use lastAssistantUsage for accurate context display', async () => {
      // Send an assistant message first to capture per-message usage
      await adapter.adapt(recordedClaudeMessage({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'test' }],
          usage: {
            input_tokens: 800,
            cache_read_input_tokens: 400,
            cache_creation_input_tokens: 100,
          },
        },
        parent_tool_use_id: null,
        session_id: 'sess-1',
        isReplay: false,
      }));

      // Now send result — should use the per-message usage, not cumulative
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'result',
        subtype: 'success',
        usage: {
          input_tokens: 5000, // cumulative (should be ignored)
          output_tokens: 1000,
          cache_read_input_tokens: 2000,
          cache_creation_input_tokens: 500,
        },
        total_cost_usd: 0.10,
        modelUsage: {},
        session_id: 'sess-1',
      }));

      const completeEvent = events.find(e => e.type === 'complete');
      // Should use lastAssistantUsage (800+400+100=1300), not cumulative (5000+2000+500=7500)
      expect(completeEvent?.usage?.inputTokens).toBe(1300);
      expect(completeEvent?.usage?.cacheReadTokens).toBe(400);
      expect(completeEvent?.usage?.cacheCreationTokens).toBe(100);
    });
  });

describe('system', () => {
    it('should capture sdkTools from init message', async () => {
      await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'init',
        tools: ['Read', 'Write', 'Bash'],
        session_id: 'sess-1',
      }));

      expect(adapter.sdkTools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('should emit info for compact_boundary', async () => {
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'info',
        message: 'Compacted Conversation',
      });
    });

    it('should emit status for compacting', async () => {
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Compacting conversation...',
      });
    });

    it('should emit task_completed for task_notification', async () => {
      adapter.startTurn();
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-abc123',
        status: 'completed',
        output_file: '/tmp/task-output.txt',
        summary: 'Found 3 matching files',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-abc123',
        status: 'completed',
        outputFile: '/tmp/task-output.txt',
        summary: 'Found 3 matching files',
      });
    });

    it('should handle task_notification with failed status', async () => {
      adapter.startTurn();
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-xyz',
        status: 'failed',
        output_file: '/tmp/task-error.txt',
        summary: 'Task failed with error',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-xyz',
        status: 'failed',
      });
    });

    it('should handle task_notification with stopped status', async () => {
      adapter.startTurn();
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-stopped',
        status: 'stopped',
        summary: 'User stopped the task',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-stopped',
        status: 'stopped',
      });
    });

    it('should skip task_notification with missing task_id', async () => {
      adapter.startTurn();
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'task_notification',
        // task_id intentionally missing
        status: 'completed',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(0);
    });

    it('should default to completed for unknown task_notification status', async () => {
      adapter.startTurn();
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-unknown',
        status: 'some_future_status',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_completed',
        taskId: 'agent-unknown',
        status: 'completed', // defaults to completed for unknown statuses
      });
    });
  });

describe('auth_status', () => {
    it('should emit error for auth errors', async () => {
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'auth_status',
        error: 'token expired',
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Auth error: token expired. Try running /auth to re-authenticate.',
      });
    });

    it('should not emit events when no auth error', async () => {
      const events = await adapter.adapt(recordedClaudeMessage({
        type: 'auth_status',
        error: null,
        session_id: 'sess-1',
      }));

      expect(events).toHaveLength(0);
    });
  });
});

describe('buildWindowsSkillsDirError', () => {
  it('should detect Windows ENOENT skills directory error', () => {
    const result = buildWindowsSkillsDirError(
      "ENOENT: no such file or directory, scandir 'C:\\ProgramData\\ClaudeCode\\.claude\\skills'"
    );

    expect(result).not.toBeNull();
    expect(result!.type).toBe('typed_error');
    expect(result!.error.title).toBe('Windows Setup Required');
    expect(result!.error.message).toContain('C:\\ProgramData\\ClaudeCode\\.claude\\skills');
  });

  it('should return null for non-matching errors', () => {
    expect(buildWindowsSkillsDirError('Connection refused')).toBeNull();
    expect(buildWindowsSkillsDirError('ENOENT: no such file, /tmp/other')).toBeNull();
  });
});
