import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRobbOperationsExtension,
  getRobbOperationsExtension,
} from '@craft-agent/shared/operations';
import { loadRobbOperationsModule } from './module-loader.ts';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await clearRobbOperationsExtension();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function options(modulePath?: string) {
  return {
    dataRoot: '/tmp/robb-operations-data',
    appVersion: '0.0.0-test',
    buildChannel: 'development' as const,
    isPackaged: false,
    env: {},
    modulePath,
  };
}

describe('loadRobbOperationsModule', () => {
  it('is a no-op when the commercial artifact is absent', async () => {
    expect(await loadRobbOperationsModule(options())).toBeNull();
    expect(getRobbOperationsExtension()).toBeUndefined();
  });

  it('loads and registers an explicit external module', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-operations-loader-'));
    temporaryPaths.push(root);
    const entry = join(root, 'index.mjs');
    writeFileSync(entry, `
      export function createRobbOperationsExtension() {
        return {
          apiVersion: 1,
          id: 'external-test',
          edition: 'commercial',
          beforeTurn() { return { decision: 'allow' }; },
          beforeTool() { return { decision: 'allow' }; },
          onRuntimeEvent() {},
        };
      }
    `);

    const loaded = await loadRobbOperationsModule(options(entry));
    expect(loaded?.id).toBe('external-test');
    expect(getRobbOperationsExtension()).toBe(loaded!);
  });

  it('rejects symlink module paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'robb-operations-loader-'));
    temporaryPaths.push(root);
    const target = join(root, 'target.mjs');
    const link = join(root, 'link.mjs');
    writeFileSync(target, 'export const nope = true;');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(target, link);
    await expect(loadRobbOperationsModule(options(link))).rejects.toThrow('non-symlink');
  });

  it('rejects relative paths and ignores runtime injection in packaged builds', async () => {
    await expect(loadRobbOperationsModule(options('relative/index.mjs'))).rejects.toThrow('must be absolute');
    expect(await loadRobbOperationsModule({
      ...options(),
      buildChannel: 'production',
      isPackaged: true,
      env: { ROBB_OPERATIONS_MODULE_PATH: '/tmp/untrusted-commercial-module.mjs' },
    })).toBeNull();
  });
});
