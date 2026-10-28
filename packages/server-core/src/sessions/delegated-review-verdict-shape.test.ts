import { expect, it } from 'bun:test';
import { validateDelegatedReviewCompletion } from './delegated-review-outcome.ts';
import { multiTargetHostFixture } from './testing/delegated-review-outcome-fixture.ts';

it.each([
  { verdict: ['PASS'] },
  { verdict: ['FAIL'] },
  { verdict: { value: 'PASS' } },
  { verdict: true },
  { verdict: 1 },
])('refuses a coerced review verdict without changing the mission: %j', ({ verdict }) => {
  const fixture = multiTargetHostFixture();
  expect(validateDelegatedReviewCompletion(fixture)?.valid).toBe(true);
  fixture.finalMessage.content = JSON.stringify({ ...fixture.receipt, verdict });
  const before = structuredClone(fixture);
  expect(validateDelegatedReviewCompletion(fixture)).toMatchObject({ valid: false, state: 'continue' });
  expect(fixture).toEqual(before);
});
