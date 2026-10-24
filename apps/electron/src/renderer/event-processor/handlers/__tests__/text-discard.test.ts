import { describe, expect, it } from 'bun:test';
import { processEvent } from '../../processor';
import type { SessionState } from '../../types';

function state(messages: any[] = []): SessionState {
  return { session: { id: 'qa', messages, lastMessageAt: 1, isProcessing: true } as any, streaming: null };
}

describe('failed stream discard in the renderer', () => {
  it('removes the failed draft and keeps acquired work before displaying the recovered answer', () => {
    const complete = { id: 'acquired', role: 'assistant' as const, content: 'ACQUIRED', timestamp: 1, turnId: 'previous' };
    let current = processEvent(state([complete]), { type: 'text_delta', sessionId: 'qa', delta: 'FAILED', turnId: 'bad' }).state;
    current = processEvent(current, { type: 'text_discard', sessionId: 'qa', turnId: 'bad' }).state;
    expect(current.session.messages).toEqual([complete]);
    expect(current.streaming).toBeNull();
    current = processEvent(current, { type: 'text_delta', sessionId: 'qa', delta: 'RECOVERED', turnId: 'good' }).state;
    current = processEvent(current, { type: 'text_complete', sessionId: 'qa', text: 'RECOVERED', turnId: 'good', messageId: 'final' }).state;
    expect(current.session.messages.map(message => message.content)).toEqual(['ACQUIRED', 'RECOVERED']);
    expect(current.session.messages.at(-1)?.isStreaming).toBe(false);
  });

  it('keeps a newer partial and a completed message on a stale discard', () => {
    const complete = { id: 'complete', role: 'assistant' as const, content: 'DONE', timestamp: 1, turnId: 'old' };
    const current = processEvent(state([complete]), { type: 'text_delta', sessionId: 'qa', delta: 'KEEP', turnId: 'new' }).state;
    const discarded = processEvent(current, { type: 'text_discard', sessionId: 'qa', turnId: 'old' }).state;
    expect(discarded.session.messages).toEqual(current.session.messages);
    expect(discarded.streaming?.content).toBe('KEEP');
  });
});
