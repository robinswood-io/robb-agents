import { describe, expect, it } from "bun:test";
import { inspectReadOnlyReviewCommand } from "../../bash-validator.ts";
import { isProvablyReadOnlyShellCommand } from "../registered-observation.ts";
import { safeGit } from "./testing/registered-observation-fixture.ts";

describe('bounded reviewer file integrity checks', () => {
  const target = '/srv/workspace/orion';

  it('shares the exact hardened Git grammar with objective observations', () => {
    expect(inspectReadOnlyReviewCommand(
      `${safeGit} -C ${target} rev-parse HEAD`, target,
    )).toEqual({ safe: true, observesTarget: true, revisionProbe: true });
    expect(inspectReadOnlyReviewCommand(
      `${safeGit} branch --show-current`, target, target,
    )).toEqual({ safe: true, observesTarget: true, revisionProbe: false });
    expect(inspectReadOnlyReviewCommand(
      `${safeGit} grep -n bridge_unavailable -- packages`, target, target,
    )).toEqual({ safe: true, observesTarget: true, revisionProbe: false });
  });

  it.each([
    'git rev-parse HEAD',
    `git -C ${target} --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager rev-parse HEAD`,
    `${safeGit} -C ${target} grep --open-files-in-page=/usr/bin/true x`,
    `${safeGit} -C ${target} grep --ext-gr x`,
    `${safeGit} -C ${target} grep -f /tmp/patterns`,
    `${safeGit} -C ${target} grep --file=/tmp/patterns x`,
    `${safeGit} -C ${target} ls-files --exclude-from=/tmp/excludes`,
    `${safeGit} -C ${target} status --short`,
    `${safeGit} -C ${target} diff --check`,
    `${safeGit} -C ${target} show HEAD`,
    `${safeGit} -C ${target} log -p -n 1`,
    `/tmp/git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager -C ${target} rev-parse HEAD`,
    `./git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager -C ${target} rev-parse HEAD`,
    `Git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager -C ${target} rev-parse HEAD`,
    `${safeGit} -C ${target} log --pretty=format:%G? -1`,
    `git --no-optional-loc -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager -C ${target} rev-parse HEAD`,
    `git --no-optional-locks -c core.fsmon=false -c core.hooksPath=/dev/null --no-pager -C ${target} rev-parse HEAD`,
    `git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --paginate -C ${target} rev-parse HEAD`,
  ])('rejects an unhardened, helper-capable or abbreviated reviewer Git probe: %s', command => {
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });

  it.each([
    'cmp -s dist/app.js dist/app.expected.js',
    'shasum -a 256 dist/app.js',
  ])('accepts a static target-bound check: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(true);
    expect(inspectReadOnlyReviewCommand(command, target, target)).toEqual({
      safe: true,
      observesTarget: true,
      revisionProbe: false,
    });
  });

  it.each([
    'cat app.ts',
    'head -n 20 app.ts',
    'tail --lines=20 app.ts',
    'ls -la .',
    'stat app.ts',
    'wc -l app.ts',
    'diff -u app.ts app.expected.ts',
  ])('accepts a closed target-bound direct reader: %s', command => {
    expect(inspectReadOnlyReviewCommand(command, target, target)).toEqual({
      safe: true,
      observesTarget: true,
      revisionProbe: false,
    });
  });

  it.each([
    'diff --from-file=/etc/passwd /srv/workspace/orion/app.ts',
    'diff --from-file /etc/passwd /srv/workspace/orion/app.ts',
    'diff --to-file=/etc/passwd /srv/workspace/orion/app.ts',
    'diff --to-file /etc/passwd /srv/workspace/orion/app.ts',
    'diff --exclude-from=/etc/passwd /srv/workspace/orion/app.ts',
    'diff --exclude-from /etc/passwd /srv/workspace/orion/app.ts',
    'wc --files0-from=/etc/passwd /srv/workspace/orion/app.ts',
    'wc --files0-from /etc/passwd /srv/workspace/orion/app.ts',
    'tail -F /srv/workspace/orion/app.ts',
    'tail --follow /srv/workspace/orion/app.ts',
    'tail --fol /srv/workspace/orion/app.ts',
  ])('rejects direct-reader options that add an external file or follow mode: %s', command => {
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });

  it.each([
    'cmp dist/app.js dist/app.expected.js',
    'cmp -s dist/app.js',
    'cmp -s dist/app.js ../outside.js',
    'cmp -s dist/*.js dist/app.expected.js',
    'shasum -a 1 dist/app.js',
    'shasum -a 256 -c SHA256SUMS.txt',
    'shasum -a 256 dist/app.js extra.js',
    'shasum -a 256 ../outside.js',
    'shasum -a 256 "$(touch /tmp/changed)"',
    'shasum -a 256 dist/app.js > checksum.txt',
  ])('rejects an unbounded integrity command: %s', command => {
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });

  it('keeps package scripts closed even when their name sounds like a test', () => {
    const command = 'bun run test:orion-contract';
    expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    expect(inspectReadOnlyReviewCommand(command, target, target).safe).toBe(false);
  });
});
