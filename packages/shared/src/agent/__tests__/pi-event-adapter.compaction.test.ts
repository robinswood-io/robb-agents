import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent } from '@craft-agent/core/types';
import { collect, recordedPiEvent, eventErrorText } from './fixtures/pi-event-fixtures.ts';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';

describe('PiEventAdapter — compaction', () => {
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

describe('session events', () => {
    it('should emit status for compaction_start', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'compaction_start',
      })));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Compacting context...',
      });
    });

    it('should emit info for successful compaction_end', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'compaction_end',
        result: { /* compaction result */ },
        aborted: false,
      })));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'info',
        message: 'Compacted context to fit within limits',
      });
    });

    it('should emit error for failed compaction_end', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory',
      })));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Context compaction failed: Out of memory',
      });
    });

    it('should emit nothing for aborted compaction', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'compaction_end',
        result: null,
        aborted: true,
      })));

      expect(events).toHaveLength(0);
    });

    it('should emit status for auto_retry_start', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
      })));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Retrying (attempt 2/3)...',
      });
    });

    it('should terminate the queue for a retry cancelled during backoff', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'auto_retry_end',
        success: false,
        finalError: 'Max retries exceeded',
      })));

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Retry failed: Max retries exceeded',
      });
      expect(events[1]).toEqual({ type: 'complete' });
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
    });

    it('should emit nothing for successful auto_retry_end', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'auto_retry_end',
        success: true,
      })));

      expect(events).toHaveLength(0);
    });

    it('should emit nothing for queue_update', () => {
      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'queue_update',
        steering: ['Focus on tests'],
        followUp: ['Then summarize the diff'],
      })));

      expect(events).toHaveLength(0);
    });
  });

