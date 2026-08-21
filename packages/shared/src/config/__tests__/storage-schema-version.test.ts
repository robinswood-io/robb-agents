import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;

function setup(version?: number) {
  const configDir = mkdtempSync(join(tmpdir(), 'robb-config-schema-'));
  const workspaceRoot = join(configDir, 'workspaces', 'demo');
  mkdirSync(workspaceRoot, { recursive: true });
  const now = Date.now();
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({
    id: 'workspace-1', name: 'Demo', slug: 'demo', createdAt: now, updatedAt: now,
  }));
  const configPath = join(configDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    ...(version === undefined ? {} : { schemaVersion: version }),
    workspaces: [{ id: 'workspace-1', name: 'Demo', rootPath: workspaceRoot, createdAt: now }],
    activeWorkspaceId: 'workspace-1',
    activeSessionId: null,
  }, null, 2));
  return { configDir, configPath };
}

function run(configDir: string, expression: string) {
  return Bun.spawnSync([process.execPath, '--eval', `
    import { loadStoredConfig, saveConfig, setRtkEnabled } from '${STORAGE_MODULE}';
    ${expression}
  `], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe', stderr: 'pipe',
  });
}

describe('stored config schema envelope', () => {
  it('migrates a legacy unversioned config and persists schemaVersion atomically', () => {
    const { configDir, configPath } = setup();
    const before = readFileSync(configPath, 'utf8');
    const result = run(configDir, `
      const config = loadStoredConfig();
      console.log(JSON.stringify({ version: config?.schemaVersion, workspaces: config?.workspaces.length }));
    `);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString().trim())).toEqual({ version: 1, workspaces: 1 });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).schemaVersion).toBe(1);
    const backups = readdirSync(configDir).filter((name) => /^config\.json\.bak-\d{4}-\d{2}-\d{2}$/.test(name));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(configDir, backups[0]!), 'utf8')).toBe(before);
    expect(readdirSync(configDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fails closed on a future schema without rewriting user data', () => {
    const { configDir, configPath } = setup(99);
    const before = readFileSync(configPath, 'utf8');
    const result = run(configDir, `console.log(JSON.stringify(loadStoredConfig()));`);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe('null');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('refuses first-run fallbacks that would overwrite a future schema', () => {
    const { configDir, configPath } = setup(99);
    const before = readFileSync(configPath, 'utf8');
    const result = run(configDir, `setRtkEnabled(true);`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('Refusing to overwrite an existing incompatible stored config');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('refuses first-run fallbacks that would overwrite invalid JSON', () => {
    const { configDir, configPath } = setup(1);
    const invalid = '{"schemaVersion":1,"workspaces":';
    writeFileSync(configPath, invalid);
    const result = run(configDir, `setRtkEnabled(true);`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('Refusing to overwrite an existing incompatible stored config');
    expect(readFileSync(configPath, 'utf8')).toBe(invalid);
  });

  it('validates before save and always writes the current envelope', () => {
    const { configDir, configPath } = setup(1);
    const result = run(configDir, `
      const config = loadStoredConfig();
      if (!config) throw new Error('missing config');
      delete config.schemaVersion;
      saveConfig(config);
    `);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).schemaVersion).toBe(1);
  });
});
