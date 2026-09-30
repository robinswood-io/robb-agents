import { describe, expect, it } from 'bun:test';
import { sessionWaitCursor, waitForSessionChange } from './session-wait';
import type { WaitSessionSnapshot } from '@craft-agent/session-tools-core';

const complete = (id: string, generation = 1): WaitSessionSnapshot => ({
  sessionId: id, state: 'idle', processingGeneration: generation, reason: 'complete',
  finalMessageId: `${id}-${generation}`, finalText: JSON.stringify({ verdict: 'PASS', generation }),
});

describe('completion waits', () => {
  it('returns a completed review with its whole receipt even if it finished before subscription', async () => {
    const item = { ...complete('reviewer'), finalText: 'x'.repeat(5_000) };
    const result = await waitForSessionChange({ snapshot: () => [item], timeoutMs: 60_000,
      subscribe: () => { throw new Error('completed work must not subscribe'); } });
    expect(result.outcome).toBe('completed');
    expect(result.sessions[0]?.finalText).toHaveLength(5_000);
  });

  it('ignores an already delivered sibling and waits for the unfinished child', async () => {
    const done = complete('first');
    let second: WaitSessionSnapshot = { sessionId: 'second', state: 'active', processingGeneration: 1 };
    let wake!: () => void;
    let removed = 0;
    const pending = waitForSessionChange({ snapshot: () => [done, second],
      previous: { first: sessionWaitCursor(done) }, timeoutMs: 500,
      subscribe: cb => { wake = cb; return () => { removed++; }; } });
    second = complete('second'); wake();
    const result = await pending;
    expect(result.outcome).toBe('completed');
    expect(result.sessions[0]).toMatchObject({ changed: false, finalMessageId: 'first-1' });
    expect(result.sessions[0]?.finalText).toBeUndefined();
    expect(result.sessions[1]?.finalText).toContain('PASS');
    expect(removed).toBe(1);
  });

  it('honors persisted cursors without interpreting them as proof', async () => {
    const done = complete('first');
    const result = await waitForSessionChange({ snapshot: () => [done],
      previous: { first: sessionWaitCursor(done) }, timeoutMs: 0, subscribe: () => () => {} });
    expect(result.outcome).toBe('timeout');
    expect(result.sessions[0]?.changed).toBe(false);
    expect(result.sessions[0]?.finalText).toBeUndefined();
  });

  it('returns a new generation and unregisters a synchronously completed subscription', async () => {
    const old = complete('child'); let item: WaitSessionSnapshot = { ...old, state: 'active' };
    let removed = 0;
    const result = await waitForSessionChange({ snapshot: () => [item], previous: { child: sessionWaitCursor(old) }, timeoutMs: 500,
      subscribe: wake => { item = complete('child', 2); wake(); return () => { removed++; }; } });
    expect(result.sessions[0]?.finalMessageId).toBe('child-2');
    expect(removed).toBe(1);
  });

  it('releases its listener on cancellation rather than leaving an agent waiting', async () => {
    const controller = new AbortController(); let removed = 0;
    const pending = waitForSessionChange({ snapshot: () => [{ sessionId: 'child', state: 'active' }], timeoutMs: 500,
      signal: controller.signal, subscribe: () => () => { removed++; } });
    controller.abort();
    expect((await pending).outcome).toBe('timeout');
    expect(removed).toBe(1);
  });
});
