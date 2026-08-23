import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { Session } from '@craft-agent/shared/protocol'
import {
  OfflineVault,
  type OfflineVaultPersistence,
} from './offline-vault'
import { OfflineCoordinator } from './offline-coordinator'

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
  record: Parameters<OfflineVaultPersistence['saveRecord']>[0] | null = null
  async loadKey() { return this.key }
  async saveKey(key: CryptoKey) { this.key ??= key; return this.key }
  async loadRecord() { return this.record }
  async saveRecord(record: Parameters<OfflineVaultPersistence['saveRecord']>[0]) { this.record = structuredClone(record) }
  async clear() { this.key = null; this.record = null }
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

async function setup() {
  const vault = new OfflineVault(new MemoryPersistence())
  const coordinator = new OfflineCoordinator(vault)
  await coordinator.enable({
    deviceId: 'device-1',
    workspaceId: 'workspace-1',
    hostLabel: 'Studio',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  return { vault, coordinator }
}

function scopeToken(vault: OfflineVault) {
  const token = vault.getScopeToken()
  if (!token) throw new Error('Expected an active offline scope')
  return token
}

function enqueueMessage(
  vault: OfflineVault,
  input: Parameters<OfflineVault['enqueueMessage']>[0],
) {
  return vault.enqueueMessage(input, scopeToken(vault))
}

function liveSession(overrides: Partial<Session> = {}): Session {
  const messageCount = overrides.messageCount ?? 2
  const messages = overrides.messages ?? Array.from({ length: messageCount }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    timestamp: index + 1,
  })) as Session['messages']
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    name: 'Session',
    lastMessageAt: 100,
    lastFinalMessageId: 'final-1',
    messageCount,
    messages,
    isProcessing: false,
    ...overrides,
  }
}

function transportState(status: 'connected' | 'disconnected') {
  return {
    mode: 'remote' as const,
    status,
    url: 'wss://remote.example.test',
    attempt: 0,
    updatedAt: Date.now(),
  }
}

