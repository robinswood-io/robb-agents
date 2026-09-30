import { describe, expect, it } from 'bun:test';
import type { CredentialBackend } from './backends/types.ts';
import { CredentialManager } from './manager.ts';
import type { CredentialId, StoredCredential } from './types.ts';
import { credentialIdToAccount } from './types.ts';

class MemoryCredentialBackend implements CredentialBackend {
  readonly name = 'memory';
  readonly priority = 1;
  readonly values = new Map<string, StoredCredential>();

  async isAvailable(): Promise<boolean> { return true; }
  async get(id: CredentialId): Promise<StoredCredential | null> {
    return structuredClone(this.values.get(credentialIdToAccount(id)) ?? null);
  }
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    this.values.set(credentialIdToAccount(id), structuredClone(credential));
  }
  async delete(id: CredentialId): Promise<boolean> {
    return this.values.delete(credentialIdToAccount(id));
  }
  async list(): Promise<CredentialId[]> { return []; }
}

function managerWithMemoryBackend(): CredentialManager {
  const manager = new CredentialManager();
  const backend = new MemoryCredentialBackend();
  Object.assign(manager as unknown as Record<string, unknown>, {
    initialized: true,
    backends: [backend],
    writeBackend: backend,
  });
  return manager;
}

describe('LLM credential authority generations', () => {
  it('rotates on replacement and preserves the opaque binding on OAuth refresh', async () => {
    const manager = managerWithMemoryBackend();
    await manager.setLlmOAuth('provider-a', {
      accessToken: 'access-a', refreshToken: 'refresh-a', expiresAt: 1,
    });
    const first = await manager.getLlmCredentialBinding('provider-a', 'oauth');
    expect(first?.bindingId).toBeString();
    expect(first?.bindingId).not.toContain('access-a');

    await manager.refreshLlmOAuth('provider-a', {
      accessToken: 'access-b', refreshToken: 'refresh-b', expiresAt: 2,
    });
    expect(await manager.getLlmCredentialBinding('provider-a', 'oauth')).toEqual(first);
    expect((await manager.getLlmOAuth('provider-a', first!.bindingId))?.accessToken).toBe('access-b');

    await manager.setLlmOAuth('provider-a', {
      accessToken: 'access-c', refreshToken: 'refresh-c', expiresAt: 3,
    });
    const replacement = await manager.getLlmCredentialBinding('provider-a', 'oauth');
    expect(replacement?.bindingId).not.toBe(first?.bindingId);
    await expect(manager.getLlmOAuth('provider-a', first!.bindingId)).rejects.toThrow('generation drifted');
  });

  it('rotates API-key bindings and refuses unobservable environment authority', async () => {
    const manager = managerWithMemoryBackend();
    await manager.setLlmApiKey('provider-a', 'secret-a');
    const first = await manager.getLlmCredentialBinding('provider-a', 'api_key');
    await manager.setLlmApiKey('provider-a', 'secret-b');
    const second = await manager.getLlmCredentialBinding('provider-a', 'api_key');
    expect(second?.bindingId).not.toBe(first?.bindingId);
    expect(await manager.getLlmCredentialBinding('provider-a', 'environment')).toBeNull();
    expect(await manager.getLlmCredentialBinding('provider-a', 'none')).toBeNull();
  });

  it('serializes replacement against refresh and never restores an old generation', async () => {
    const manager = managerWithMemoryBackend();
    await manager.setLlmOAuth('provider-race', {
      accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1,
    });
    const oldBinding = (await manager.getLlmCredentialBinding('provider-race', 'oauth'))!.bindingId;

    const replacement = manager.setLlmOAuth('provider-race', {
      accessToken: 'new-principal', refreshToken: 'new-refresh', expiresAt: 3,
    });
    const staleRefresh = manager.refreshLlmOAuth('provider-race', {
      accessToken: 'old-refreshed', refreshToken: 'old-refresh-2', expiresAt: 4,
    }, oldBinding);

    await replacement;
    await expect(staleRefresh).rejects.toThrow('generation drifted');
    expect((await manager.getLlmOAuth('provider-race'))?.accessToken).toBe('new-principal');
    expect((await manager.getLlmCredentialBinding('provider-race', 'oauth'))?.bindingId)
      .not.toBe(oldBinding);
  });

  it('migrates a legacy OAuth slot only for an unsealed refresh', async () => {
    const manager = managerWithMemoryBackend();
    await manager.set({ type: 'llm_oauth', connectionSlug: 'legacy' }, {
      value: 'legacy-access', refreshToken: 'legacy-refresh', expiresAt: 1,
    });

    expect(await manager.getLlmCredentialBinding('legacy', 'oauth')).toBeNull();
    await expect(manager.refreshLlmOAuth('legacy', {
      accessToken: 'blocked', refreshToken: 'legacy-refresh', expiresAt: 2,
    }, 'specialized-generation')).rejects.toThrow('generation drifted');
    expect(await manager.getLlmCredentialBinding('legacy', 'oauth')).toBeNull();

    await manager.refreshLlmOAuth('legacy', {
      accessToken: 'refreshed', refreshToken: 'legacy-refresh', expiresAt: 3,
    });
    const migrated = await manager.getLlmCredentialBinding('legacy', 'oauth');
    expect(migrated?.bindingId).toBeString();
    expect((await manager.getLlmOAuth('legacy', migrated!.bindingId))?.accessToken)
      .toBe('refreshed');
  });
});
