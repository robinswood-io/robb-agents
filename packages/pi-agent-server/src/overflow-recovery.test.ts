import { describe, expect, it } from 'bun:test';
import {
  OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS,
  prepareMessagesForOverflowContinuation,
} from './overflow-recovery.ts';

describe('overflow recovery helpers', () => {
  it('removes only a trailing assistant error before continuation', () => {
    const user = { role: 'user', content: 'Continue the task' };
    const overflow = { role: 'assistant', stopReason: 'error', errorMessage: 'context_length_exceeded' };

    const result = prepareMessagesForOverflowContinuation([user, overflow]);

    expect(result).toEqual({ messages: [user], removedTrailingError: true });
  });

  it('preserves a successful assistant response and user/tool tails', () => {
    const successful = [{ role: 'assistant', stopReason: 'stop', content: 'Done' }];
    const userTail = [{ role: 'assistant', stopReason: 'error' }, { role: 'user', content: 'Retry' }];

    expect(prepareMessagesForOverflowContinuation(successful)).toEqual({
      messages: successful,
      removedTrailingError: false,
    });
    expect(prepareMessagesForOverflowContinuation(userTail)).toEqual({
      messages: userTail,
      removedTrailingError: false,
    });
  });

  it('asks the fallback summary to retain operational state and discard raw output', () => {
    expect(OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS).toContain('user goal');
    expect(OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS).toContain('exact file paths');
    expect(OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS).toContain('raw tool output');
  });
});
