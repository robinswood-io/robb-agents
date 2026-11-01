import { describe, expect, it } from "bun:test";
import { isObjectiveShellEvidenceCommand, isObjectiveShellObservationCommand, isReadOnlyRegisteredShellObservation, isRegisteredShellObservation } from "../registered-observation.ts";

describe('bounded standalone Node test evidence', () => {
  it.each([
    'node --test /tmp/reviewer/test-isolated.cjs',
    '/usr/bin/node --test packages/shared/src/agent/core/example.spec.js',
    'node --test ./verify-release.mjs',
    'node --test tests/release.js',
  ])('admits one literal test file without treating its code as read-only: %s', command => {
    expect(isObjectiveShellObservationCommand(command)).toBe(true);
    expect(isObjectiveShellEvidenceCommand(command)).toBe(true);
    expect(isRegisteredShellObservation(command)).toBe(false);
    expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
  });

  it.each([
    '/usr/local/bin/node --test /tmp/reviewer/test-isolated.cjs',
    'node --test',
    'node --test /tmp/test-one.cjs /tmp/test-two.cjs',
    'node --test --test-reporter=spec /tmp/test-isolated.cjs',
    'node --test /tmp/ordinary.cjs',
    'node --test /tmp/contest.cjs',
    'node --test /tmp/speculative.cjs',
    'node --test /tmp/test-isolated.txt',
    'node --test ../tests/test-isolated.cjs',
    'node --test ./tests/../test-isolated.cjs',
    'node --test "$TEST_FILE"',
    'node --test "$(touch /tmp/changed)"',
    'node --test /tmp/test-isolated.cjs >/dev/null',
    'node --test /tmp/test-isolated.cjs | cat',
    'node --test /tmp/test-isolated.cjs && printf PASS',
    'node --test /tmp/test-isolated.cjs; touch /tmp/changed',
    'node --test -e "console.log(1)"',
  ])('rejects widened Node execution: %s', command => {
    expect(isObjectiveShellObservationCommand(command)).toBe(false);
    expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
    expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
  });

  it('does not reclassify a generic Node validator as a standalone test command', () => {
    const command = 'node /tmp/reviewer/test-isolated.cjs';
    expect(isObjectiveShellObservationCommand(command)).toBe(false);
    expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
  });
});
