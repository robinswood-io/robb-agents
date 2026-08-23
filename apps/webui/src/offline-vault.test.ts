import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Session } from '@craft-agent/shared/protocol'
import {
  OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION,
  OFFLINE_VAULT_MAX_DRAFT_CHARS,
  OFFLINE_VAULT_MAX_OUTBOX_ITEMS,
  OFFLINE_VAULT_MAX_PINS,
  OFFLINE_VAULT_MAX_SESSIONS,
  OFFLINE_VAULT_RETENTION_MS,
  OfflineVault,
  OfflineVaultConflictError,
  anchorsMatch,
  isScopeExpired,
  sanitizeSessionSnapshot,
  searchOfflineSessions,
  selectRecentSessions,
  type OfflineVaultKey,
  type OfflineVaultPersistence,
} from './offline-vault'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

class MemoryPersistence implements OfflineVaultPersistence {
  key: CryptoKey | null = null
  keyGeneration: string | null = null
  record: Parameters<OfflineVaultPersistence['saveRecord']>[0] | null = null
  async loadKey(): Promise<OfflineVaultKey | null> {
    return this.key && this.keyGeneration
      ? { key: this.key, generation: this.keyGeneration }
      : null
  }
  async saveKey(key: CryptoKey): Promise<OfflineVaultKey> {
    if (!this.key || !this.keyGeneration) {
      this.key = key
      this.keyGeneration = crypto.randomUUID()
    }
    return { key: this.key, generation: this.keyGeneration }
  }
  async loadRecord() { return this.record }
  async saveRecord(
    record: Parameters<OfflineVaultPersistence['saveRecord']>[0],
    expectedKeyGeneration: string,
    _expectedRevision?: string | null,
  ) {
    if (this.keyGeneration !== expectedKeyGeneration) throw new OfflineVaultConflictError()
    this.record = structuredClone(record)
  }
  async clear() { this.key = null; this.keyGeneration = null; this.record = null }
}

class CasMemoryPersistence extends MemoryPersistence {
  override async saveRecord(
    record: Parameters<OfflineVaultPersistence['saveRecord']>[0],
    expectedKeyGeneration: string,
    expectedRevision?: string | null,
  ) {
    const currentRevision = this.record?.revision ?? null
    if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
      throw new OfflineVaultConflictError()
    }
    await super.saveRecord(record, expectedKeyGeneration)
  }
}

async function decryptRecord(persistence: MemoryPersistence) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(persistence.record!.iv) },
    persistence.key!,
    persistence.record!.ciphertext,
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
}

function scopeToken(vault: OfflineVault) {
  const token = vault.getScopeToken()
  if (!token) throw new Error('Expected an active offline scope')
  return token
}

const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')

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

function session(id: string, lastMessageAt: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    name: `Session ${id}`,
    lastMessageAt,
    messages: [],
    isProcessing: false,
    ...overrides,
  }
}

