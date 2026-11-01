import { describe, expect, it } from 'bun:test';
import { compactSelectedModel } from './compact-selected-model';

describe('compaction preserves selected settings', () => {
  it('compacts with the active model without switching model or reasoning', async () => {
    const calls: string[] = [];
    const session = {
      model: { id: 'selected-model', provider: 'selected-provider' },
      thinkingLevel: 'high',
      async compact(instructions?: string) { calls.push(instructions ?? ''); return { summary: 'Preserved context', firstKeptEntryId: 'fixture-kept-entry', tokensBefore: 10 }; },
      async setModel() { throw new Error('Unexpected model switch'); },
      setThinkingLevel() { throw new Error('Unexpected reasoning switch'); },
    };
    expect(await compactSelectedModel(session, 'Preserve objective')).toEqual({ summary: 'Preserved context', firstKeptEntryId: 'fixture-kept-entry', tokensBefore: 10, compactionModel: 'selected-model' });
    expect(calls).toEqual(['Preserve objective']);
    expect(session.thinkingLevel).toBe('high');
  });

  it('returns the real failure and never substitutes another model', async () => {
    const failure = new Error('model not available');
    const session = { model: { id: 'selected' }, async compact() { throw failure; } };
    await expect(compactSelectedModel(session)).rejects.toBe(failure);
    await expect(compactSelectedModel({ model: undefined } as never)).rejects.toThrow('selected model is required');
  });
});
