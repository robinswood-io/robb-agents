import { describe, expect, it } from "bun:test";
import { objectiveShellExitZeroProvesSuccess } from "../registered-observation.ts";

describe('synthetic shell success projection', () => {
  it('requires curl HTTP failure semantics while retaining non-HTTP validators', () => {
    expect(objectiveShellExitZeroProvesSuccess('curl --silent https://example.com/health')).toBe(false);
    expect(objectiveShellExitZeroProvesSuccess('curl -sSf https://example.com/health')).toBe(true);
    expect(objectiveShellExitZeroProvesSuccess('cd /srv/app && curl --fail --silent https://example.com/health')).toBe(true);
    expect(objectiveShellExitZeroProvesSuccess('python3 /tmp/verify_release.py')).toBe(true);
  });
});
