import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import {
  AutomaticRecoveryStalledError,
  DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS,
  advancePendingTurnRecovery,
  buildAutomaticTurnRecoveryPrompt,
  createPendingTurnRecovery,
  exhaustPendingTurnRecovery,
  resolveAutomaticRecoveryInactivityTimeoutMs,
  turnStillNeedsRecovery,
  withAutomaticRecoveryInactivityTimeout,
} from './turn-recovery.ts';

const message = (
  id: string,
  role: Message['role'],
  options: Partial<Message> = {},
): Message => ({ id, role, content: id, timestamp: 1, ...options });

describe('durable turn recovery', () => {
  it('marks a new turn before streaming and advances retries with a cause', () => {
    const pending = createPendingTurnRecovery('user-1', 10);
    expect(pending).toEqual({ userMessageId: 'user-1', startedAt: 10, attempts: 0 });
    expect(advancePendingTurnRecovery(pending, 'app_restart', 20)).toEqual({
      userMessageId: 'user-1',
      startedAt: 10,
      attempts: 1,
      lastAttemptAt: 20,
      lastCause: 'app_restart',
    });
  });

  it('recovers commentary/tool tails but never replays a terminal outcome', () => {
    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('commentary', 'assistant', { isIntermediate: true }),
      message('tool-1', 'tool'),
    ], 'user-1')).toBe(true);

    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('final', 'assistant'),
    ], 'user-1')).toBe(false);

    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('premature', 'assistant', {
        content: 'Le diagnostic est terminé. Je lance maintenant les tests.',
      }),
    ], 'user-1')).toBe(true);

    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('error', 'error'),
    ], 'user-1')).toBe(false);
  });

  it('bounds retries and records exhaustion durably', () => {
    const first = advancePendingTurnRecovery(createPendingTurnRecovery('user-1', 1), 'stream_ended', 2, 3)!;
    const second = advancePendingTurnRecovery(first, 'runtime_error', 3, 3)!;
    const third = advancePendingTurnRecovery(second, 'premature_final', 4, 3)!;
    expect(advancePendingTurnRecovery(third, 'runtime_error', 5, 3)).toBeNull();
    expect(exhaustPendingTurnRecovery(third, 6).exhaustedAt).toBe(6);
  });

  it('accepts an explicit workspace retry bound', () => {
    const first = advancePendingTurnRecovery(createPendingTurnRecovery('user-1', 1), 'stream_ended', 2, 2)!;
    const second = advancePendingTurnRecovery(first, 'runtime_error', 3, 2)!;
    expect(second.attempts).toBe(2);
    expect(advancePendingTurnRecovery(second, 'app_restart', 4, 2)).toBeNull();
  });

  it('continues while successful tool evidence advances and stops after two stagnant passes', () => {
    const first = advancePendingTurnRecovery(
      createPendingTurnRecovery('user-1', 1), 'premature_final', 2, 8, 'proof-a', 2,
    )!;
    const progressed = advancePendingTurnRecovery(first, 'premature_final', 3, 8, 'proof-b', 2)!;
    expect(progressed.stagnantAttempts).toBe(0);
    const stagnant = advancePendingTurnRecovery(progressed, 'premature_final', 4, 8, 'proof-b', 2)!;
    expect(stagnant.stagnantAttempts).toBe(1);
    expect(advancePendingTurnRecovery(stagnant, 'premature_final', 5, 8, 'proof-b', 2)).toBeNull();
  });

  it('forces recovery after a structural checkpoint even when assistant prose looks final', () => {
    expect(turnStillNeedsRecovery([
      message('user-1', 'user'),
      message('final', 'assistant'),
    ], 'user-1', true)).toBe(true);
  });

  it('builds a hidden nudge that requires side-effect verification', () => {
    const prompt = buildAutomaticTurnRecoveryPrompt(createPendingTurnRecovery('user-1', 1), 'app_restart');
    expect(prompt).toContain('original_user_message_id="user-1"');
    expect(prompt).toContain('Do not repeat an external mutation');
    expect(prompt).toContain('verify its state first');
  });

  it('makes premature-final recovery explicitly execute the remaining work', () => {
    const prompt = buildAutomaticTurnRecoveryPrompt(
      createPendingTurnRecovery('user-1', 1),
      'premature_final',
    );
    expect(prompt).toContain('announced more work');
    expect(prompt).toContain('Perform the remaining actions now');
    expect(prompt).toContain('Do not end with another promise');
    expect(prompt).toContain('materially different hypothesis');
    expect(prompt).toContain('test the safest viable correction or alternate route');
  });

  it('builds dedicated prompts for host checkpoints and evidence gates', () => {
    expect(buildAutomaticTurnRecoveryPrompt(
      createPendingTurnRecovery('user-1', 1), 'tool_checkpoint',
    )).toContain('tool-call budget reached a structural checkpoint');
    expect(buildAutomaticTurnRecoveryPrompt(
      createPendingTurnRecovery('user-1', 1), 'evidence_gate',
    )).toContain('gather the missing primary or official evidence');
  });

  it('uses a bounded configurable inactivity timeout', () => {
    expect(resolveAutomaticRecoveryInactivityTimeoutMs(undefined))
      .toBe(DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('invalid'))
      .toBe(DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('0')).toBe(0);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('5')).toBe(30_000);
    expect(resolveAutomaticRecoveryInactivityTimeoutMs('99999999')).toBe(1_800_000);
  });

  it('fails a stalled automatic recovery so SessionManager can recycle its runtime', async () => {
    const stalled: AsyncIterable<number> = {
      [Symbol.asyncIterator](): AsyncIterator<number> {
        return {
          next: () => new Promise<IteratorResult<number>>(() => {}),
        };
      },
    };

    let caught: unknown;
    try {
      for await (const _event of withAutomaticRecoveryInactivityTimeout(stalled, 10)) {
        // The source deliberately never emits.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AutomaticRecoveryStalledError);
  });
});
