import { afterEach, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const afterPack = require('../../apps/electron/scripts/afterPack.cjs') as {
  verifyPackagedUvMatchesStaged: (
    context: { arch: string | number; packager: { projectDir: string } },
    resourcesDir: string,
  ) => void;
};

const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(payload = 'checksum-verified uv payload') {
  const root = mkdtempSync(join(tmpdir(), 'robb-after-pack-uv-'));
  scratch.push(root);
  const projectDir = join(root, 'project');
  const resourcesDir = join(root, 'output', 'Robb Agents.app', 'Contents', 'Resources');
  const stagedUv = join(projectDir, 'resources', 'bin', 'darwin-arm64', 'uv');
  const packagedUv = join(resourcesDir, 'app', 'resources', 'bin', 'darwin-arm64', 'uv');
  mkdirSync(join(stagedUv, '..'), { recursive: true });
  mkdirSync(join(packagedUv, '..'), { recursive: true });
  writeFileSync(stagedUv, payload);
  writeFileSync(packagedUv, payload);
  chmodSync(stagedUv, 0o755);
  chmodSync(packagedUv, 0o755);
  return { context: { arch: 3, packager: { projectDir } }, resourcesDir, packagedUv };
}

it('accepts an exact uv copy before electron-builder signs nested binaries', () => {
  const { context, resourcesDir } = fixture();
  expect(() => afterPack.verifyPackagedUvMatchesStaged(context, resourcesDir)).not.toThrow();
});

it('fails closed when the packaged uv payload differs before signing', () => {
  const { context, resourcesDir, packagedUv } = fixture();
  writeFileSync(packagedUv, 'mutated uv payload');
  chmodSync(packagedUv, 0o755);
  expect(() => afterPack.verifyPackagedUvMatchesStaged(context, resourcesDir)).toThrow(
    'Packaged uv runtime differs from the checksum-verified staged binary',
  );
});
