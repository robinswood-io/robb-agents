import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { handleWaitSessions } from './wait-sessions.ts';

describe('handleWaitSessions', () => {
  it('returns the structured host snapshot', async () => {
    const ctx = {
      sessionId: 'parent',
      waitForSessions: async (sessionIds: string[], timeoutMs: number) => ({
        outcome: 'completed' as const,
        sessions: sessionIds.map((sessionId) => ({
          sessionId,
          state: 'idle' as const,
          reason: 'complete' as const,
        })),
        timeoutMs,
      }),
    } as unknown as SessionToolContext;

    const result = await handleWaitSessions(ctx, { sessionIds: ['child'], timeoutMs: 250 });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      outcome: 'completed',
      sessions: [{ sessionId: 'child', state: 'idle', reason: 'complete' }],
    });
  });

  it('forwards explicit cursors and delegates the 60 second default to the host', async () => {
    let received: unknown[] = [];
    const ctx = { sessionId: 'parent', waitForSessions: async (...args: unknown[]) => {
      received = args; return { outcome: 'timeout' as const, sessions: [] };
    } } as unknown as SessionToolContext;
    const afterCursors = { child: 'a'.repeat(64) };
    await handleWaitSessions(ctx, { sessionIds: ['child'], afterCursors });
    expect(received).toEqual([['child'], undefined, afterCursors, undefined, undefined]);
    const invalid = await handleWaitSessions(ctx, { sessionIds: ['child'], afterCursors: { foreign: 'a'.repeat(64) } });
    expect(invalid.isError).toBe(true);
  });

  it('rejects waiting on the current session', async () => {
    const ctx = {
      sessionId: 'parent',
      waitForSessions: async () => ({ outcome: 'timeout' as const, sessions: [] }),
    } as unknown as SessionToolContext;

    const result = await handleWaitSessions(ctx, { sessionIds: ['parent'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('deadlock');
  });

  it('delegates mode:all once so the host owns cursor advances and the one-shot capability', async () => {
    const capability = 'c'.repeat(32);
    const calls: unknown[][] = [];
    const ctx = {
      sessionId: 'parent', waitForSessions: async (...args: unknown[]) => {
        calls.push(args);
        return {
          outcome: 'completed' as const,
          mode: 'all' as const,
          sessions: [
            { sessionId: 'a', state: 'idle' as const, reason: 'complete' as const, finalText: 'A', cursor: 'a'.repeat(64) },
            { sessionId: 'b', state: 'idle' as const, reason: 'complete' as const, finalText: 'B', cursor: 'c'.repeat(64) },
          ],
        };
      },
    } as unknown as SessionToolContext;

    const result = await handleWaitSessions(ctx, {
      sessionIds: ['a', 'b'],
      timeoutMs: 1_000,
      mode: 'all',
      _hostTerminalReconciliationCapability: capability,
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      outcome: 'completed',
      mode: 'all',
      sessions: [
        { sessionId: 'a', finalText: 'A' },
        { sessionId: 'b', finalText: 'B' },
      ],
    });
    expect(calls).toEqual([[['a', 'b'], 1_000, undefined, capability, 'all']]);
  });

  it('preserves explicit mode:first in the exact host-authorized input', async () => {
    const capability = 'd'.repeat(32);
    let received: unknown[] = [];
    const ctx = { sessionId: 'parent', waitForSessions: async (...args: unknown[]) => {
      received = args;
      return { outcome: 'timeout' as const, sessions: [] };
    } } as unknown as SessionToolContext;
    await handleWaitSessions(ctx, {
      sessionIds: ['child'],
      timeoutMs: 0,
      mode: 'first',
      _hostTerminalReconciliationCapability: capability,
    });
    expect(received).toEqual([['child'], 0, undefined, capability, 'first']);
  });
});
