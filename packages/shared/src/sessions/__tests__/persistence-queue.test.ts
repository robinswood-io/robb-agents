import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHeader, StoredSession } from '../types'
import { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata } from '../persistence-queue'
import { getSessionFilePath } from '../storage'

function makeHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    schemaVersion: 1,
    id: 's1',
    workspaceRootPath: '~/.craft-agent/workspaces/ws',
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    },
    ...overrides,
  }
}

function makeStoredSession(root: string, id: string, content: string): StoredSession {
  return {
    id,
    workspaceRootPath: root,
    createdAt: 1,
    lastUsedAt: 2,
    messages: [{ id: 'm1', type: 'user', content, timestamp: 1 }],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

describe('session persistence header conflict helpers', () => {
  it('metadata signature ignores non-metadata fields', () => {
    const a = makeHeader({ name: 'A', lastUsedAt: 100 })
    const b = makeHeader({ name: 'A', lastUsedAt: 999, messageCount: 42 })

    expect(getHeaderMetadataSignature(a)).toBe(getHeaderMetadataSignature(b))
  })

  it('metadata signature changes when metadata changes', () => {
    const a = makeHeader({ name: 'A', labels: ['x'] })
    const b = makeHeader({ name: 'B', labels: ['x'] })

    expect(getHeaderMetadataSignature(a)).not.toBe(getHeaderMetadataSignature(b))
  })

  it('merge preserves external metadata while keeping local computed fields', () => {
    const local = makeHeader({
      name: 'Local Name',
      labels: ['local'],
      isFlagged: false,
      sessionStatus: 'todo',
      permissionMode: 'allow-all',
      hasUnread: true,
      lastReadMessageId: 'm-local',
      messageCount: 99,
      lastUsedAt: 500,
    })

    const disk = makeHeader({
      name: 'Disk Name',
      labels: ['disk'],
      isFlagged: true,
      sessionStatus: 'needs-review',
      permissionMode: 'safe',
      hasUnread: false,
      lastReadMessageId: 'm-disk',
      messageCount: 1,
      lastUsedAt: 50,
    })

    const merged = mergeHeaderWithExternalMetadata(local, disk)

    expect(merged.name).toBe('Disk Name')
    expect(merged.labels).toEqual(['disk'])
    expect(merged.isFlagged).toBe(true)
    expect(merged.sessionStatus).toBe('needs-review')
    expect(merged.permissionMode).toBe('safe')
    expect(merged.hasUnread).toBe(false)
    expect(merged.lastReadMessageId).toBe('m-disk')

    // Local computed/runtime persistence fields remain local
    expect(merged.messageCount).toBe(99)
    expect(merged.lastUsedAt).toBe(500)
  })

  it('startup scenario: external metadata differs from local signature', () => {
    const local = makeHeader({ name: 'Local Name', labels: ['local'] })
    const disk = makeHeader({ name: 'External Name', labels: ['external'] })

    const localSig = getHeaderMetadataSignature(local)
    const diskSig = getHeaderMetadataSignature(disk)

    // This is the condition used by persistence queue at startup:
    // no previousSig yet, disk differs from local → preserve external metadata.
    const hasExternalMetadataChange = diskSig !== localSig
      && (undefined === undefined || diskSig !== undefined)

    expect(hasExternalMetadataChange).toBe(true)

    const merged = mergeHeaderWithExternalMetadata(local, disk)
    expect(merged.name).toBe('External Name')
    expect(merged.labels).toEqual(['external'])
  })
})

describe('durable session persistence barrier', () => {
  it('fsyncs the exact queued snapshot inside the serialized write before resolving', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-durable-flush-'))
    const order: string[] = []
    const queue = new SessionPersistenceQueue(60_000, {
      afterTempWrite: () => { order.push('temp-written') },
      beforeFileSync: () => { order.push('sync-start') },
      afterFileSync: () => { order.push('temp-synced') },
      afterFinalFileSync: () => { order.push('final-synced') },
      afterDirectorySync: () => { order.push('directory-synced') },
    })
    try {
      queue.enqueue(makeStoredSession(root, 'durable-order', 'durable marker'))
      await queue.flushDurable('durable-order')

      expect(order).toEqual(process.platform === 'win32'
        ? ['temp-written', 'sync-start', 'temp-synced', 'final-synced']
        : ['temp-written', 'sync-start', 'temp-synced', 'final-synced', 'directory-synced'])
      expect(readFileSync(getSessionFilePath(root, 'durable-order'), 'utf8'))
        .toContain('durable marker')
    } finally {
      queue.cancel('durable-order')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps a racing newer enqueue inside the same durable barrier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-durable-race-'))
    let writes = 0
    let queue!: SessionPersistenceQueue
    queue = new SessionPersistenceQueue(60_000, {
      afterTempWrite: () => {
        writes += 1
        if (writes === 1) queue.enqueue(makeStoredSession(root, 'durable-race', 'newer marker'))
      },
    })
    try {
      queue.enqueue(makeStoredSession(root, 'durable-race', 'older marker'))
      await queue.flushDurable('durable-race')

      expect(writes).toBe(2)
      const stored = readFileSync(getSessionFilePath(root, 'durable-race'), 'utf8')
      expect(stored).toContain('newer marker')
      expect(stored).not.toContain('older marker')
    } finally {
      queue.cancel('durable-race')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects the barrier when file sync fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'session-durable-failure-'))
    const queue = new SessionPersistenceQueue(60_000, {
      beforeFileSync: () => { throw new Error('synthetic fsync failure') },
    })
    try {
      queue.enqueue(makeStoredSession(root, 'durable-failure', 'must not dispatch'))
      await expect(queue.flushDurable('durable-failure')).rejects.toThrow('synthetic fsync failure')
    } finally {
      queue.cancel('durable-failure')
      rmSync(root, { recursive: true, force: true })
    }
  })
})
