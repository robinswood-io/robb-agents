import { describe, expect, it } from 'bun:test';
import {
  OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS,
  prepareMessagesForOverflowContinuation,
  recoverContextOverflow,
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
    expect(OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS).toContain('pending approvals');
    expect(OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS).toContain('do not invent details');
  });

  it('compacts before continuation, retains tool receipts, and waits for the resumed run', async () => {
    const user = { role: 'user', content: [{ type: 'image', data: 'original-attachment' }] };
    const receipt = { role: 'toolResult', toolCallId: 'already-executed', content: 'verified effect' };
    const overflow = { role: 'assistant', stopReason: 'error' };
    const state = { messages: [user, receipt, overflow] };
    const calls: string[] = [];
    let release!: () => void;
    const continuing = new Promise<void>(resolve => { release = resolve; });
    let continued!: () => void;
    const started = new Promise<void>(resolve => { continued = resolve; });
    let finished = false;
    const recovery = recoverContextOverflow({
      waitForIdle: async () => { calls.push('idle'); },
      compact: async instructions => {
        expect(instructions).toBe(OVERFLOW_RECOVERY_COMPACTION_INSTRUCTIONS);
        calls.push('compact');
      },
      agent: { state, continue: async () => {
        calls.push('continue');
        expect(state.messages).toEqual([user, receipt]);
        expect(state.messages[0]).toBe(user);
        expect(state.messages[1]).toBe(receipt);
        continued();
        await continuing;
      } },
    }).then(() => { finished = true; });
    await started;
    expect(finished).toBe(false);
    expect(calls).toEqual(['idle', 'compact', 'continue']);
    release();
    await recovery;
    expect(calls).toEqual(['idle', 'compact', 'continue', 'idle']);
    expect(finished).toBe(true);
  });

  it('does not continue or change the transcript when compaction fails', async () => {
    const messages = [{ role: 'user' }, { role: 'assistant', stopReason: 'error' }];
    let resumed = false;
    const state = { messages };
    await expect(recoverContextOverflow({
      waitForIdle: async () => {},
      compact: async () => { throw new Error('summary unavailable'); },
      agent: { state, continue: async () => { resumed = true; } },
    })).rejects.toThrow('summary unavailable');
    expect(resumed).toBe(false);
    expect(state.messages).toBe(messages);
  });
});
