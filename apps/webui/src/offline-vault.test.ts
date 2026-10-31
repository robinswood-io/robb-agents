import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Session } from "@craft-agent/shared/protocol";
import { OFFLINE_VAULT_MAX_MESSAGES_PER_SESSION, OFFLINE_VAULT_MAX_SESSIONS, anchorsMatch, isScopeExpired, sanitizeSessionSnapshot, searchOfflineSessions, selectRecentSessions } from "./offline-vault";
import { MemoryStorage, previousLocalStorage, session } from "./testing/offline-vault-fixture.ts";

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
});
