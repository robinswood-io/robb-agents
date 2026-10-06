import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;

function readDefaults(configDir: string) {
  const run = Bun.spawnSync([
    process.execPath, '--eval',
    `import { loadConfigDefaults } from ${JSON.stringify(storageModule)}; console.log(JSON.stringify(loadConfigDefaults()));`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe',
  });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

describe('YOLO configuration defaults', () => {
  it('persists autonomous defaults on first use without bundled assets', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'robb-yolo-default-'));
    expect(readDefaults(configDir).workspaceDefaults).toMatchObject({
      permissionMode: 'allow-all', externalActionPolicy: 'allow-in-execute',
    });
    expect(JSON.parse(readFileSync(join(configDir, 'config-defaults.json'), 'utf8'))
      .workspaceDefaults.externalActionPolicy).toBe('allow-in-execute');
    expect(readDefaults(configDir).workspaceDefaults.externalActionPolicy).toBe('allow-in-execute');
  });

  for (const policy of ['confirm', undefined]) {
    it(`preserves an existing ${policy ?? 'legacy absent'} policy across reload`, () => {
      const configDir = mkdtempSync(join(tmpdir(), 'robb-yolo-existing-default-'));
      writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
        defaults: {}, workspaceDefaults: {
          permissionMode: 'ask', externalActionPolicy: policy,
          cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
        },
      }));
      expect(readDefaults(configDir).workspaceDefaults).toMatchObject({
        permissionMode: 'ask', externalActionPolicy: 'confirm',
      });
      expect(readDefaults(configDir).workspaceDefaults.externalActionPolicy).toBe('confirm');
    });
  }
});
