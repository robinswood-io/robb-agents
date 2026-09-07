import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import { demoteLatestCheckpointAssistant, latestFinalAssistantId } from './tool-checkpoint-visibility.ts';

describe('tool checkpoint visibility', () => {
  it('demotes only the latest provider final after the active objective', () => {
    const messages: Message[] = [
      { id: 'old-final', role: 'assistant', content: 'Ancien résultat', timestamp: 1 },
      { id: 'u1', role: 'user', content: 'Mission', timestamp: 2 },
      { id: 'progress', role: 'assistant', content: 'Progression', timestamp: 3, isIntermediate: true },
      { id: 'checkpoint', role: 'assistant', content: 'Je dois poursuivre.', timestamp: 4 },
    ];
    expect(demoteLatestCheckpointAssistant(messages, 'u1')?.id).toBe('checkpoint');
    expect(messages[3]?.isIntermediate).toBe(true);
    expect(latestFinalAssistantId(messages)).toBe('old-final');
  });

  it('does nothing without a matching objective or final response', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'Mission', timestamp: 1 },
      { id: 'progress', role: 'assistant', content: 'Progression', timestamp: 2, isIntermediate: true },
    ];
    expect(demoteLatestCheckpointAssistant(messages, 'missing')).toBeUndefined();
    expect(demoteLatestCheckpointAssistant(messages, 'u1')).toBeUndefined();
  });
});
