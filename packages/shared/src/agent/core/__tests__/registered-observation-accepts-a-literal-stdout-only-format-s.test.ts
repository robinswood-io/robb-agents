import { describe, expect, it } from "bun:test";
import { isProvablyReadOnlyShellCommand } from "../registered-observation.ts";

describe('stdout-only printf admission', () => {
  it.each([
    "printf '%s\\n' '--- status ---'",
    "printf -- '-v is text\\n'",
  ])('accepts a literal stdout-only format: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(true);
  });

  it.each([
    'printf -v result PASS',
    'printf -vPATH /tmp/evil',
    "printf '%n' PATH",
    "printf '%10n' PATH",
    "printf '%hn' PATH",
    "printf '%lln' PATH",
    "printf '%zn' PATH",
    "printf '%1$hn' PATH",
  ])('rejects shell-variable assignment: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
  });
});
