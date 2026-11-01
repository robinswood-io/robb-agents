import { describe, expect, it } from 'bun:test';
import { parseRecoveryJournalObservation } from './recovery-journal-observation.ts';

describe('raw recovery journal observations', () => {
  it('preserves raw values and unknown fields without migrations or defaults', () => {
    const original = {
      schemaVersion: 1, id: 'session', permissionMode: 'legacy-value',
      unknownField: { zero: 0, off: false, empty: null },
      pendingTurnRecovery: { attempts: 0, extra: false,
        recoveryDispatch: { id: 'dispatch', attempt: 1, phase: 'started', extra: null } },
    };
    const parsed = parseRecoveryJournalObservation(JSON.stringify(original));
    expect<unknown>(parsed).toEqual(original);
    expect(Object.hasOwn(parsed, 'sdkSessionId')).toBe(false);
    expect(Object.hasOwn(parsed, 'hidden')).toBe(false);
  });

  it('preserves the exact hidden message content and origin', () => {
    const original = { id: 'message', type: 'user', hidden: true,
      content: '<automatic_turn_recovery />', internalOrigin: { kind: 'browser-fallback' } };
    expect(parseRecoveryJournalObservation(JSON.stringify(original))).toEqual(original);
  });

  for (const value of [null, [], 1, { id: 'bad', type: 'user' },
    { id: 'bad', type: 'user', content: 'text', hidden: 'true' },
    { schemaVersion: 1, id: 'bad', pendingTurnRecovery: { recoveryDispatch: { id: 'x', attempt: '1', phase: 'started' } } }]) {
    it(`rejects malformed persisted observations: ${JSON.stringify(value)}`, () => {
      expect(() => parseRecoveryJournalObservation(JSON.stringify(value))).toThrow();
    });
  }
});
