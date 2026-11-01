import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { OfflineVault, type OfflineVaultKey } from "./offline-vault";
import { CasMemoryPersistence, MemoryStorage, previousLocalStorage } from "./testing/offline-vault-fixture.ts";

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  })
})
afterEach(() => {
  if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage)
  else delete (globalThis as { localStorage?: Storage }).localStorage
})

describe('encrypted offline vault', () => {
  it('rejects an enable commit when another tab purges its key generation', async () => {
    class PurgeInterleavingPersistence extends CasMemoryPersistence {
      afterSaveKey: (() => Promise<void>) | null = null

      override async saveKey(key: CryptoKey): Promise<OfflineVaultKey> {
        const winner = await super.saveKey(key)
        const hook = this.afterSaveKey
        this.afterSaveKey = null
        if (hook) await hook()
        return winner
      }
    }
    const persistence = new PurgeInterleavingPersistence()
    const enablingTab = new OfflineVault(persistence)
    const purgingTab = new OfflineVault(persistence)
    persistence.afterSaveKey = () => purgingTab.purge()

    await expect(enablingTab.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })).rejects.toThrow('another tab')

    expect(persistence.key).toBeNull()
    expect(persistence.keyGeneration).toBeNull()
    expect(persistence.record).toBeNull()
    expect(localStorage.getItem('robb-agents.remote.offline-enabled.v1')).toBeNull()
    await expect(new OfflineVault(persistence).load()).resolves.toMatchObject({ scope: null })
  })
});
