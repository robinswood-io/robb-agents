import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CredentialStoreError, SecureStorageBackend } from './secure-storage.ts';

describe('SecureStorageBackend', () => {
  let root: string;
  let credentialsFile: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'robb-credentials-'));
    credentialsFile = join(root, 'credentials.enc');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('serializes concurrent writers across backend instances without losing entries', async () => {
    const first = new SecureStorageBackend({ credentialsFile, machineId: 'machine-a' });
    const second = new SecureStorageBackend({ credentialsFile, machineId: 'machine-a' });

    await Promise.all(Array.from({ length: 40 }, (_, index) => {
      const backend = index % 2 === 0 ? first : second;
      return backend.set(
        { type: 'source_bearer', workspaceId: 'workspace-a', sourceId: `source-${index}` },
        { value: `secret-${index}` },
      );
    }));

    first.clearCache();
    const ids = await first.list({ type: 'source_bearer', workspaceId: 'workspace-a' });
    expect(ids).toHaveLength(40);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('creates a host signing key exactly once across concurrent backend instances', async () => {
    const first = new SecureStorageBackend({ credentialsFile, machineId: 'machine-a' });
    const second = new SecureStorageBackend({ credentialsFile, machineId: 'machine-a' });
    let createCount = 0;
    const id = {
      type: 'governance_signing_key' as const,
      workspaceId: 'workspace-a',
      name: 'execution-proof-v1',
    };

    const [left, right] = await Promise.all([
      first.getOrCreate(id, () => ({ value: `key-${++createCount}` })),
      second.getOrCreate(id, () => ({ value: `key-${++createCount}` })),
    ]);

    expect(left.value).toBe(right.value);
    expect(createCount).toBe(1);
  });

  it('preserves encrypted bytes when machine-bound decryption fails', async () => {
    const writer = new SecureStorageBackend({ credentialsFile, machineId: 'machine-a' });
    await writer.set({ type: 'llm_api_key', connectionSlug: 'primary' }, { value: 'secret-value' });
    const encryptedBefore = readFileSync(credentialsFile);

    const movedMachine = new SecureStorageBackend({ credentialsFile, machineId: 'machine-b' });
    let observed: unknown;
    try {
      await movedMachine.get({ type: 'llm_api_key', connectionSlug: 'primary' });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(CredentialStoreError);
    expect((observed as CredentialStoreError).code).toBe('decryption_failed');
    expect(existsSync(credentialsFile)).toBe(true);
    expect(readFileSync(credentialsFile).equals(encryptedBefore)).toBe(true);
  });

  it('preserves a malformed file for forensic recovery', async () => {
    const malformed = Buffer.from('not-a-credential-store');
    writeFileSync(credentialsFile, malformed, { mode: 0o600 });
    const backend = new SecureStorageBackend({ credentialsFile, machineId: 'machine-a' });

    await expect(backend.list()).rejects.toMatchObject({ code: 'corrupted' });
    expect(readFileSync(credentialsFile).equals(malformed)).toBe(true);
  });
});
