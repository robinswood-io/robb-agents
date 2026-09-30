import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, renameSync, unlinkSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMPLETED_CHAT_RETENTION_MS as MONTH, archiveCompletedChatDirectory, canInjectCompletedChatContext, captureCompletedChatMemory, CompletedChatArchiveError, completedChatContext, hasProtectedChatWorktree, isCompletedChatDue, prepareCompletedChatArchive, readCompletedChatMemory, reconcileCompletedChatArchives, reopenCompletedChat } from './completed-chat-retention'
import { SessionManager, createManagedSession } from './SessionManager'
import { createSession, ensureSessionDir, getSessionFilePath, getSessionPath, loadSession, writeSessionJsonl, type StoredSession } from '@craft-agent/shared/sessions'
import * as config from '@craft-agent/shared/config'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'robb-retention-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const messages = [
  { id: '1', role: 'user' as const, content: 'Conserver la décision PostgreSQL pour le catalogue.', timestamp: 1 },
  { id: '2', role: 'assistant' as const, content: 'Décision : PostgreSQL. Livrable : schema.sql. Validation encore nécessaire.', timestamp: 2 },
]

describe('completed-chat memory and retention', () => {
  it.each(['question', 'queued-answer', 'auth-id', 'permission', 'active-objective', 'blocked-objective', 'exhausted-objective', 'stopping', 'queued-metadata'])(
    'preserves a legacy done chat with %s', async blocker => {
      const manager = new SessionManager(); const runtime = manager as any
      const managed = createManagedSession({ id: 'retained', name: 'Retained' },
        { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true })
      runtime.sessions.set(managed.id, managed); managed.sessionStatus = 'done'
      if (blocker === 'question') managed.userInputRequests = [{ status: 'pending', sessionId: managed.id }] as never
      if (blocker === 'queued-answer') {
        managed.userInputRequests = [{ status: 'answered', responseMessageId: 'answer' }] as never
        managed.messages = [{ id: 'answer', role: 'user', content: 'Blue', timestamp: 1, isQueued: true,
          internalOrigin: { kind: 'user-input' } }] as never
      }
      if (blocker === 'auth-id') managed.pendingAuthRequestId = 'auth'
      if (blocker === 'permission') runtime.pendingPermissionRequests.set('permission', { sessionId: managed.id })
      if (blocker.endsWith('objective')) managed.activeObjective = {
        terminalState: blocker === 'active-objective' ? 'active' : blocker === 'blocked-objective' ? 'blocked_human' : 'exhausted',
      } as never
      if (blocker === 'stopping') managed.stopRequested = true
      if (blocker === 'queued-metadata') managed.pendingQueuedMessageIds = ['pending']
      expect(runtime.canRetainCompletedChat(managed)).toBe(false)
      await manager.cleanup()
    },
  )

  it('does not let terminal or expired source-activation markers pin retention forever', async () => {
    const manager = new SessionManager(); const runtime = manager as any
    const managed = createManagedSession({ id: 'terminal-source-activation', name: 'Terminal marker' },
      { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true })
    runtime.sessions.set(managed.id, managed)
    managed.sessionStatus = 'done'
    managed.autoRetryPending = {
      cancelled: true,
      committed: true,
      dispatchInFlight: false,
      tombstoneExpiresAt: Date.now() + 60_000,
    } as never
    expect(runtime.canRetainCompletedChat(managed)).toBe(true)

    managed.autoRetryPending = {
      cancelled: false,
      committed: false,
      dispatchInFlight: false,
      tombstoneExpiresAt: Date.now() - 1,
    } as never
    expect(runtime.canRetainCompletedChat(managed)).toBe(true)
    expect(managed.autoRetryPending).toBeUndefined()
    await manager.cleanup()
  })

  it.each(['question', 'auth-id', 'active-objective', 'nested-auth-id'])(
    'preserves a done parent whose child still needs %s', async blocker => {
      const manager = new SessionManager(); const runtime = manager as any
      const workspace = { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 }
      const parent = createManagedSession({ id: 'parent', name: 'Parent' }, workspace as never, { messagesLoaded: true })
      const child = createManagedSession({ id: 'child', parentSessionId: parent.id }, workspace as never, { messagesLoaded: true })
      runtime.sessions.set(parent.id, parent); runtime.sessions.set(child.id, child); parent.sessionStatus = 'done'
      if (blocker === 'question') child.userInputRequests = [{ status: 'pending', sessionId: child.id }] as never
      if (blocker === 'auth-id') child.pendingAuthRequestId = 'auth'
      if (blocker === 'active-objective') child.activeObjective = { terminalState: 'active' } as never
      if (blocker === 'nested-auth-id') {
        child.activeObjective = { terminalState: 'complete_verified' } as never
        const grandchild = createManagedSession({ id: 'grandchild', parentSessionId: child.id }, workspace as never, { messagesLoaded: true })
        grandchild.pendingAuthRequestId = 'auth'; runtime.sessions.set(grandchild.id, grandchild)
      }
      expect(runtime.canRetainCompletedChat(parent)).toBe(false)
      await manager.cleanup()
    },
  )

  it('yields between skipped chats instead of monopolizing the event loop', async () => {
    const manager = new SessionManager(); const runtime = manager as any
    for (let i = 0; i < 50; i++) runtime.sessions.set(`active-${i}`, createManagedSession({ id: `active-${i}` },
      { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true }))
    let yielded = false; setImmediate(() => { yielded = true })
    await runtime.sweepCompletedChats()
    expect(yielded).toBe(true)
    await manager.cleanup()
  })

  it('allows a reopening accepted during the final flush to cancel deletion', async () => {
    const stored = await createSession(root, { name: 'Catalogue' })
    const manager = new SessionManager(); const runtime = manager as any
    const managed = createManagedSession(stored, { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true })
    managed.messages = messages; managed.sessionStatus = 'done'; managed.lastMessageAt = 2
    runtime.sessions.set(managed.id, managed)
    await runtime.sweepCompletedChats(1000)
    const flush = manager.flushSession.bind(manager); let once = false
    manager.flushSession = async id => {
      if (!once) { once = true; await manager.setSessionStatus(id, 'todo') }
      await flush(id)
    }
    await runtime.sweepCompletedChats(1000 + MONTH)
    expect(managed.sessionStatus).toBe('todo')
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
    expect(readCompletedChatMemory(root, managed.id)?.deletedAt).toBeUndefined()
    await manager.cleanup()
  })

  it('does not consume a latent retry timer or volatile admission before archival', async () => {
    const stored = await createSession(root, { name: 'Latent retry' })
    const manager = new SessionManager(); const runtime = manager as any
    const managed = createManagedSession(stored,
      { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true })
    managed.messages = messages
    managed.sessionStatus = 'done'
    managed.lastMessageAt = 2
    runtime.sessions.set(managed.id, managed)
    await runtime.sweepCompletedChats(1000)

    const latentTimer = setTimeout(() => {}, 60_000)
    latentTimer.unref?.()
    managed.autoRetryTimer = latentTimer
    runtime.automaticAdmissionReservations.add(managed.id)

    await runtime.sweepCompletedChats(1000 + MONTH)

    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
    expect(readCompletedChatMemory(root, managed.id)?.archivedAt).toBeUndefined()
    expect(managed.autoRetryTimer).toBe(latentTimer)
    expect(runtime.automaticAdmissionReservations.has(managed.id)).toBe(true)

    clearTimeout(latentTimer)
    managed.autoRetryTimer = undefined
    runtime.automaticAdmissionReservations.delete(managed.id)
    await runtime.sweepCompletedChats(1000 + MONTH)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
    expect(readCompletedChatMemory(root, managed.id)?.archivedAt).toBe(1000 + MONTH)
    await manager.cleanup()
  })

  it('recognizes nested git repositories and worktree pointer files', () => {
    expect(hasProtectedChatWorktree(root)).toBe(false)
    const repo = join(root, 'data', 'project')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, '.git'), 'gitdir: /some/existing/worktree')
    expect(hasProtectedChatWorktree(root)).toBe(true)
  })
  it('starts legacy retention now, is idempotent and expires exactly after 30 days', () => {
    const input = { id: 'old-chat', lastMessageAt: 1, messages }
    const first = captureCompletedChatMemory(root, input, 10_000)
    expect(isCompletedChatDue(first, 10_000 + MONTH - 1)).toBe(false)
    expect(isCompletedChatDue(first, 10_000 + MONTH)).toBe(true)
    expect(captureCompletedChatMemory(root, input, 20_000).completedAt).toBe(10_000)
    expect(readCompletedChatMemory(root, input.id)?.summary).toContain('PostgreSQL')
    expect(readCompletedChatMemory(root, input.id)?.summary).not.toContain('schema.sql')
  })

  it('reopening and changed content restart the retention period', () => {
    const input = { id: 'reopened', lastMessageAt: 1, messages }
    captureCompletedChatMemory(root, input, 10)
    reopenCompletedChat(root, input.id, 20)
    expect(isCompletedChatDue(readCompletedChatMemory(root, input.id)!, MONTH * 2)).toBe(false)
    expect(captureCompletedChatMemory(root, input, 30).completedAt).toBe(30)
    const changed = captureCompletedChatMemory(root, { ...input, messages: [...messages, { ...messages[0]!, id: '3' }] }, 40)
    expect(changed.completedAt).toBe(40)
  })

  it('retrieves relevant historical context only within the same project and excludes reopened chats', async () => {
    captureCompletedChatMemory(root, { id: 'a', projectId: 'project-a', lastMessageAt: 1, messages }, 10)
    const context = await completedChatContext(root, 'project-a', 'catalogue PostgreSQL', 'new-chat')
    expect(context).toContain('Conserver la décision PostgreSQL')
    expect(context).not.toContain('schema.sql')
    expect(await completedChatContext(root, 'project-b', 'catalogue PostgreSQL', 'new-chat')).toBe('')
    expect(await completedChatContext(root, undefined, 'PostgreSQL', 'new-chat')).toBe('')
    expect(await completedChatContext(root, 'project-a', 'catalogue PostgreSQL', 'a')).toBe('')
    reopenCompletedChat(root, 'a', 20)
    expect(await completedChatContext(root, 'project-a', 'catalogue PostgreSQL', 'new-chat')).toBe('')
  })

  it('requires a real project and a direct visible turn before context can be injected', () => {
    expect(canInjectCompletedChatContext('project-a')).toBe(true)
    expect(canInjectCompletedChatContext(undefined)).toBe(false)
    expect(canInjectCompletedChatContext('   ')).toBe(false)
    expect(canInjectCompletedChatContext('project-a', { hidden: true })).toBe(false)
    expect(canInjectCompletedChatContext('project-a', { internalOrigin: { kind: 'agent-message' } })).toBe(false)
    expect(canInjectCompletedChatContext('project-a', { automaticRecovery: { cause: 'runtime_error' } })).toBe(false)
  })

  it('captures only direct visible user turns and cannot retrieve assistant or internal contamination', async () => {
    const contaminated = [
      { id: 'direct', role: 'user' as const, content: 'Préparer la fiche produit Atlas.', timestamp: 1 },
      { id: 'assistant', role: 'assistant' as const, content: 'Référence interne Nebula Aurora.', timestamp: 2 },
      { id: 'hidden', role: 'user' as const, content: 'Nebula Aurora caché', timestamp: 3, hidden: true },
      { id: 'internal', role: 'user' as const, content: 'Nebula Aurora interne', timestamp: 4,
        internalOrigin: { kind: 'agent-message' as const } },
      { id: 'delivery', role: 'user' as const, content: 'Nebula Aurora livraison', timestamp: 5,
        agentDelivery: { id: 'delivery', status: 'processed' as const, attempts: 1 } },
      { id: 'recovery', role: 'user' as const,
        content: '<automatic_turn_recovery attempt="2">Nebula Aurora reprise</automatic_turn_recovery>', timestamp: 6 },
    ]
    const memory = captureCompletedChatMemory(root, {
      id: 'contaminated', projectId: 'project-a', lastMessageAt: 6, messages: contaminated,
    }, 10)
    expect(memory.retrievalVersion).toBe(2)
    expect(memory.directUserExcerpt).toBe('Préparer la fiche produit Atlas.')
    expect(memory.summary).not.toContain('Nebula')
    expect(await completedChatContext(root, 'project-a', 'Nebula Aurora', 'new-chat')).toBe('')
    expect(await completedChatContext(root, 'project-a', 'fiche produit Atlas', 'new-chat')).toContain('fiche produit Atlas')
  })

  it('rejects a single generic term but accepts a strong exact phrase', async () => {
    captureCompletedChatMemory(root, {
      id: 'phrase', projectId: 'project-a', lastMessageAt: 1,
      messages: [{ id: 'user', role: 'user', content: 'Merci de faire cette mise à jour pour Orion', timestamp: 1 }],
    }, 10)
    expect(await completedChatContext(root, 'project-a', 'audit', 'new-chat')).toBe('')
    expect(await completedChatContext(root, 'project-a', 'Orion', 'new-chat')).toBe('')
    expect(await completedChatContext(root, 'project-a', 'Merci de faire cette mise à jour pour Orion', 'new-chat')).toContain('Orion')
  })

  it('never injects legacy assistant-inclusive receipts and bounds the selected excerpt', async () => {
    const dir = join(root, 'memory', 'completed-chats'); mkdirSync(dir, { recursive: true })
    const legacyId = 'legacy-assistant-memory'
    writeFileSync(join(dir, `${createHash('sha256').update(legacyId).digest('hex')}.json`), JSON.stringify({
      version: 1, sessionId: legacyId, projectId: 'project-a', title: 'Legacy', completedAt: 1, lastActivityAt: 1,
      transcriptSha256: 'a'.repeat(64), summary: 'Nebula Aurora only appeared in an assistant turn.',
    }))
    expect(await completedChatContext(root, 'project-a', 'Nebula Aurora', 'new-chat')).toBe('')

    captureCompletedChatMemory(root, {
      id: 'bounded', projectId: 'project-a', lastMessageAt: 2,
      messages: [{ id: 'direct', role: 'user', content: `Atlas Catalogue ${'x'.repeat(2_000)}`, timestamp: 2 }],
    }, 2)
    const context = await completedChatContext(root, 'project-a', 'Atlas Catalogue', 'new-chat')
    const [selected] = JSON.parse(context.slice(context.indexOf('\n') + 1))
    expect(selected.excerpts.length).toBeLessThanOrEqual(800)
  })

  it('keeps only the best result across a thousand receipts while yielding to the event loop', async () => {
    const dir = join(root, 'memory', 'completed-chats'); mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 1000; i++) {
      const sessionId = `historical-${i}`
      writeFileSync(join(dir, `${createHash('sha256').update(sessionId).digest('hex')}.json`), JSON.stringify({
        version: 1, retrievalVersion: 2, sessionId, projectId: 'project-a', title: 'Catalogue',
        completedAt: i + 1, lastActivityAt: 1, transcriptSha256: 'a'.repeat(64),
        directUserExcerpt: 'Catalogue PostgreSQL decision.', summary: 'Catalogue PostgreSQL decision.',
      }))
    }
    let yielded = false; setImmediate(() => { yielded = true })
    const context = await completedChatContext(root, 'project-a', 'catalogue PostgreSQL', 'new-chat')
    expect(yielded).toBe(true)
    const selected = JSON.parse(context.slice(context.indexOf('\n') + 1))
    expect(selected.map((memory: any) => memory.sessionId)).toEqual(['historical-999'])
  })

  it('skips oversized, misidentified and symlink receipts without injecting their content', async () => {
    const dir = join(root, 'memory', 'completed-chats'); mkdirSync(dir, { recursive: true })
    const memory = { version: 1, retrievalVersion: 2, sessionId: 'actual', projectId: 'project-a', title: 'Catalogue',
      completedAt: 1, lastActivityAt: 1, transcriptSha256: 'a'.repeat(64),
      directUserExcerpt: 'Catalogue PostgreSQL', summary: 'Catalogue PostgreSQL' }
    const path = (id: string) => join(dir, `${createHash('sha256').update(id).digest('hex')}.json`)
    writeFileSync(path('wrong-id'), JSON.stringify(memory))
    writeFileSync(path('large'), JSON.stringify({ ...memory, sessionId: 'large',
      directUserExcerpt: 'Catalogue PostgreSQL' + 'x'.repeat(100_000), summary: 'Catalogue PostgreSQL' + 'x'.repeat(100_000) }))
    const target = join(root, 'external.json'); writeFileSync(target, JSON.stringify(memory))
    symlinkSync(target, path('actual'))
    expect(await completedChatContext(root, 'project-a', 'catalogue PostgreSQL', 'new-chat')).toBe('')
  })

  it('fails closed on a corrupted receipt instead of replacing deletion evidence', async () => {
    const input = { id: 'a', projectId: 'project-a', lastMessageAt: 1, messages }
    captureCompletedChatMemory(root, input, 10)
    const dir = join(root, 'memory', 'completed-chats')
    writeFileSync(join(dir, readdirSync(dir)[0]!), '{broken')
    expect(() => captureCompletedChatMemory(root, input, MONTH * 2)).toThrow()
    expect(await completedChatContext(root, 'project-a', 'catalogue PostgreSQL', 'new-chat')).toBe('')
  })

  it('archives the complete chat after 30 days, preserves PDF bytes, and supports restoration', async () => {
    const stored = await createSession(root, { name: 'Catalogue', projectId: 'project-a' })
    const sessionPath = getSessionPath(root, stored.id)
    const attachmentPath = join(sessionPath, 'data', 'deliverable.pdf')
    mkdirSync(join(sessionPath, 'data'), { recursive: true })
    writeFileSync(attachmentPath, Buffer.from('%PDF-1.7\nfixture deliverable\n%%EOF\n'))
    const originalHash = createHash('sha256').update(readFileSync(attachmentPath)).digest('hex')
    const manager = new SessionManager()
    const managed = createManagedSession(stored, { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true })
    managed.messages = messages
    managed.sessionStatus = 'done'
    managed.lastMessageAt = 2
    const internal = manager as unknown as { sessions: Map<string, typeof managed>; sweepCompletedChats: (now: number) => Promise<void> }
    internal.sessions.set(managed.id, managed)
    await internal.sweepCompletedChats(1000)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
    managed.isProcessing = true
    await internal.sweepCompletedChats(1000 + MONTH)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(true)
    managed.isProcessing = false
    await internal.sweepCompletedChats(1000 + MONTH)
    expect(existsSync(getSessionPath(root, managed.id))).toBe(false)
    const archived = readCompletedChatMemory(root, managed.id)!
    expect(archived.archivedAt).toBe(1000 + MONTH)
    expect(archived.deletedAt).toBeUndefined()
    expect(isCompletedChatDue(archived, MONTH * 100)).toBe(false)
    expect(createHash('sha256').update(readFileSync(join(archived.archivePath!, 'data', 'deliverable.pdf'))).digest('hex')).toBe(originalHash)
    const context = await completedChatContext(root, 'project-a', 'catalogue PostgreSQL', 'new-chat')
    expect(context).toContain('Conserver la décision PostgreSQL')
    expect(context).not.toContain('schema.sql')
    await internal.sweepCompletedChats(MONTH * 100)
    expect(existsSync(archived.archivePath!)).toBe(true)
    renameSync(archived.archivePath!, sessionPath)
    expect(readFileSync(attachmentPath).toString()).toContain('%PDF-1.7')
    await manager.cleanup()
  })

  it('archives the captured physical workspace after its logical alias is retargeted', async () => {
    if (process.platform === 'win32') return
    const rootA = join(root, 'workspace-a')
    const rootB = join(root, 'workspace-b')
    const alias = join(root, 'workspace-alias')
    mkdirSync(rootA, { recursive: true })
    mkdirSync(rootB, { recursive: true })
    symlinkSync(rootA, alias, 'dir')

    const storedA = await createSession(alias, { name: 'Archive target A', projectId: 'project-a' })
    const storedB: StoredSession = {
      ...storedA,
      workspaceRootPath: rootB,
      name: 'Homonymous B must survive',
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    }
    ensureSessionDir(rootB, storedA.id)
    writeSessionJsonl(getSessionFilePath(rootB, storedA.id), storedB)

    const manager = new SessionManager()
    const managed = createManagedSession(
      storedA,
      { id: 'ws', name: 'Alias', rootPath: alias, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    managed.messages = messages
    managed.sessionStatus = 'done'
    managed.lastMessageAt = 2
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      sweepCompletedChats: (now: number) => Promise<void>
    }
    runtime.sessions.set(managed.id, managed)
    const physicalRootA = realpathSync.native(rootA)
    expect(managed.persistenceRootPath).toBe(physicalRootA)

    await runtime.sweepCompletedChats(1000)
    expect(readCompletedChatMemory(rootA, managed.id)).toBeDefined()
    expect(readCompletedChatMemory(rootB, managed.id)).toBeUndefined()

    unlinkSync(alias)
    symlinkSync(rootB, alias, 'dir')
    await runtime.sweepCompletedChats(1000 + MONTH)

    const archived = readCompletedChatMemory(rootA, managed.id)!
    expect(archived.archivePath?.startsWith(join(physicalRootA, 'archives', 'completed-chats'))).toBe(true)
    expect(existsSync(getSessionPath(rootA, managed.id))).toBe(false)
    expect(loadSession(rootB, managed.id)?.name).toBe('Homonymous B must survive')
    expect(readCompletedChatMemory(rootB, managed.id)).toBeUndefined()
    expect(runtime.sessions.has(managed.id)).toBe(false)
    await manager.cleanup()
  })

  it('finalizes a durable archive intent after restart when the live session already moved', async () => {
    const stored = await createSession(root, { name: 'Crash after archive move', projectId: 'project-a' })
    const sessionPath = getSessionPath(root, stored.id)
    const memory = captureCompletedChatMemory(root, {
      id: stored.id,
      name: stored.name,
      projectId: stored.projectId,
      lastMessageAt: 2,
      messages,
    }, 1000)
    const planned = prepareCompletedChatArchive(root, memory, 1000 + MONTH)
    const targetPath = planned.archiveIntent!.targetPath

    archiveCompletedChatDirectory(root, sessionPath, stored.id, targetPath, planned.archiveIntent)
    expect(archiveCompletedChatDirectory(root, sessionPath, stored.id, targetPath, planned.archiveIntent)).toBe(targetPath)
    expect(readCompletedChatMemory(root, stored.id)?.archiveIntent?.targetPath).toBe(targetPath)
    expect(existsSync(sessionPath)).toBe(false)
    expect(existsSync(targetPath)).toBe(true)

    // Simulate startup of a new manager. The disk scan cannot load the moved
    // session, so reconciliation must use the workspace receipt alone.
    const restarted = new SessionManager()
    const runtime = restarted as unknown as {
      sessions: Map<string, ReturnType<typeof createManagedSession>>
      loadSessionsFromDisk: () => void
    }
    const workspaces = spyOn(config, 'getWorkspaces').mockReturnValue([{
      id: 'ws',
      slug: 'test',
      name: 'Test',
      rootPath: root,
      createdAt: 1,
    }] as never)
    try {
      runtime.loadSessionsFromDisk()
    } finally {
      workspaces.mockRestore()
    }

    const finalized = readCompletedChatMemory(root, stored.id)!
    expect(finalized.archiveIntent).toBeUndefined()
    expect(finalized.archivedAt).toBe(1000 + MONTH)
    expect(finalized.archivePath).toBe(targetPath)
    expect(runtime.sessions.has(stored.id)).toBe(false)
    expect(existsSync(sessionPath)).toBe(false)
    expect(existsSync(targetPath)).toBe(true)
    await restarted.cleanup()
  })

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

    const restarted = new SessionManager()
    const managed = createManagedSession(
      stored,
      { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    managed.messages = messages
    managed.sessionStatus = 'done'
    managed.lastMessageAt = 2
    const runtime = restarted as unknown as {
      sessions: Map<string, typeof managed>
      sweepCompletedChats: (now: number) => Promise<void>
    }
    runtime.sessions.set(managed.id, managed)
    await runtime.sweepCompletedChats(1000 + MONTH)

    const finalized = readCompletedChatMemory(root, stored.id)!
    expect(finalized.archiveIntent).toBeUndefined()
    expect(finalized.archivePath).toBe(targetPath)
    expect(finalized.archivedAt).toBe(1000 + MONTH)
    expect(existsSync(getSessionPath(root, stored.id))).toBe(false)
    expect(existsSync(targetPath)).toBe(true)
    expect(runtime.sessions.has(stored.id)).toBe(false)
    await restarted.cleanup()
  })

  it('finalizes the retention receipt when the archive move committed before reporting an error', async () => {
    const stored = await createSession(root, { name: 'Committed archive receipt', projectId: 'project-a' })
    const sessionPath = getSessionPath(root, stored.id)
    let archivePath: string | undefined
    const manager = new SessionManager()
    const managed = createManagedSession(
      stored,
      { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never,
      { messagesLoaded: true },
    )
    managed.messages = messages
    managed.sessionStatus = 'done'
    managed.lastMessageAt = 2
    const runtime = manager as unknown as {
      sessions: Map<string, typeof managed>
      sweepCompletedChats: (
        now: number,
        archiveChat?: typeof archiveCompletedChatDirectory,
      ) => Promise<void>
    }
    runtime.sessions.set(managed.id, managed)

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
    expect(runtime.sessions.has(managed.id)).toBe(false)
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
    const manager = new SessionManager(); const runtime = manager as any
    const managed = createManagedSession(stored, { id: 'ws', name: 'Test', rootPath: root, createdAt: 1 } as never, { messagesLoaded: true })
    managed.messages = messages; managed.sessionStatus = 'done'; managed.lastMessageAt = 2
    runtime.sessions.set(managed.id, managed)
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
})
