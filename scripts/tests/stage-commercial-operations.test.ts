import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageCommercialOperations } from '../stage-commercial-operations.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(channel: 'development' | 'production') {
  const root = mkdtempSync(join(tmpdir(), 'robb-commercial-stage-'));
  roots.push(root);
  const source = join(root, 'source');
  const repository = join(root, 'repository');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.js'), 'export const edition = "commercial";');
  writeFileSync(join(source, 'build-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    product: 'robb-operations',
    edition: 'commercial',
    channel,
    licenseKeyFingerprint: 'a'.repeat(64),
  }));
  return { root, source, repository };
}

describe('commercial operations packaging boundary', () => {
  it('stages only a manifest-backed production artifact', () => {
    const { source, repository } = fixture('production');
    const target = stageCommercialOperations(join(source, 'index.js'), repository);
    expect(target).toBe(join(repository, 'apps/electron/dist/resources/operations'));
    expect(readText(join(target, 'index.mjs'))).toContain('commercial');
  });

  it('refuses a development artifact', () => {
    const { source, repository } = fixture('development');
    expect(() => stageCommercialOperations(join(source, 'index.js'), repository))
      .toThrow('not an entitled production artifact');
  });
});

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}