describe('offline coordinator', () => {
  it('stores offline drafts as text only and does not call the host', async () => {
    const { vault, coordinator } = await setup()
    let remoteCalls = 0
    await coordinator.persistDraft(
      'session-1',
      { text: 'local draft', attachments: [{ path: '/private/file', name: 'file' }] },
      false,
      async () => { remoteCalls += 1 },
      'workspace-1',
    )

    expect(remoteCalls).toBe(0)
    expect(vault.getSnapshot().drafts['session-1']).toMatchObject({
      text: 'local draft',
      dirty: true,
    })
    expect(JSON.stringify(vault.getSnapshot())).not.toContain('/private/file')
  })

  it('keeps a dirty local draft when a connected save loses its RPC', async () => {
    const { vault, coordinator } = await setup()
    await coordinator.persistDraft(
      'session-1',
      { text: 'must survive the disconnect' },
      true,
      async () => { throw new Error('connection lost') },
      'workspace-1',
    )

    expect(vault.getSnapshot().drafts['session-1']).toMatchObject({
      text: 'must survive the disconnect',
      dirty: true,
    })
  })

  it('retains the only draft copy when deletion is requested offline', async () => {
    const { vault, coordinator } = await setup()
    await vault.storeDraft('session-1', 'review before deleting', true, scopeToken(vault))
    let remoteCalls = 0

    await coordinator.deleteDraft(
      'session-1',
      false,
      async () => { remoteCalls += 1 },
      'workspace-1',
    )

    expect(remoteCalls).toBe(0)
    expect(vault.getSnapshot().drafts['session-1']?.text).toBe('review before deleting')
  })

  it('removes the encrypted draft only after the host accepts deletion', async () => {
    const { vault, coordinator } = await setup()
    await vault.storeDraft('session-1', 'delete me', true, scopeToken(vault))
    let remoteCalls = 0

    await coordinator.deleteDraft(
      'session-1',
      true,
      async () => { remoteCalls += 1 },
      'workspace-1',
    )

    expect(remoteCalls).toBe(1)
    expect(vault.getSnapshot().drafts['session-1']).toBeUndefined()
  })

  it('requires a second explicit action when the conversation context changed', async () => {
    const { vault, coordinator } = await setup()
    const item = await enqueueMessage(vault, {
      sessionId: 'session-1',
      sessionName: 'Session',
      text: 'send later',
      anchor: { messageCount: 1, lastFinalMessageId: null, lastMessageAt: 50 },
    })
    let sendCalls = 0
    const api = {
      getTransportConnectionState: async () => transportState('connected'),
      getSessionMessages: async () => liveSession(),
      sendMessage: async () => { sendCalls += 1 },
    }

    const review = await coordinator.reviewOutboxItem(
      item,
      api as Parameters<typeof coordinator.reviewOutboxItem>[1],
    )
    expect(review).toMatchObject({ status: 'ready', contextChanged: true })
    if (review.status !== 'ready') throw new Error('Expected a ready review')
    expect(sendCalls).toBe(0)
    expect(vault.getSnapshot().outbox).toHaveLength(1)

    expect(await coordinator.sendOutboxItem(
      item,
      api as Parameters<typeof coordinator.sendOutboxItem>[1],
      review.reviewedAnchor,
    )).toEqual({ status: 'sent' })
    expect(sendCalls).toBe(1)
    expect(vault.getSnapshot().outbox).toEqual([])
  })

  it('never retries automatically and marks a potentially delivered request uncertain', async () => {
    const { vault, coordinator } = await setup()
    const item = await enqueueMessage(vault, {
      sessionId: 'session-1',
      sessionName: 'Session',
      text: 'possibly delivered',
      anchor: { messageCount: 2, lastFinalMessageId: 'final-1', lastMessageAt: 100 },
    })
    let sendCalls = 0
    const api = {
      getTransportConnectionState: async () => transportState('connected'),
      getSessionMessages: async () => liveSession(),
      sendMessage: async () => { sendCalls += 1; throw new Error('ACK lost') },
    }

    expect(await coordinator.sendOutboxItem(
      item,
      api as Parameters<typeof coordinator.sendOutboxItem>[1],
      item.anchor,
    )).toEqual({ status: 'uncertain' })
    expect(sendCalls).toBe(1)
    expect(vault.getSnapshot().outbox[0]).toMatchObject({
      status: 'uncertain',
      failureKind: 'unknown',
    })
  })

  it('requires another review if the chat changes after the previous review', async () => {
    const { vault, coordinator } = await setup()
    const item = await enqueueMessage(vault, {
      sessionId: 'session-1',
      sessionName: 'Session',
      text: 'context-sensitive',
      anchor: { messageCount: 1, lastFinalMessageId: 'final-a', lastMessageAt: 50 },
    })
    let current = liveSession({ messageCount: 2, lastFinalMessageId: 'final-b', lastMessageAt: 100 })
    let sendCalls = 0
    const api = {
      getTransportConnectionState: async () => transportState('connected'),
      getSessionMessages: async () => current,
      sendMessage: async () => { sendCalls += 1 },
    }
    const review = await coordinator.reviewOutboxItem(
      item,
      api as Parameters<typeof coordinator.reviewOutboxItem>[1],
    )
    if (review.status !== 'ready') throw new Error('Expected a ready review')
    current = liveSession({ messageCount: 3, lastFinalMessageId: 'final-c', lastMessageAt: 150 })

    expect(await coordinator.sendOutboxItem(
      item,
      api as Parameters<typeof coordinator.sendOutboxItem>[1],
      review.reviewedAnchor,
    )).toEqual({ status: 'needs-confirmation', reason: 'context-changed' })
    expect(sendCalls).toBe(0)
    expect(vault.getSnapshot().outbox[0]?.status).toBe('pending')
  })

  it('persists the non-retryable outbox state before invoking the host', async () => {
    const { vault, coordinator } = await setup()
    const item = await enqueueMessage(vault, {
      sessionId: 'session-1',
      sessionName: 'Session',
      text: 'durable send lock',
      anchor: { messageCount: 2, lastFinalMessageId: 'final-1', lastMessageAt: 100 },
    })
    const api = {
      getTransportConnectionState: async () => transportState('connected'),
      getSessionMessages: async () => liveSession(),
      sendMessage: async () => {
        expect(vault.getSnapshot().outbox[0]?.status).toBe('uncertain')
        throw new Error('simulated crash boundary')
      },
    }

    expect(await coordinator.sendOutboxItem(
      item,
      api as Parameters<typeof coordinator.sendOutboxItem>[1],
      item.anchor,
    )).toEqual({ status: 'uncertain' })
  })

  it('keeps a host-proven context rejection reviewable without sending', async () => {
    const { vault, coordinator } = await setup()
    const item = await enqueueMessage(vault, {
      sessionId: 'session-1', sessionName: 'Session', text: 'guarded send',
      anchor: { messageCount: 2, lastFinalMessageId: 'final-1', lastMessageAt: 100 },
    })
    const contextError = Object.assign(new Error('changed'), { code: 'SESSION_CONTEXT_CHANGED' })
    const api = {
      getTransportConnectionState: async () => transportState('connected'),
      getSessionMessages: async () => liveSession(),
      sendMessage: async () => { throw contextError },
    }

    expect(await coordinator.sendOutboxItem(
      item,
      api as Parameters<typeof coordinator.sendOutboxItem>[1],
      item.anchor,
    )).toEqual({ status: 'needs-confirmation', reason: 'context-changed' })
    expect(vault.getSnapshot().outbox[0]).toMatchObject({
      status: 'pending',
      failureKind: 'context-changed',
    })
  })

  it('blocks while disconnected without attempting a send', async () => {
    const { vault, coordinator } = await setup()
    const item = await enqueueMessage(vault, {
      sessionId: 'session-1',
      sessionName: 'Session',
      text: 'later',
      anchor: { messageCount: 2, lastFinalMessageId: 'final-1', lastMessageAt: 100 },
    })
    let sendCalls = 0
    const api = {
      getTransportConnectionState: async () => transportState('disconnected'),
      getSessionMessages: async () => liveSession(),
      sendMessage: async () => { sendCalls += 1 },
    }

    expect(await coordinator.sendOutboxItem(
      item,
      api as Parameters<typeof coordinator.sendOutboxItem>[1],
      item.anchor,
    )).toEqual({
      status: 'blocked',
      reason: 'not-connected',
    })
    expect(sendCalls).toBe(0)
  })

  it('drops an old-principal capture that finishes after a new opt-in', async () => {
    const { vault, coordinator } = await setup()
    let resolveHydration: ((session: Session) => void) | undefined
    const hydration = new Promise<Session>((resolve) => { resolveHydration = resolve })
    const capture = coordinator.captureRecentSessions(
      [liveSession({ id: 'private-a', workspaceId: 'workspace-1', messageCount: 0, messages: [] })],
      async () => hydration,
      'workspace-1',
      true,
    )

    await coordinator.purge()
    await coordinator.enable({
      deviceId: 'device-2',
      workspaceId: 'workspace-2',
      hostLabel: 'Other studio',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    resolveHydration?.(liveSession({
      id: 'private-a',
      workspaceId: 'workspace-1',
      messages: [{ id: 'secret-a', role: 'user', content: 'A-private', timestamp: 1 }],
    }))
    await capture

    expect(vault.getSnapshot().scope?.deviceId).toBe('device-2')
    expect(vault.getSnapshot().sessions).toEqual([])
    expect(JSON.stringify(vault.getSnapshot())).not.toContain('A-private')
  })
})