describe('overflow recovery', () => {
    const overflowMessage = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Your input exceeds the context window of this model. Please adjust your input and try again. (context_length_exceeded)',
    } as const;

    it('success path: holds queue open, surfaces recovered turn, completes once', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      // 1. Overflow message_end — adapter swallows the error.
      const errEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: overflowMessage,
      })));
      expect(errEvents).toHaveLength(0);

      // 2. Original agent_end — held, no complete yielded, queue stays open.
      const heldAgentEnd = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
      expect(heldAgentEnd).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true)).toBe(false);

      // 3. compaction_start — status surfaces.
      const startEvents = collect(adapter.adaptEvent(recordedPiEvent({ type: 'compaction_start' })));
      expect(startEvents).toMatchObject([{ type: 'status', message: 'Compacting context...' }]);

      // 4. compaction_end success — info surfaces, still no complete.
      const endEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'compaction_end',
        result: { /* compaction result */ },
        aborted: false,
      })));
      expect(endEvents).toMatchObject([{ type: 'info', message: 'Compacted context to fit within limits' }]);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);

      // 5. Recovered text + final agent_end — text_complete + complete arrive.
      const recoveredText = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Recovered answer' },
      })));
      expect(recoveredText).toMatchObject([{ type: 'text_complete', text: 'Recovered answer' }]);

      const finalAgentEnd = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
      expect(finalAgentEnd).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);

      // The original context_length_exceeded never reached the UI.
      const allYields = [...errEvents, ...heldAgentEnd, ...startEvents, ...endEvents, ...recoveredText, ...finalAgentEnd];
      const errorYields = allYields.filter(e => e.type === 'error' || e.type === 'typed_error');
      expect(errorYields).toHaveLength(0);
    });

    it('failure path: drains held overflow with friendly error + complete', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'compaction_start' })));

      const failureEvents = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory during summary',
      })));

      expect(failureEvents).toEqual([
        { type: 'error', message: 'Context compaction failed: Out of memory during summary' },
        { type: 'complete' },
      ]);
      // Queue should terminate even though the event wasn't agent_end.
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
      // Only one terminal complete — subsequent calls return false.
      expect(adapter.shouldCompleteQueue(false)).toBe(false);
    });

    it('skipped recovery: fallback timer drains held error after timeout', () => {
      jest.useFakeTimers();
      try {
        const enqueued: AgentEvent[] = [];
        let completed = false;
        adapter.setOverflowFallbackHandlers(
          (event) => enqueued.push(event),
          () => { completed = true; },
        );

        collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));

        // No compaction events arrive. Advance past the 5 s fallback timeout.
        jest.advanceTimersByTime(5_000);

        expect(enqueued).toEqual([{ type: 'error', message: overflowMessage.errorMessage }]);
        expect(completed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('skipped SDK recovery: requests one guarded fallback and keeps the queue open', async () => {
      jest.useFakeTimers();
      try {
        const enqueued: AgentEvent[] = [];
        let completed = false;
        let recoveryRequests = 0;
        adapter.setOverflowFallbackHandlers(
          (event) => enqueued.push(event),
          () => { completed = true; },
          () => { recoveryRequests += 1; },
        );

        collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));

        jest.advanceTimersByTime(5_000);
        await Promise.resolve();

        expect(recoveryRequests).toBe(1);
        expect(enqueued).toEqual([]);
        expect(completed).toBe(false);

        // The fallback's manual compaction starts before its second watchdog.
        const startEvents = collect(adapter.adaptEvent(recordedPiEvent({ type: 'compaction_start' })));
        const endEvents = collect(adapter.adaptEvent(recordedPiEvent({
          type: 'compaction_end',
          reason: 'manual',
          result: { summary: 'bounded handoff' },
          aborted: false,
          willRetry: false,
        })));
        expect(startEvents).toMatchObject([{ type: 'status', message: 'Compacting context...' }]);
        expect(endEvents).toMatchObject([{ type: 'info', message: 'Compacted context to fit within limits' }]);

        const recoveredText = collect(adapter.adaptEvent(recordedPiEvent({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'stop', content: 'Recovered by fallback' },
        })));
        const finalAgentEnd = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));

        expect(recoveredText).toMatchObject([{ type: 'text_complete', text: 'Recovered by fallback' }]);
        expect(finalAgentEnd).toMatchObject([{ type: 'complete' }]);
        expect(adapter.shouldCompleteQueue(true)).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('lost fallback command: stops after one request instead of hanging or looping', async () => {
      jest.useFakeTimers();
      try {
        const enqueued: AgentEvent[] = [];
        let completed = false;
        let recoveryRequests = 0;
        adapter.setOverflowFallbackHandlers(
          (event) => enqueued.push(event),
          () => { completed = true; },
          () => { recoveryRequests += 1; },
        );

        collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        jest.advanceTimersByTime(20_000);

        expect(recoveryRequests).toBe(1);
        expect(enqueued).toEqual([{
          type: 'error',
          message: expect.stringContaining('Start a new chat'),
        }]);
        expect(completed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('native retry exhaustion starts the guarded fallback without surfacing the provider error', async () => {
      jest.useFakeTimers();
      try {
        let recoveryRequests = 0;
        adapter.setOverflowFallbackHandlers(
          () => {},
          () => {},
          () => { recoveryRequests += 1; },
        );

        collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'compaction_start' })));
        collect(adapter.adaptEvent(recordedPiEvent({
          type: 'compaction_end',
          reason: 'overflow',
          result: { summary: 'first pass' },
          aborted: false,
          willRetry: true,
        })));

        // The SDK's recovered attempt also overflows.
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
        const exhaustedEvents = collect(adapter.adaptEvent(recordedPiEvent({
          type: 'compaction_end',
          reason: 'overflow',
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage: 'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context.',
        })));
        await Promise.resolve();

        expect(exhaustedEvents).toEqual([
          { type: 'status', message: 'Context limit reached; compacting and retrying...' },
        ]);
        expect(recoveryRequests).toBe(1);
        expect(adapter.shouldCompleteQueue(false)).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    it('fallback exhaustion replaces the raw Codex overflow with actionable guidance', async () => {
      jest.useFakeTimers();
      try {
        adapter.setOverflowFallbackHandlers(() => {}, () => {}, () => {});

        collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
        jest.advanceTimersByTime(5_000);
        await Promise.resolve();
        collect(adapter.adaptEvent(recordedPiEvent({ type: 'compaction_start' })));
        collect(adapter.adaptEvent(recordedPiEvent({
          type: 'compaction_end',
          reason: 'manual',
          result: { summary: 'fallback pass' },
          aborted: false,
          willRetry: false,
        })));

        const secondOverflow = collect(adapter.adaptEvent(recordedPiEvent({
          type: 'message_end',
          message: overflowMessage,
        })));
        const terminal = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
        const terminalText = terminal
          .map(eventErrorText)
          .join(' ');

        expect(secondOverflow).toEqual([]);
        expect(terminalText).toContain('Start a new chat');
        expect(terminalText).not.toContain('Your input exceeds');
        expect(terminal.some((event) => event.type === 'complete')).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('non-overflow regression: rate-limit error is emitted at terminal agent_end', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));

      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Rate limit exceeded; please try again in 30s',
        },
      })));

      expect(events).toHaveLength(0);

      const agentEndEvents = collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end', willRetry: false })));
      expect(agentEndEvents).toMatchObject([
        { type: 'typed_error', error: { code: 'rate_limited' } },
        { type: 'complete' },
      ]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('SDK race signature: friendly message instead of raw stack', () => {
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'turn_start' })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'message_end', message: overflowMessage })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'agent_end' })));
      collect(adapter.adaptEvent(recordedPiEvent({ type: 'compaction_start' })));

      const events = collect(adapter.adaptEvent(recordedPiEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: "Auto-compaction failed: undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')",
      })));

      expect(events).toEqual([
        { type: 'error', message: 'Auto-compaction hit a transient error. Try /compact manually.' },
        { type: 'complete' },
      ]);
      // The raw `_autoCompactionAbortController.signal` text is not in any yield.
      const allMessages = events.map((e: any) => e.message ?? '').join(' ');
      expect(allMessages).not.toMatch(/_autoCompactionAbortController/);
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
    });
  });
});
