import { expect, it } from 'bun:test';
import { isValidProviderAuthCombination } from '../llm-connections/auth-policy.ts';

it('rejects invalid persisted provider/auth values without following the object prototype', () => {
  for (const provider of ['toString', 'constructor', '__proto__', 'unknown-provider']) {
    expect(isValidProviderAuthCombination(provider, 'oauth')).toBe(false);
  }
  expect(isValidProviderAuthCombination('pi', 'unknown-auth')).toBe(false);
  expect(isValidProviderAuthCombination('pi', 'oauth')).toBe(true);
  expect(isValidProviderAuthCombination('pi_compat', 'none')).toBe(true);
});
