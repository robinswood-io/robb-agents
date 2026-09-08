import { describe, expect, test } from 'bun:test';
import { shouldAllowToolInMode } from '../mode-manager';
describe('safe-mode unknown tool authorization', () => {
  test('denies unclassified tool names rather than guessing their effects', () => {
    expect(shouldAllowToolInMode('UnclassifiedMutationTool', {}, 'safe').allowed).toBe(false);
  });
  test('preserves the explicit audited read-only builtins', () => {
    for (const name of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TaskOutput']) {
      expect(shouldAllowToolInMode(name, {}, 'safe').allowed).toBe(true);
    }
  });
  test('preserves Ask and owner-authorized Allow All semantics', () => {
    for (const mode of ['ask', 'allow-all'] as const) {
      expect(shouldAllowToolInMode('UnclassifiedMutationTool', {}, mode).allowed).toBe(true);
    }
  });
});
