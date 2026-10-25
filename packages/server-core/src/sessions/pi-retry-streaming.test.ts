import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { AgentEvent } from '@craft-agent/core/types';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import { SessionManager, createManagedSession } from './SessionManager.ts';

function harness() {
  const host = Object.create(SessionManager.prototype) as any;
  Object.defineProperty(host, 'runtimeState', { value: host, configurable: true });
  withSessionOperationsForTest(host);
  const events: SessionEvent[] = [];
  sessionRuntimeStateForTest(host).pendingDeltas = new Map();
  sessionRuntimeStateForTest(host).deltaFlushTimers = new Map();
  sessionRuntimeStateForTest(host).permissionDeniedToolUseIdsByGeneration = new WeakMap();
  sessionRuntimeStateForTest(host).permissionExpiryStopGenerations = new WeakMap();
  host.sendEvent = (event: SessionEvent) => events.push(event);
  const managed = createManagedSession({ id: 'retry-stream' }, {
    id: 'workspace', slug: 'workspace', name: 'QA', rootPath: '/unused-qa', createdAt: 1,
  });
  managed.processingGeneration = 1;
  return { host, managed, events, fire: (event: AgentEvent) => host.processEventImpl(managed, event, 1) };
}

describe('failed Pi stream boundaries', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  it('discards pending failed tokens without a late timer emission', async () => {
    const { host, managed, events, fire } = harness();
    await fire({ type: 'text_delta', text: 'FAILED', turnId: 'failed' });
    await fire({ type: 'text_discard', turnId: 'failed' });
    jest.advanceTimersByTime(100);
    expect(events).toEqual([{ type: 'text_discard', sessionId: managed.id, turnId: 'failed' }]);
    expect(managed.streamingText).toBe('');
    expect(sessionRuntimeStateForTest(host).pendingDeltas.size).toBe(0);
    expect(sessionRuntimeStateForTest(host).deltaFlushTimers.size).toBe(0);
  });

  it('preserves completed messages when already-flushed failed text is discarded', async () => {
    const { managed, events, fire } = harness();
    const completed = { id: 'previous', role: 'assistant' as const, content: 'Acquired result', timestamp: 1 };
    managed.messages.push(completed);
    await fire({ type: 'text_delta', text: 'FAILED', turnId: 'failed' });
    jest.advanceTimersByTime(100);
    await fire({ type: 'text_discard', turnId: 'failed' });
    expect(events.map(event => event.type)).toEqual(['text_delta', 'text_discard']);
    expect(managed.streamingText).toBe('');
    expect(managed.messages).toEqual([completed]);
  });

  it('does not let a stale discard erase a newer stream or its batch', async () => {
    const { managed, events, fire } = harness();
    await fire({ type: 'text_delta', text: 'KEEP', turnId: 'new' });
    await fire({ type: 'text_discard', turnId: 'old' });
    jest.advanceTimersByTime(100);
    expect(managed.streamingText).toBe('KEEP');
    expect(events).toContainEqual({ type: 'text_delta', sessionId: managed.id, delta: 'KEEP', turnId: 'new' });
  });

  it('never merges distinct stream identities in the same batching interval', async () => {
    const { events, fire } = harness();
    await fire({ type: 'text_delta', text: 'ONE', turnId: 'one' });
    await fire({ type: 'text_delta', text: 'TWO', turnId: 'two' });
    jest.advanceTimersByTime(100);
    expect(events.filter(event => event.type === 'text_delta')).toEqual([
      expect.objectContaining({ delta: 'ONE', turnId: 'one' }),
      expect.objectContaining({ delta: 'TWO', turnId: 'two' }),
    ]);
  });
});
