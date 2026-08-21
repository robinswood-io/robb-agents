import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnsupportedWorkspaceConfigVersionError,
  loadWorkspaceConfig,
  saveWorkspaceConfig,
} from '../storage.ts';

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'workspace-schema-version-'));
  roots.push(path);
  return path;
}

function legacyConfig() {
  return {
    id: 'workspace-1',
    name: 'Workspace',
    slug: 'workspace',
    defaults: { permissionMode: 'safe' as const, enabledSourceSlugs: [] },
    createdAt: 1,
    updatedAt: 2,
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('workspace config schema envelope', () => {
  it('migrates an unversioned config once and keeps a rollback copy', () => {
    const workspaceRoot = root();
    const legacy = JSON.stringify(legacyConfig());
    writeFileSync(join(workspaceRoot, 'config.json'), legacy);

    expect(loadWorkspaceConfig(workspaceRoot)).toMatchObject({ schemaVersion: 1, id: 'workspace-1' });
    expect(existsSync(join(workspaceRoot, 'config.pre-schema-v1.json.bak'))).toBe(true);
    expect(readFileSync(join(workspaceRoot, 'config.pre-schema-v1.json.bak'), 'utf8')).toBe(legacy);
    expect(JSON.parse(readFileSync(join(workspaceRoot, 'config.json'), 'utf8'))).toMatchObject({ schemaVersion: 1 });
  });

  it('fails closed on a future schema instead of treating it as a missing workspace', () => {
    const workspaceRoot = root();
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...legacyConfig(), schemaVersion: 2 }));

    expect(() => loadWorkspaceConfig(workspaceRoot)).toThrow(UnsupportedWorkspaceConfigVersionError);
    expect(JSON.parse(readFileSync(join(workspaceRoot, 'config.json'), 'utf8')).schemaVersion).toBe(2);
  });

  it('always emits the current schema on atomic save', () => {
    const workspaceRoot = root();
    saveWorkspaceConfig(workspaceRoot, { ...legacyConfig(), schemaVersion: 1 });

    expect(JSON.parse(readFileSync(join(workspaceRoot, 'config.json'), 'utf8'))).toMatchObject({
      schemaVersion: 1,
      id: 'workspace-1',
    });
  });

  it('refuses to overwrite a future config through the save boundary', () => {
    const workspaceRoot = root();
    const future = JSON.stringify({ ...legacyConfig(), schemaVersion: 2 });
    writeFileSync(join(workspaceRoot, 'config.json'), future);

    expect(() => saveWorkspaceConfig(workspaceRoot, { ...legacyConfig(), schemaVersion: 1 }))
      .toThrow(UnsupportedWorkspaceConfigVersionError);
    expect(readFileSync(join(workspaceRoot, 'config.json'), 'utf8')).toBe(future);
  });

  it('refuses to overwrite an invalid existing config through the save boundary', () => {
    const workspaceRoot = root();
    const invalid = '{"schemaVersion":1,"id":';
    writeFileSync(join(workspaceRoot, 'config.json'), invalid);

    expect(() => saveWorkspaceConfig(workspaceRoot, { ...legacyConfig(), schemaVersion: 1 }))
      .toThrow('Refusing to overwrite an existing incompatible workspace config');
    expect(readFileSync(join(workspaceRoot, 'config.json'), 'utf8')).toBe(invalid);
  });
});
