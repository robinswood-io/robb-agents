import { afterEach, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareUv, validateUvBinary } from '../prepare-uv.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(version = '0.10.6', executable = true): string {
  const directory = mkdtempSync(join(tmpdir(), 'robb-uv-package-'));
  scratch.push(directory);
  const binary = join(directory, 'uv');
  writeFileSync(binary, `#!/bin/sh\nprintf 'uv ${version} (fixture)\\n'\nexit 0\n${' '.repeat(1_000_000)}`);
  chmodSync(binary, executable ? 0o755 : 0o644);
  return binary;
}

it('requires a regular executable reporting the exact pinned native version', () => {
  const valid = fixture();
  expect(validateUvBinary(valid, 'darwin', '0.10.6', true)).toBe(true);
  expect(validateUvBinary(valid, 'darwin', '0.10.7', true)).toBe(false);
  expect(validateUvBinary(fixture('0.10.6', false), 'darwin', '0.10.6', true)).toBe(false);

  const link = `${valid}-link`;
  symlinkSync(valid, link);
  expect(validateUvBinary(link, 'darwin', '0.10.6', true)).toBe(false);
});

it('accepts fresh checksum-verified cross-target bytes without executing them', () => {
  const binary = fixture('not-native');
  expect(validateUvBinary(binary, 'linux', '0.10.6', false)).toBe(true);
  writeFileSync(binary, 'too small');
  expect(validateUvBinary(binary, 'linux', '0.10.6', false)).toBe(false);
});

it('removes an ignored cached artifact before the packaging download', async () => {
  const electronDir = mkdtempSync(join(tmpdir(), 'robb-uv-refresh-'));
  scratch.push(electronDir);
  // Keep the injected fixture cross-target on every CI host: the production
  // path validates downloaded native binaries by executing them.
  const targetPlatform = process.platform === 'linux' ? 'darwin' : 'linux';
  const target = join(electronDir, 'resources', 'bin', `${targetPlatform}-x64`, 'uv');
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, 'stale ignored artifact');

  const prepared = await prepareUv(targetPlatform, 'x64', {
    refresh: true,
    electronDir,
    rootDir: electronDir,
    download: async () => {
      expect(existsSync(target)).toBe(false);
      writeFileSync(target, `cross-target${' '.repeat(1_000_000)}`);
      chmodSync(target, 0o755);
    },
  });

  expect(prepared).toBe(target);
  expect(validateUvBinary(target, targetPlatform, '0.10.6', false)).toBe(true);
});
