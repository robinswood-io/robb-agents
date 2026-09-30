import { describe, expect, test } from 'bun:test';
import {
  appendCoalescedInternalMessage,
  selectInternalMessageCoalesceTarget,
  type InternalQueuedMessage,
} from './internal-message-coalescing.ts';

const queued = (senderSessionId?: string): InternalQueuedMessage => ({
  message: `message-${senderSessionId ?? 'user'}`,
  options: senderSessionId
    ? { internalOrigin: { kind: 'agent-message', senderSessionId } }
    : undefined,
});

describe('internal agent message coalescing', () => {
  test('coalesces consecutive updates from the same sender', () => {
    const queue = [queued('agent-a'), queued('agent-b'), queued('agent-a')];
    expect(selectInternalMessageCoalesceTarget(queue, 'agent-a', 8)).toBe(queue[2]);
  });

  test('coalesces into an internal item only after the queue cap', () => {
    const belowCap = [queued(), queued('agent-a')];
    expect(selectInternalMessageCoalesceTarget(belowCap, 'agent-c', 8)).toBeUndefined();

    const atCap = Array.from({ length: 8 }, (_, index) => queued(index === 2 ? 'agent-a' : undefined));
    expect(selectInternalMessageCoalesceTarget(atCap, 'agent-c', 8)).toBe(atCap[2]);
  });

  test('preserves both updates in one deterministic message', () => {
    const target = queued('agent-a');
    appendCoalescedInternalMessage(target, 'second');
    expect(target.message).toContain('message-agent-a');
    expect(target.message).toContain('[Coalesced update]\nsecond');
  });
});