describe('offline vault pure policy', () => {
  it('keeps only visible, non-archived recent sessions', () => {
    const sessions = Array.from({ length: OFFLINE_VAULT_MAX_SESSIONS + 4 }, (_, index) => session(
      `s-${index}`,
      index,
      index === 0 ? { hidden: true } : index === 1 ? { isArchived: true } : {},
    ))
    const selected = selectRecentSessions(sessions)
    expect(selected).toHaveLength(OFFLINE_VAULT_MAX_SESSIONS)
    expect(selected[0]?.id).toBe(`s-${OFFLINE_VAULT_MAX_SESSIONS + 3}`)
    expect(selected.some((entry) => entry.hidden || entry.isArchived)).toBe(false)
  })

  it('sanitizes messages to bounded display-only text', () => {
    const messages = [
      { id: 'auth', role: 'auth-request' as const, content: 'credential request', timestamp: 1, authHint: 'secret' },
      { id: 'tool', role: 'tool' as const, content: 'tool', timestamp: 2, toolInput: { token: 'secret' } },
      { id: 'hidden', role: 'assistant' as const, content: 'hidden', timestamp: 3, hidden: true },
      ...Array.from({ length: OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION + 3 }, (_, index) => ({
        id: `m-${index}`,
        role: index % 2 ? 'assistant' as const : 'user' as const,
        content: `message ${index}`,
        timestamp: 10 + index,
        attachments: [{ storedPath: '/secret/path', name: 'private.txt' }],
        badges: [{ rawText: '/secret/path' }],
      })),
    ]
    const snapshot = sanitizeSessionSnapshot(session('safe', 100, { messages } as Partial<Session>), 200)

    expect(snapshot.messages).toHaveLength(OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION)
    expect(snapshot.messages[0]?.id).toBe('m-3')
    expect(JSON.stringify(snapshot)).not.toContain('credential request')
    expect(JSON.stringify(snapshot)).not.toContain('/secret/path')
    expect(JSON.stringify(snapshot)).not.toContain('toolInput')
  })

  it('searches names, previews, and cached message text case-insensitively', () => {
    const alpha = sanitizeSessionSnapshot(session('a', 2, {
      name: 'Roadmap',
      messages: [{ id: 'm', role: 'assistant', content: 'Décision finale', timestamp: 2 }],
    }), 3)
    const beta = sanitizeSessionSnapshot(session('b', 1, { name: 'Budget' }), 3)
    expect(searchOfflineSessions([alpha, beta], 'DÉCISION').map((entry) => entry.id)).toEqual(['a'])
    expect(searchOfflineSessions([alpha, beta], '')).toHaveLength(2)
  })

  it('uses all anchor fields and rejects invalid or expired scopes', () => {
    const anchor = { messageCount: 2, lastFinalMessageId: 'm2', lastMessageAt: 42 }
    expect(anchorsMatch(anchor, { ...anchor })).toBe(true)
    expect(anchorsMatch(anchor, { ...anchor, messageCount: 3 })).toBe(false)
    expect(isScopeExpired({
      deviceId: 'd', workspaceId: 'w', hostLabel: 'h', expiresAt: new Date(Date.now() - 1).toISOString(),
    })).toBe(true)
    expect(isScopeExpired({
      deviceId: 'd', workspaceId: 'w', hostLabel: 'h', expiresAt: 'invalid',
    })).toBe(true)
  })
})

