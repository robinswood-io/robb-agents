import { describe, expect, it } from 'bun:test';
import { isContextOverflow } from '@earendil-works/pi-ai/compat';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  INTRA_TURN_CONTEXT_CHECKPOINT_ERROR,
  estimateIntraTurnContextTokens,
  needsIntraTurnContextCheckpoint,
} from './intra-turn-context-guard.ts';

const text = (value: string): AgentMessage => ({
  role: 'user', content: [{ type: 'text', text: value }], timestamp: 1,
});

describe('Pi intra-turn context checkpoint', () => {
  it('checks accumulated messages before the next model call', () => {
    const first = text('a'.repeat(2_000));
    const second = text('b'.repeat(2_000));
    const limit = estimateIntraTurnContextTokens([first]) + 1;
    expect(needsIntraTurnContextCheckpoint([first], limit)).toBe(false);
    expect(needsIntraTurnContextCheckpoint([first, second], limit)).toBe(true);
    expect(needsIntraTurnContextCheckpoint([first, second], 0)).toBe(false);
  });

  it('uses an error recognized by Pi’s bounded compact-and-continue path', () => {
    expect(isContextOverflow({
      role: 'assistant', stopReason: 'error', errorMessage: INTRA_TURN_CONTEXT_CHECKPOINT_ERROR,
    } as never, 200_000)).toBe(true);
  });
});
