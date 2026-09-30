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

  it('rejects waiting on the current session', async () => {
    const ctx = {
      sessionId: 'parent',
      waitForSessions: async () => ({ outcome: 'timeout' as const, sessions: [] }),
    } as unknown as SessionToolContext;

    const result = await handleWaitSessions(ctx, { sessionIds: ['parent'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('deadlock');
  });
});
