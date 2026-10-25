import { beforeEach, describe, expect, it } from 'bun:test';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { collect, recordedPiEvent, eventErrorText, type RecordedPiEvent } from './fixtures/pi-event-fixtures.ts';

describe('PiEventAdapter native settlement', () => {
  let adapter: PiEventAdapter;
  const overflow = { role: 'assistant', stopReason: 'error',
    errorMessage: 'Codex error: The input exceeds the context window of this model.' } as const;
  const feed = (event: RecordedPiEvent) => collect(adapter.adaptEvent(recordedPiEvent(event)));
  const finish = (aborted = false) => feed({ type: 'agent_settled', aborted });
  const failOverflow = () => feed({ type: 'message_end', message: overflow });
  const errorText = (events: ReturnType<typeof collect>) => events.map(eventErrorText).join(' ');

  beforeEach(() => { adapter = new PiEventAdapter(); adapter.startTurn(); });

  it('reports compaction progress', () => {
    expect(feed({ type: 'compaction_start' }))
      .toEqual([{ type: 'status', message: 'Compacting context...' }]);
  });
  it('reports successful compaction without completing the turn', () => {
    expect(feed({ type: 'compaction_end', result: {}, aborted: false }))
      .toEqual([{ type: 'info', message: 'Compacted context to fit within limits' }]);
  });
  it('defers a failed compaction until the SDK has settled', () => {
    expect(feed({ type: 'compaction_end', result: null, aborted: false, errorMessage: 'Out of memory' })).toEqual([]);
    expect(errorText(finish())).toContain('Context compaction failed: Out of memory');
  });
  it('does not emit an error for an aborted compaction', () => {
    expect(feed({ type: 'compaction_end', result: null, aborted: true })).toEqual([]);
    expect(finish(true)).toEqual([{ type: 'complete' }]);
  });
  it('reports retry progress', () => {
    expect(feed({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3 }))
      .toEqual([{ type: 'status', message: 'Retrying (attempt 2/3)...' }]);
  });
  it('waits for native settlement after cancellation during retry backoff', () => {
    expect(feed({ type: 'auto_retry_end', success: false, finalError: 'Retry cancelled' })).toEqual([]);
    expect(finish(true)).toEqual([{ type: 'complete' }]);
  });
  it('keeps successful retries quiet', () => {
    expect(feed({ type: 'auto_retry_end', success: true })).toEqual([]);
  });
  it('does not convert queue updates into completion', () => {
    expect(feed({ type: 'queue_update', steering: ['Focus on tests'], followUp: ['Then summarize'] })).toEqual([]);
  });
  it('preserves recovered output and completes once after overflow recovery', () => {
    expect(failOverflow()).toEqual([]);
    expect(feed({ type: 'agent_end', willRetry: true })).toEqual([]);
    feed({ type: 'compaction_start' });
    feed({ type: 'compaction_end', result: {}, aborted: false, willRetry: true });
    const output = feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop',
      content: [{ type: 'text', text: 'Recovered answer' }] } });
    expect(output).toContainEqual(expect.objectContaining({ type: 'text_complete', text: 'Recovered answer' }));
    expect(feed({ type: 'agent_end', willRetry: false })).toEqual([]);
    expect(finish()).toEqual([{ type: 'complete' }]);
  });
  it('does not complete from a failed intermediate compaction', () => {
    failOverflow();
    expect(feed({ type: 'compaction_end', result: null, aborted: false,
      reason: 'overflow', errorMessage: 'Compaction failed', willRetry: false })).toEqual([]);
    const terminal = finish();
    expect(errorText(terminal)).toContain('Context is still too large');
    expect(terminal.filter(event => event.type === 'complete')).toHaveLength(1);
  });
  it('reports a skipped recovery only at the authoritative end', () => {
    failOverflow();
    expect(feed({ type: 'agent_end' })).toEqual([]);
    expect(errorText(finish())).toContain('Context is still too large');
  });
  it('does not lose a held error across repeated attempt ends', () => {
    failOverflow();
    expect(feed({ type: 'agent_end' })).toEqual([]);
    expect(feed({ type: 'agent_end' })).toEqual([]);
    expect(errorText(finish())).toContain('Context is still too large');
  });
  it('clears a superseded runtime error before accepting the next request', () => {
    failOverflow();
    adapter.resetRuntimeState();
    adapter.startTurn();
    expect(finish()).toEqual([{ type: 'complete' }]);
  });
  it('buffers exhausted retries until native settlement', () => {
    failOverflow();
    expect(feed({ type: 'auto_retry_end', success: false, finalError: overflow.errorMessage })).toEqual([]);
    expect(errorText(finish())).toContain('Context is still too large');
  });
  it('does not duplicate terminal errors or completion', () => {
    failOverflow();
    expect(finish().filter(event => event.type === 'complete')).toHaveLength(1);
    expect(finish()).toEqual([]);
  });
  it('preserves non-overflow provider error classification', () => {
    feed({ type: 'message_end', message: { role: 'assistant', stopReason: 'error',
      errorMessage: '429 Too many requests - rate limit exceeded' } });
    const terminal = finish();
    expect(terminal.some(event => event.type === 'typed_error' && event.error.code.includes('rate'))).toBe(true);
    expect(terminal.filter(event => event.type === 'complete')).toHaveLength(1);
  });
  it('retains unexpected SDK error details instead of masking them', () => {
    const errorMessage = 'TypeError: undefined is not an object (_autoCompactionAbortController.signal)';
    feed({ type: 'compaction_end', result: null, aborted: false, errorMessage });
    expect(errorText(finish())).toContain(errorMessage);
  });
});
