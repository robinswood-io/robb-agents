import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { withSessionOperationsForTest } from "./testing/session-operation-access.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPLETED_CHAT_RETENTION_MS as MONTH, archiveCompletedChatDirectory, captureCompletedChatMemory, CompletedChatArchiveError, isCompletedChatDue, prepareCompletedChatArchive, readCompletedChatMemory, reconcileCompletedChatArchives } from "./completed-chat-retention";
import { SessionManager, createManagedSession } from "./SessionManager";
import { createSession, getSessionPath } from "@craft-agent/shared/sessions";
import { messages } from "./testing/completed-chat-retention-fixture.ts";

let root: string

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'robb-retention-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('completed-chat memory and retention', () => {
  it('reuses an intent whose move never started and completes it on the next manager sweep', async () => {
    const stored = await createSession(root, { name: 'Crash before archive move', projectId: 'project-a' })
    const memory = captureCompletedChatMemory(root, {
      id: stored.id,
      name: stored.name,
      projectId: stored.projectId,
      lastMessageAt: 2,
      messages,
    }, 1000)
    const planned = prepareCompletedChatArchive(root, memory, 1000 + MONTH)
    const targetPath = planned.archiveIntent!.targetPath
    expect(reconcileCompletedChatArchives(root)).toMatchObject({
      finalized: [],
      pending: [stored.id],
      errors: [],
    })

    const restarted = withSessionOperationsForTest(new SessionManager())
    const managed = createManagedSession(
      stored,
      { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    managed.messages = messages
    managed.sessionStatus = 'done'
    managed.lastMessageAt = 2
    const runtime = sessionManagerForTest(restarted)
    sessionRuntimeStateForTest(restarted).sessions.set(managed.id, managed)
    await runtime.sweepCompletedChats(1000 + MONTH)

    const finalized = readCompletedChatMemory(root, stored.id)!
    expect(finalized.archiveIntent).toBeUndefined()
    expect(finalized.archivePath).toBe(targetPath)
    expect(finalized.archivedAt).toBe(1000 + MONTH)
    expect(existsSync(getSessionPath(root, stored.id))).toBe(false)
    expect(existsSync(targetPath)).toBe(true)
    expect(sessionRuntimeStateForTest(restarted).sessions.has(stored.id)).toBe(false)
    await restarted.cleanup()
  })

  it('finalizes the retention receipt when the archive move committed before reporting an error', async () => {
    const stored = await createSession(root, { name: 'Committed archive receipt', projectId: 'project-a' })
    const sessionPath = getSessionPath(root, stored.id)
    let archivePath: string | undefined
    const manager = withSessionOperationsForTest(new SessionManager())
    const managed = createManagedSession(
      stored,
      { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    managed.messages = messages
    managed.sessionStatus = 'done'
    managed.lastMessageAt = 2
    const runtime = sessionManagerForTest(manager)
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)

    await runtime.sweepCompletedChats(1000)
    await runtime.sweepCompletedChats(1000 + MONTH, (_root, source, _id, plannedTarget) => {
      archivePath = plannedTarget!
      renameSync(source, archivePath)
      throw new CompletedChatArchiveError(
        'fixture durability publication failed after rename',
        true,
        archivePath,
      )
    })

    const receipt = readCompletedChatMemory(root, managed.id)!
    expect(receipt.archivedAt).toBe(1000 + MONTH)
    expect(receipt.archivePath).toBe(archivePath!)
    expect(isCompletedChatDue(receipt, MONTH * 100)).toBe(false)
    expect(existsSync(sessionPath)).toBe(false)
    expect(existsSync(archivePath!)).toBe(true)
    expect(sessionRuntimeStateForTest(manager).sessions.has(managed.id)).toBe(false)
    await manager.cleanup()
  })

  it('keeps the full source directory when archive publication cannot start', async () => {
    const stored = await createSession(root, { name: 'Preserved' })
    const sessionPath = getSessionPath(root, stored.id)
    const before = readFileSync(join(sessionPath, 'session.jsonl'))
    writeFileSync(join(root, 'archives'), 'A conflicting ordinary file must not be replaced')
    expect(() => archiveCompletedChatDirectory(root, sessionPath, stored.id)).toThrow('real directory')
    expect(readFileSync(join(sessionPath, 'session.jsonl'))).toEqual(before)
    expect(readFileSync(join(root, 'archives'), 'utf8')).toContain('must not be replaced')
  })

  it('restores and fsyncs both parents if durability publication fails after the atomic move', () => {
    const source = join(root, 'source'); mkdirSync(source)
    writeFileSync(join(source, 'deliverable.pdf'), 'preserved bytes')
    const barriers: string[][] = []
    expect(() => archiveCompletedChatDirectory(root, source, 'fixture', undefined, undefined, paths => {
      barriers.push(paths)
      if (barriers.length === 1) throw new Error('fixture forward durability failure')
    })).toThrow('fixture forward durability failure')
    expect(readFileSync(join(source, 'deliverable.pdf'), 'utf8')).toBe('preserved bytes')
    expect(readdirSync(join(root, 'archives', 'completed-chats'))).toEqual([])
    expect(barriers).toHaveLength(2)
    expect(barriers[1]).toEqual(barriers[0])
  })

  it('does not move a replacement source whose inode differs from the durable archive intent', async () => {
    const stored = await createSession(root, { name: 'Sealed source identity', projectId: 'project-a' })
    const sessionPath = getSessionPath(root, stored.id)
    const memory = captureCompletedChatMemory(root, {
      id: stored.id,
      name: stored.name,
      projectId: stored.projectId,
      lastMessageAt: 2,
      messages,
    }, 1000)
    const planned = prepareCompletedChatArchive(root, memory, 1000 + MONTH)
    const intent = planned.archiveIntent!
    const preservedOriginal = join(root, 'preserved-original-session')
    renameSync(sessionPath, preservedOriginal)
    mkdirSync(sessionPath)
    writeFileSync(join(sessionPath, 'replacement.txt'), 'replacement must remain live')

    expect(() => archiveCompletedChatDirectory(
      root,
      sessionPath,
      stored.id,
      intent.targetPath,
      intent,
    )).toThrow('source identity does not match')

    expect(readFileSync(join(sessionPath, 'replacement.txt'), 'utf8')).toBe('replacement must remain live')
    expect(existsSync(intent.targetPath)).toBe(false)
    expect(existsSync(preservedOriginal)).toBe(true)
  })

  it('accepts legacy v1 receipts but rejects archive targets outside the workspace archive root', () => {
    const legacy = captureCompletedChatMemory(root, {
      id: 'legacy-v1',
      projectId: 'project-a',
      lastMessageAt: 1,
      messages,
    }, 10)
    expect(legacy.version).toBe(1)
    expect(readCompletedChatMemory(root, legacy.sessionId)).toEqual(legacy)

    const receiptPath = join(
      root,
      'memory',
      'completed-chats',
      `${createHash('sha256').update(legacy.sessionId).digest('hex')}.json`,
    )
    writeFileSync(receiptPath, JSON.stringify({
      ...legacy,
      archiveIntent: {
        version: 1,
        targetPath: join(root, 'outside-archives', 'attacker-controlled'),
        archivedAt: MONTH,
        sourceDevice: '1',
        sourceInode: '1',
      },
    }))
    expect(() => readCompletedChatMemory(root, legacy.sessionId)).toThrow('Invalid completed-chat archive target')
  })

  it('never automatically archives a chat containing a worktree', async () => {
    const stored = await createSession(root, { name: 'Protected worktree' })
    const manager = withSessionOperationsForTest(new SessionManager()); const runtime = sessionManagerForTest(manager)
    const managed = createManagedSession(stored, { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true })
    managed.messages = messages; managed.sessionStatus = 'done'; managed.lastMessageAt = 2
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
    const sessionPath = getSessionPath(root, managed.id)
    const worktree = join(sessionPath, 'data', 'project'); mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: /fixture/preserved-worktree')
    await runtime.sweepCompletedChats(1000)
    await runtime.sweepCompletedChats(1000 + MONTH)
    expect(existsSync(sessionPath)).toBe(true)
    expect(readCompletedChatMemory(root, managed.id)?.archivedAt).toBeUndefined()
    expect(existsSync(join(root, 'archives'))).toBe(false)
    await manager.cleanup()
  })
});
