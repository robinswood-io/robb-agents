import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredSession } from '../types'
import { getSessionFilePath, listSessions, loadSession, saveSession } from '../storage'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `session-recovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeStoredSession(workspaceRootPath: string, id: string): StoredSession {
  return {
    id,
    workspaceRootPath,
    createdAt: 1000,
    lastUsedAt: 1000,
    messages: [
      {
        id: 'msg-1',
        type: 'user',
        content: 'hello from a recovered chat',
        timestamp: 1000,
      },
    ],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

describe('session storage interrupted write recovery', () => {
  let workspaceRoot: string | null = null

  afterEach(() => {
    if (workspaceRoot && existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
    workspaceRoot = null
  })

  it('promotes a complete tmp jsonl when the primary file is missing', async () => {
    workspaceRoot = makeTmpDir()
    await saveSession(makeStoredSession(workspaceRoot, 'session-1'))

    const sessionFile = getSessionFilePath(workspaceRoot, 'session-1')
    const tmpFile = `${sessionFile}.tmp`
    renameSync(sessionFile, tmpFile)

    const sessions = listSessions(workspaceRoot)
    expect(sessions.map(session => session.id)).toContain('session-1')
    expect(existsSync(sessionFile)).toBe(true)
    expect(existsSync(tmpFile)).toBe(false)

    const loaded = loadSession(workspaceRoot, 'session-1')
    expect(loaded?.messages[0]?.content).toBe('hello from a recovered chat')
  })

  it('keeps the primary jsonl when both primary and stale tmp exist', async () => {
    workspaceRoot = makeTmpDir()
    await saveSession(makeStoredSession(workspaceRoot, 'session-2'))

    const sessionFile = getSessionFilePath(workspaceRoot, 'session-2')
    const tmpFile = `${sessionFile}.tmp`
    await saveSession(makeStoredSession(workspaceRoot, 'session-2'))
    renameSync(sessionFile, tmpFile)
    await saveSession(makeStoredSession(workspaceRoot, 'session-2'))

    const sessions = listSessions(workspaceRoot)
    expect(sessions.map(session => session.id)).toContain('session-2')
    expect(existsSync(sessionFile)).toBe(true)
    expect(existsSync(tmpFile)).toBe(false)
  })
})