describe('encrypted offline vault', () => {
  it('persists only ciphertext with a non-extractable AES key', async () => {
    const persistence = new MemoryPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vault.storeDraft('session-1', 'plaintext marker 3a91c', true, scopeToken(vault))

    expect(persistence.key?.extractable).toBe(false)
    expect(persistence.key?.algorithm.name).toBe('AES-GCM')
    const raw = new Uint8Array(persistence.record!.ciphertext)
    expect(new TextDecoder().decode(raw)).not.toContain('plaintext marker 3a91c')

    const reopened = new OfflineVault(persistence)
    const state = await reopened.load()
    expect(state.drafts['session-1']?.text).toBe('plaintext marker 3a91c')
  })

  it('bounds sessions and drops retained data after purge', async () => {
    const persistence = new MemoryPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const snapshots = Array.from({ length: OFFLINE_VAULT_MAX_SESSIONS + 3 }, (_, index) => (
      sanitizeSessionSnapshot(session(`s-${index}`, index), Date.now())
    ))
    await vault.replaceSnapshots(snapshots)
    expect(vault.getSnapshot().sessions).toHaveLength(OFFLINE_VAULT_MAX_SESSIONS)

    await vault.purge()
    expect(persistence.key).toBeNull()
    expect(persistence.record).toBeNull()
    expect(vault.getSnapshot().sessions).toEqual([])
  })

  it('evicts stale snapshots when reopening', async () => {
    const persistence = new MemoryPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const old = sanitizeSessionSnapshot(
      session('old', 1),
      Date.now() - OFFLINE_VAULT_RETENTION_MS - 1,
    )
    const fresh = sanitizeSessionSnapshot(session('fresh', 2), Date.now())
    await vault.replaceSnapshots([old, fresh])

    const reopened = new OfflineVault(persistence)
    expect((await reopened.load()).sessions.map((entry) => entry.id)).toEqual(['fresh'])
  })

  it('physically rewrites entries after the retention window', async () => {
    const persistence = new MemoryPersistence()
    const originalNow = Date.now
    let now = 1_800_000_000_000
    Date.now = () => now
    try {
      const vault = new OfflineVault(persistence)
      await vault.enable({
        deviceId: 'device-1',
        workspaceId: 'workspace-1',
        hostLabel: 'Studio',
        expiresAt: new Date(now + OFFLINE_VAULT_RETENTION_MS * 2).toISOString(),
      })
      await vault.replaceSnapshots([sanitizeSessionSnapshot(session('retention-marker', now), now)])
      expect(JSON.stringify(await decryptRecord(persistence))).toContain('retention-marker')

      now += OFFLINE_VAULT_RETENTION_MS + 1
      const reopened = new OfflineVault(persistence)
      expect((await reopened.load()).sessions).toEqual([])
      expect(JSON.stringify(await decryptRecord(persistence))).not.toContain('retention-marker')
    } finally {
      Date.now = originalNow
    }
  })

  it('purges encrypted data after the paired-session expiry', async () => {
    const persistence = new MemoryPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 10).toISOString(),
    })
    await vault.storeDraft('session-1', 'expires with the device session', true, scopeToken(vault))
    await new Promise((resolve) => setTimeout(resolve, 20))

    const reopened = new OfflineVault(persistence)
    expect((await reopened.load()).scope).toBeNull()
    expect(persistence.record).toBeNull()
    expect(localStorage.length).toBe(0)
  })

  it('refuses every mutation after expiry instead of creating an unscoped record', async () => {
    const persistence = new MemoryPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 10).toISOString(),
    })
    const expiredToken = scopeToken(vault)
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(vault.storeDraft('session-1', 'post-expiry', true, expiredToken)).rejects.toThrow('expired')
    expect(vault.getSnapshot()).toMatchObject({ scope: null, drafts: {} })
    expect(localStorage.length).toBe(0)
    expect(persistence.record).toBeNull()
  })

  it('overwrites private data when IndexedDB deletion is blocked', async () => {
    class BlockedClearPersistence extends MemoryPersistence {
      override async clear() { throw new Error('blocked') }
    }
    const persistence = new BlockedClearPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vault.storeDraft('session-1', 'ciphertext may remain but consent must not', true, scopeToken(vault))

    await expect(vault.purge()).resolves.toBeUndefined()
    expect(vault.getSnapshot().scope).toBeNull()
    expect(localStorage.length).toBe(0)
    expect(JSON.stringify(await decryptRecord(persistence))).not.toContain('ciphertext may remain')
    const reopened = new OfflineVault(persistence)
    expect((await reopened.load()).scope).toBeNull()
  })

  it('uses an encrypted empty overwrite when consent and deletion are blocked', async () => {
    class BlockedStorage extends MemoryStorage {
      override removeItem() { throw new Error('blocked') }
    }
    class BlockedPersistence extends MemoryPersistence {
      override async clear() { throw new Error('blocked') }
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: new BlockedStorage(),
    })
    const persistence = new BlockedPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1',
      workspaceId: 'workspace-1',
      hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vault.storeDraft('session-1', 'must-delete', true, scopeToken(vault))

    await expect(vault.purge()).resolves.toBeUndefined()
    expect(vault.getSnapshot()).toMatchObject({ scope: null, drafts: {} })
    expect(localStorage.getItem('robb-agents.remote.offline-enabled.v1')).toBe('true')
    expect(JSON.stringify(await decryptRecord(persistence))).not.toContain('must-delete')

    const reopened = new OfflineVault(persistence)
    await expect(reopened.load()).resolves.toMatchObject({ scope: null, drafts: {} })
    expect(reopened.getSnapshot()).toMatchObject({ scope: null, drafts: {} })
  })

  it('keeps a durable revocation barrier when record overwrite and deletion both fail', async () => {
    class FailingErasePersistence extends MemoryPersistence {
      failErase = false
      override async saveRecord(...args: Parameters<OfflineVaultPersistence['saveRecord']>) {
        if (this.failErase) throw new Error('write blocked')
        await super.saveRecord(...args)
      }
      override async clear() { throw new Error('delete blocked') }
    }
    const persistence = new FailingErasePersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vault.storeDraft('session-1', 'never reopen me', true, scopeToken(vault))
    persistence.failErase = true

    await expect(vault.purge()).rejects.toThrow('could not be fully erased')
    expect(vault.getSnapshot()).toMatchObject({ scope: null, drafts: {} })
    expect(localStorage.getItem('robb-agents.remote.offline-revocation-pending.v1')).toBe('true')

    const reopened = new OfflineVault(persistence)
    await expect(reopened.load()).rejects.toThrow('could not be fully erased')
    expect(reopened.getSnapshot()).toMatchObject({ scope: null, drafts: {} })
  })

  it('keeps failed mutations out of memory and later ciphertext', async () => {
    class FailingSavePersistence extends MemoryPersistence {
      failNextSave = false
      override async saveRecord(...args: Parameters<OfflineVaultPersistence['saveRecord']>) {
        if (this.failNextSave) {
          this.failNextSave = false
          throw new Error('disk full')
        }
        await super.saveRecord(...args)
      }
    }
    const persistence = new FailingSavePersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vault.storeDraft('first', 'committed', true, scopeToken(vault))
    persistence.failNextSave = true
    await expect(vault.storeDraft('ghost', 'must never commit', true, scopeToken(vault))).rejects.toThrow('disk full')
    expect(vault.getSnapshot().drafts.ghost).toBeUndefined()
    await vault.storeDraft('later', 'committed later', true, scopeToken(vault))
    expect(JSON.stringify(await decryptRecord(persistence))).not.toContain('must never commit')
  })

  it('drops stale workspace captures after a scope generation change', async () => {
    const persistence = new MemoryPersistence()
    const vault = new OfflineVault(persistence)
    await vault.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const staleToken = vault.getScopeToken()!
    await vault.configureScope({
      deviceId: 'device-2', workspaceId: 'workspace-2', hostLabel: 'Other',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vault.replaceSnapshots([
      sanitizeSessionSnapshot(session('private-a', 1), Date.now()),
    ], staleToken)
    expect(vault.getSnapshot().scope?.workspaceId).toBe('workspace-2')
    expect(vault.getSnapshot().sessions).toEqual([])
  })

  it('rejects delayed user actions after the workspace scope changes', async () => {
    const vault = new OfflineVault(new MemoryPersistence())
    await vault.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const staleToken = scopeToken(vault)
    await vault.configureScope({
      deviceId: 'device-1', workspaceId: 'workspace-2', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    await expect(vault.togglePin({
      sessionId: 'session-a', messageId: 'message-a', role: 'user', text: 'private A',
    }, staleToken)).rejects.toThrow('workspace changed')
    await expect(vault.enqueueMessage({
      sessionId: 'session-a', sessionName: 'Workspace A', text: 'private A',
      anchor: { messageCount: 1, lastFinalMessageId: null, lastMessageAt: 1 },
    }, staleToken)).rejects.toThrow('workspace changed')
    expect(vault.getSnapshot()).toMatchObject({ pins: [], outbox: [] })
  })

  it('rejects full queues and oversized user text without silent eviction', async () => {
    const vault = new OfflineVault(new MemoryPersistence())
    await vault.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const token = scopeToken(vault)
    const first = await vault.enqueueMessage({
      sessionId: 's-0', sessionName: 'First', text: 'first',
      anchor: { messageCount: 0, lastFinalMessageId: null, lastMessageAt: 0 },
    }, token)
    for (let index = 1; index < OFFLINE_VAULT_MAX_OUTBOX_ITEMS; index += 1) {
      await vault.enqueueMessage({
        sessionId: `s-${index}`, sessionName: `Session ${index}`, text: `message ${index}`,
        anchor: { messageCount: 0, lastFinalMessageId: null, lastMessageAt: 0 },
      }, token)
    }
    await expect(vault.enqueueMessage({
      sessionId: 'overflow', sessionName: 'Overflow', text: 'must be refused',
      anchor: { messageCount: 0, lastFinalMessageId: null, lastMessageAt: 0 },
    }, token)).rejects.toThrow('outbox is full')
    expect(vault.getSnapshot().outbox).toHaveLength(OFFLINE_VAULT_MAX_OUTBOX_ITEMS)
    expect(vault.getSnapshot().outbox[0]?.id).toBe(first.id)

    for (let index = 0; index < OFFLINE_VAULT_MAX_PINS; index += 1) {
      await vault.togglePin({ sessionId: 's-0', messageId: `p-${index}`, role: 'user', text: `pin ${index}` }, token)
    }
    await expect(vault.togglePin({
      sessionId: 's-0', messageId: 'pin-overflow', role: 'user', text: 'must be refused',
    }, token)).rejects.toThrow('offline pins')
    expect(vault.getSnapshot().pins).toHaveLength(OFFLINE_VAULT_MAX_PINS)

    const oversized = 'x'.repeat(OFFLINE_VAULT_MAX_DRAFT_CHARS + 1)
    await expect(vault.storeDraft('oversized', oversized, true, scopeToken(vault))).rejects.toThrow('character offline limit')
    await expect(vault.enqueueMessage({
      sessionId: 's', sessionName: 'Too long', text: oversized,
      anchor: { messageCount: 0, lastFinalMessageId: null, lastMessageAt: 0 },
    }, token)).rejects.toThrow('character offline limit')
  })

  it('never downgrades uncertain delivery back to a retryable item', async () => {
    const vault = new OfflineVault(new MemoryPersistence())
    await vault.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const token = scopeToken(vault)
    const item = await vault.enqueueMessage({
      sessionId: 'session-1', sessionName: 'Session', text: 'maybe sent',
      anchor: { messageCount: 1, lastFinalMessageId: 'final-1', lastMessageAt: 1 },
    }, token)
    await vault.beginOutboxSend(item.id, token)
    await vault.markOutboxFailure(item.id, 'context-changed', token)
    expect(vault.getSnapshot().outbox[0]).toMatchObject({
      status: 'uncertain',
      failureKind: 'unknown',
    })
  })

  it('preserves a dirty draft even when its conversation has no snapshot', async () => {
    const vault = new OfflineVault(new MemoryPersistence())
    await vault.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vault.storeDraft('orphan-session', 'local work', true, scopeToken(vault))
    await vault.mergeRemoteDrafts({})
    expect(vault.getSnapshot().drafts['orphan-session']).toMatchObject({
      text: 'local work',
      dirty: true,
    })
  })

  it('prevents a stale tab from overwriting or resurrecting newer vault data', async () => {
    const persistence = new CasMemoryPersistence()
    const firstTab = new OfflineVault(persistence)
    await firstTab.enable({
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const secondTab = new OfflineVault(persistence)
    await secondTab.load()

    const secondTabToken = scopeToken(secondTab)
    await firstTab.storeDraft('newer', 'from the first tab', true, scopeToken(firstTab))
    await expect(secondTab.storeDraft('stale', 'must not overwrite', true, secondTabToken))
      .rejects.toThrow('another tab')
    expect(secondTab.getSnapshot().scope).toBeNull()
    await expect(secondTab.storeDraft('stale-again', 'must not clear the winner', true, secondTabToken))
      .rejects.toThrow('another tab')

    const reopened = new OfflineVault(persistence)
    expect((await reopened.load()).drafts).toMatchObject({
      newer: { text: 'from the first tab' },
    })
    expect(reopened.getSnapshot().drafts.stale).toBeUndefined()
  })

  it('converges simultaneous first-time tabs on one encryption key', async () => {
    class RacingKeyPersistence extends CasMemoryPersistence {
      private candidates: Array<{ key: CryptoKey; resolve: (key: OfflineVaultKey) => void }> = []

      override async saveKey(key: CryptoKey): Promise<OfflineVaultKey> {
        return new Promise((resolve) => {
          this.candidates.push({ key, resolve })
          if (this.candidates.length !== 2) return
          this.key = this.candidates[0].key
          this.keyGeneration = crypto.randomUUID()
          const winner = { key: this.key, generation: this.keyGeneration }
          for (const candidate of this.candidates) candidate.resolve(winner)
        })
      }
    }
    const persistence = new RacingKeyPersistence()
    const scope = {
      deviceId: 'device-1', workspaceId: 'workspace-1', hostLabel: 'Studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const firstTab = new OfflineVault(persistence)
    const secondTab = new OfflineVault(persistence)

    const results = await Promise.allSettled([firstTab.enable(scope), secondTab.enable(scope)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

    const reopened = new OfflineVault(persistence)
    await expect(reopened.load()).resolves.toMatchObject({
      scope: { deviceId: 'device-1', workspaceId: 'workspace-1' },
    })
  })

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
})
