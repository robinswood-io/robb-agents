import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateBashCommand } from '../src/agent/bash-validator.ts';
import type { CompiledBashPattern } from '../src/agent/mode-types.ts';

interface DefaultPermissions {
  version: string;
  allowedBashPatterns: Array<{ pattern: string; comment?: string }>;
}

const permissionsPath = resolve(import.meta.dir, '../../../apps/electron/resources/permissions/default.json');
const permissions = JSON.parse(readFileSync(permissionsPath, 'utf8')) as DefaultPermissions;
const patterns: CompiledBashPattern[] = permissions.allowedBashPatterns.map(entry => ({
  regex: new RegExp(entry.pattern),
  source: entry.pattern,
  comment: entry.comment,
}));
const SAFE_GIT = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';

describe('default Explore permissions for reviewer integrity checks', () => {
  it('requires both the hardened grammar and an applicable configured Git permission', () => {
    const command = `${SAFE_GIT} rev-parse HEAD`;
    const nonGitPatterns: CompiledBashPattern[] = [{
      regex: /^ls\b/,
      source: '^ls\\b',
    }];
    expect(validateBashCommand(command, []).allowed).toBe(false);
    expect(validateBashCommand(command, nonGitPatterns).allowed).toBe(false);
    expect(validateBashCommand(command, patterns).allowed).toBe(true);
  });

  it.each([
    'cmp -s /srv/workspace/orion/dist/app.js /srv/workspace/orion/dist/app.expected.js',
    'shasum -a 256 /srv/workspace/orion/dist/app.js',
    'cmp -s dist/app.js dist/app.expected.js && shasum -a 256 dist/app.js',
    `cd /srv/workspace/orion && printf '%s\\n' '--- revision ---' && ${SAFE_GIT} rev-parse HEAD`,
  ])('allows only the bounded static read: %s', command => {
    expect(validateBashCommand(command, patterns).allowed).toBe(true);
  });

  it.each([
    'bun run test:orion-contract',
    'bun run test:orion-contract --update',
    'cmp dist/app.js dist/app.expected.js',
    'cmp -s dist/app.js',
    'cmp -s dist/app.js ../outside.js',
    'cmp -s dist/*.js dist/app.expected.js',
    'cmp -s dist/app.js dist/app.expected.js && touch /tmp/changed',
    'shasum -a 1 dist/app.js',
    'shasum -a 256 -c SHA256SUMS.txt',
    'shasum -a 256 ../outside.js',
    'shasum -a 256 "$(touch /tmp/changed)"',
    'shasum -a 256 dist/app.js > checksum.txt',
    'printf -v result PASS',
    'printf -vPATH /tmp/evil',
    "printf '%n' PATH",
    "printf '%10n' PATH",
    "printf '%hn' PATH",
    "printf '%lln' PATH",
    "printf '%zn' PATH",
    "printf '%1$hn' PATH",
    "printf '%s\\n' changed > /tmp/result",
    'git status --short',
    `${SAFE_GIT} status --short`,
    `${SAFE_GIT} diff --check`,
    `${SAFE_GIT} show HEAD`,
    `${SAFE_GIT} log -p -n 1`,
    `${SAFE_GIT} grep -f /tmp/patterns`,
    `${SAFE_GIT} grep --file=/tmp/patterns needle`,
    `${SAFE_GIT} ls-files --exclude-from=/tmp/excludes`,
    '/tmp/git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager rev-parse HEAD',
    './git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager rev-parse HEAD',
    'Git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager rev-parse HEAD',
  ])('keeps unbounded, executable, or mutating shapes closed: %s', command => {
    expect(validateBashCommand(command, patterns).allowed).toBe(false);
  });
});
