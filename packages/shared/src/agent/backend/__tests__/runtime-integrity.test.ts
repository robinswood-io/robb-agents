import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createRuntimeIntegrityManifest,
  parseRuntimeIntegrityManifest,
  serializeRuntimeIntegrityManifest,
  verifyRuntimeIntegrityManifest,
} from '../internal/runtime-integrity.ts';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'runtime-integrity-'));
  roots.push(root);
  return root;
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('external runtime integrity manifest', () => {
  it('is deterministic and verifies exact packaged bytes', () => {
    const root = temporaryRoot();
    const first = join(root, 'sources', 'first.js');
    const second = join(root, 'sources', 'second.cjs');
    write(first, 'export const first = 1;\n');
    write(second, 'module.exports = 2;\n');

    const left = createRuntimeIntegrityManifest([
      { path: 'app/runtime/second.cjs', sourcePath: second },
      { path: 'app/runtime/first.js', sourcePath: first },
    ]);
    const right = createRuntimeIntegrityManifest([
      { path: 'app/runtime/first.js', sourcePath: first },
      { path: 'app/runtime/second.cjs', sourcePath: second },
    ]);
    expect(serializeRuntimeIntegrityManifest(left)).toBe(serializeRuntimeIntegrityManifest(right));
    expect(left.entries.map((entry) => entry.path)).toEqual([
      'app/runtime/first.js',
      'app/runtime/second.cjs',
    ]);

    write(join(root, 'app', 'runtime', 'first.js'), 'export const first = 1;\n');
    write(join(root, 'app', 'runtime', 'second.cjs'), 'module.exports = 2;\n');
    expect(verifyRuntimeIntegrityManifest(root, left)).toHaveLength(2);
  });

  it('fails closed on missing, modified, duplicate, future, or escaping entries', () => {
    const root = temporaryRoot();
    const source = join(root, 'source.js');
    write(source, 'trusted\n');
    const manifest = createRuntimeIntegrityManifest([
      { path: 'app/runtime.js', sourcePath: source },
    ]);

    expect(() => verifyRuntimeIntegrityManifest(
      root,
      manifest,
      ['app/runtime.js', 'app/required-but-omitted.js'],
    )).toThrow('absent from protected manifest');
    expect(() => verifyRuntimeIntegrityManifest(root, manifest)).toThrow('is missing');
    write(join(root, 'app', 'runtime.js'), 'tampered\n');
    expect(() => verifyRuntimeIntegrityManifest(root, manifest)).toThrow(/(size|SHA-256) mismatch/);
    expect(() => parseRuntimeIntegrityManifest({ ...manifest, schemaVersion: 2 })).toThrow('Unsupported');
    expect(() => parseRuntimeIntegrityManifest({
      ...manifest,
      entries: [manifest.entries[0], manifest.entries[0]],
    })).toThrow('unique and sorted');
    expect(() => parseRuntimeIntegrityManifest({
      ...manifest,
      entries: [{ ...manifest.entries[0], path: '../runtime.js' }],
    })).toThrow('escapes its root');
  });
});
