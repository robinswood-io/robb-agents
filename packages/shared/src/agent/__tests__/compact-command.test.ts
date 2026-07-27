import { describe, expect, test } from 'bun:test';
import { parseCompactCommand } from '../compact-command.ts';

describe('parseCompactCommand', () => {
  test('recognizes the command with or without instructions', () => {
    expect(parseCompactCommand('/compact')).toEqual({});
    expect(parseCompactCommand('/COMPACT   preserve decisions')).toEqual({
      customInstructions: 'preserve decisions',
    });
    expect(parseCompactCommand('/compact\nkeep the latest plan')).toEqual({
      customInstructions: 'keep the latest plan',
    });
  });

  test('rejects prefixes and unrelated commands', () => {
    expect(parseCompactCommand('/compaction')).toBeNull();
    expect(parseCompactCommand('/compact-now')).toBeNull();
    expect(parseCompactCommand('compact')).toBeNull();
  });
});
