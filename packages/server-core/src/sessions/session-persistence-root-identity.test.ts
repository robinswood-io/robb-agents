import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  ensureSessionDir,
  getSessionFilePath,
  getSessionPath,
  loadSession,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions'
import {
  appendProjectMemoryEntry,
  createProject,
  getProjectMemoryJournalPath,
  loadProjectMemoryJournal,
  saveProjectConfig,
} from '@craft-agent/shared/projects'
import { SessionManager, createManagedSession, loadPiTurnAnchors } from './SessionManager'

const roots: string[] = []
const managers: SessionManager[] = []
const originalFetch = globalThis.fetch
type Managed = ReturnType<typeof createManagedSession>
interface IdentityTestRuntime {
  sessions: Map<string, Managed>
  persistSession: (managed: Managed) => boolean
  processEvent: (managed: Managed, event: unknown) => Promise<void>
  runtimeProcessingGenerations: WeakMap<object, number>
  runtimeToolAdmissionBindings: WeakMap<object, unknown>
  objectiveAuthorityEpochs: WeakMap<Managed, number>
  durablyRecordAutomaticRecoveryToolAdmission: (
    managed: Managed,
    runtimeAgent: object,
    request: { toolUseId?: string; toolName: string; toolInput: Record<string, unknown> },
  ) => Promise<void>
  captureUserCorrection: (managed: Managed, message: Managed['messages'][number]) => Promise<void>
  captureSessionTerminalLearning: (
    managed: Managed,
    state: 'complete_verified' | 'blocked_human' | 'blocked_policy' | 'exhausted' | 'cancelled',
  ) => Promise<void>
  handleSessionProjectLearning: (
    managed: Managed,
    request: {
      action: 'propose' | 'validate' | 'revoke' | 'list'
      id?: string
      content?: string
      evidenceIds?: string[]
      reviewToolUseId?: string
      kind?: 'procedure' | 'observation'
    },
  ) => Promise<unknown>
  loadSessionProjectMemoryContext: (managed: Managed, query: string) => Promise<string | null>
  loadSessionPlaybook: (managed: Managed) => { instructions: string } | null
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(managers.splice(0).map(manager => manager.cleanup()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function storedFixture(root: string, id: string, name: string, content: string): StoredSession {
  const stored: StoredSession = {
    id,
    workspaceRootPath: root,
    name,
    createdAt: 1,
    lastUsedAt: 1,
    lastMessageAt: 1,
    messages: [{ id: `${id}-${name}`, type: 'user', content, timestamp: 1 } as never],
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
  }
  ensureSessionDir(root, id)
  writeSessionJsonl(getSessionFilePath(root, id), stored)
  return stored
}

function retargetFixture(label: string) {
  const container = mkdtempSync(join(tmpdir(), `robb-root-identity-${label}-`))
  roots.push(container)
  const rootA = join(container, 'workspace-a')
  const rootB = join(container, 'workspace-b')
  const alias = join(container, 'workspace-alias')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
  symlinkSync(rootA, alias, 'dir')
  return {
    container,
    rootA,
    rootB,
    alias,
    retarget: () => {
      unlinkSync(alias)
      symlinkSync(rootB, alias, 'dir')
    },
  }
}

function register(
  manager: SessionManager,
  stored: StoredSession,
  alias: string,
  messagesLoaded: boolean,
) {
  const { messages: _messages, ...metadata } = stored
  const managed = createManagedSession(
    metadata,
    { id: `workspace-${stored.id}`, name: 'Aliased workspace', rootPath: alias, createdAt: 1 } as never,
    { messagesLoaded },
  )
  const runtime = manager as unknown as IdentityTestRuntime
  runtime.sessions.set(managed.id, managed)
  return { managed, runtime }
}

function registerProjectSession(label: string) {
  const fixture = retargetFixture(label)
  const capturedProject = createProject(fixture.rootA, { name: 'Captured project A' })
  const replacementProject = {
    ...capturedProject,
    slug: `replacement-project-b-${label}`,
    name: 'Replacement project B',
  }
  saveProjectConfig(fixture.rootB, replacementProject)
  const stored = storedFixture(fixture.alias, `project-session-${label}`, 'Project session A', 'project-content-a')
  stored.projectId = capturedProject.id
  const manager = new SessionManager()
  managers.push(manager)
  const registered = register(manager, stored, fixture.alias, true)
  registered.managed.projectId = capturedProject.id
  fixture.retarget()
  return { fixture, capturedProject, replacementProject, manager, ...registered }
}

describe('managed session physical persistence root', () => {
  it('hydrates, updates metadata and persists pending-plan state only in the captured root', async () => {
    if (process.platform === 'win32') return
    const fixture = retargetFixture('cold')
    const id = 'same-session'
    const storedA = storedFixture(fixture.alias, id, 'Transcript A', 'content-from-a')
    storedFixture(fixture.rootB, id, 'Transcript B', 'content-from-b')
    const replacementFile = getSessionFilePath(fixture.rootB, id)
    const replacementBytes = readFileSync(replacementFile, 'utf8')
    const manager = new SessionManager()
    managers.push(manager)
    const { managed } = register(manager, storedA, fixture.alias, false)
    fixture.retarget()

    const session = await manager.getSession(id)
    expect(session?.messages.map(message => message.content)).toEqual(['content-from-a'])
    expect(manager.getSessionPath(id)).toBe(getSessionPath(managed.persistenceRootPath, id))

    await manager.markSessionUnread(id)
    await manager.setPendingPlanExecution(id, '/plans/captured-root.md', 'draft-a')

    expect(loadSession(fixture.rootA, id)?.hasUnread).toBe(true)
    expect(loadSession(fixture.rootA, id)?.pendingPlanExecution?.planPath).toBe('/plans/captured-root.md')
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)
    expect(loadSession(fixture.rootB, id)?.name).toBe('Transcript B')

    let acknowledgedMessageId: string | undefined
    await manager.sendMessage(
      id,
      'fresh-user-message-for-a',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      messageId => { acknowledgedMessageId = messageId },
    ).catch(() => { /* the minimal fixture intentionally has no provider platform */ })
    expect(acknowledgedMessageId).toBeDefined()
    expect(loadSession(fixture.rootA, id)?.messages.some(message => (
      message.id === acknowledgedMessageId && message.content === 'fresh-user-message-for-a'
    ))).toBe(true)
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)
  })

  it('shares the captured transcript and writes the share receipt only beside it', async () => {
    if (process.platform === 'win32') return
    const fixture = retargetFixture('share')
    const id = 'shared-session'
    const storedA = storedFixture(fixture.alias, id, 'Share A', 'share-content-a')
    storedFixture(fixture.rootB, id, 'Share B', 'share-content-b')
    const replacementFile = getSessionFilePath(fixture.rootB, id)
    const replacementBytes = readFileSync(replacementFile, 'utf8')
    const manager = new SessionManager()
    managers.push(manager)
    register(manager, storedA, fixture.alias, true)
    fixture.retarget()

    let uploaded: StoredSession | undefined
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      uploaded = JSON.parse(String(init?.body)) as StoredSession
      return new Response(JSON.stringify({
        id: 'captured-share',
        url: 'https://viewer.invalid/captured-share',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    await expect(manager.shareToViewer(id)).resolves.toEqual({
      success: true,
      url: 'https://viewer.invalid/captured-share',
    })
    expect(uploaded?.name).toBe('Share A')
    expect(uploaded?.messages[0]?.content).toBe('share-content-a')
    expect(loadSession(fixture.rootA, id)?.sharedId).toBe('captured-share')
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)
  })

  it('persists agent-delivery attachment sidecars only in the captured recipient root', async () => {
    if (process.platform === 'win32') return
    const fixture = retargetFixture('attachment')
    const senderStored = storedFixture(fixture.alias, 'sender', 'Sender A', 'sender-a')
    const targetStored = storedFixture(fixture.alias, 'target', 'Target A', 'target-a')
    storedFixture(fixture.rootB, 'target', 'Target B', 'target-b')
    const replacementFile = getSessionFilePath(fixture.rootB, 'target')
    const replacementBytes = readFileSync(replacementFile, 'utf8')
    const attachment = join(fixture.container, 'proof.txt')
    writeFileSync(attachment, 'captured attachment')
    const manager = new SessionManager()
    managers.push(manager)
    const sender = register(manager, senderStored, fixture.alias, true).managed
    const target = register(manager, targetStored, fixture.alias, true).managed
    fixture.retarget()

    manager.sendMessage = (async (
      _sessionId: string,
      _message: string,
      _attachments: unknown,
      _storedAttachments: unknown,
      _options: unknown,
      _existingMessageId: unknown,
      _isAuthRetry: unknown,
      onAck?: (messageId: string) => void,
    ) => { onAck?.('captured-delivery') }) as typeof manager.sendMessage
    const runtime = manager as unknown as {
      sendAgentMessageToSession: (
        source: typeof sender,
        recipient: typeof target,
        message: string,
        attachments: Array<{ path: string }>,
        messageType: 'progress',
        validateAttachmentPath: (path: string) => Promise<string>,
      ) => Promise<unknown>
    }

    await runtime.sendAgentMessageToSession(
      sender,
      target,
      'deliver captured proof',
      [{ path: attachment }],
      'progress',
      async path => path,
    )

    const capturedAttachments = join(getSessionPath(fixture.rootA, target.id), 'attachments')
    expect(readdirSync(capturedAttachments).some(name => name.startsWith('delivery-'))).toBe(true)
    const replacementAttachments = join(getSessionPath(fixture.rootB, target.id), 'attachments')
    expect(existsSync(replacementAttachments)
      ? readdirSync(replacementAttachments).some(name => name.startsWith('delivery-'))
      : false).toBe(false)
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)
  })

  it('writes provider turn-anchor sidecars only below the captured root', async () => {
    if (process.platform === 'win32') return
    const fixture = retargetFixture('turn-anchor')
    const id = 'anchor-session'
    const storedA = storedFixture(fixture.alias, id, 'Anchor A', 'anchor-a')
    storedFixture(fixture.rootB, id, 'Anchor B', 'anchor-b')
    const replacementFile = getSessionFilePath(fixture.rootB, id)
    const replacementBytes = readFileSync(replacementFile, 'utf8')
    const manager = new SessionManager()
    managers.push(manager)
    const { managed, runtime } = register(manager, storedA, fixture.alias, true)
    managed.piSdkMessageToCraftMessage = new Map([['sdk-message-a', 'craft-message-a']])
    fixture.retarget()

    await runtime.processEvent(managed, {
      type: 'pi_turn_anchor',
      sdkMessageId: 'sdk-message-a',
      sdkTurnAnchor: 'entry-a',
    })

    const capturedSessionPath = getSessionPath(fixture.rootA, id)
    expect((await loadPiTurnAnchors(capturedSessionPath)).anchors['craft-message-a']).toBe('entry-a')
    const replacementSessionPath = getSessionPath(fixture.rootB, id)
    expect((await loadPiTurnAnchors(replacementSessionPath)).anchors['craft-message-a']).toBeUndefined()
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)
  })

  it('authorizes and durably records a tool only against the captured transcript', async () => {
    if (process.platform === 'win32') return
    const fixture = retargetFixture('tool-admission')
    const id = 'admission-session'
    const storedA = storedFixture(fixture.alias, id, 'Admission A', 'objective-a')
    const manager = new SessionManager()
    managers.push(manager)
    const { managed, runtime } = register(manager, storedA, fixture.alias, true)
    const userMessage = {
      id: `${id}-user`,
      role: 'user' as const,
      content: 'Inspect the captured workspace.',
      timestamp: 10,
    }
    managed.messages = [userMessage]
    managed.activeObjective = {
      schemaVersion: 1,
      objectiveId: userMessage.id,
      userMessageId: userMessage.id,
      originalText: userMessage.content,
      startedAt: 10,
      budgetBaselineUsd: 0,
      tokenBaseline: 0,
      continuationCount: 0,
      orchestrationMode: 'direct',
      risk: 'standard',
      completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'active',
    }
    runtime.persistSession(managed)
    await manager.flushSession(id)

    storedFixture(fixture.rootB, id, 'Admission B', 'different-boundary-b')
    const replacementFile = getSessionFilePath(fixture.rootB, id)
    const replacementBytes = readFileSync(replacementFile, 'utf8')
    fixture.retarget()

    const runtimeAgent = { isProcessing: () => true, dispose: async () => {} }
    managed.agent = runtimeAgent as never
    managed.isProcessing = true
    managed.processingGeneration = 7
    runtime.runtimeProcessingGenerations.set(runtimeAgent, 7)
    runtime.runtimeToolAdmissionBindings.set(runtimeAgent, {
      managed,
      sessionId: id,
      generation: 7,
      activeObjective: managed.activeObjective,
      authorityEpoch: runtime.objectiveAuthorityEpochs.get(managed) ?? 0,
      userMessage,
      userMessageId: userMessage.id,
      lastSentOptions: managed.lastSentOptions,
      automaticRecovery: undefined,
      pendingTurnRecovery: undefined,
      recoveryDispatch: undefined,
    })

    await runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'captured-tool-use',
      toolName: 'Read',
      toolInput: { file_path: '/captured/proof.txt' },
    })

    const durableA = loadSession(fixture.rootA, id)
    expect(durableA?.messages.some(message => (
      message.type === 'tool'
      && message.toolUseId === 'captured-tool-use'
      && message.toolStatus === 'executing'
    ))).toBe(true)
    expect(readFileSync(replacementFile, 'utf8')).toBe(replacementBytes)

    managed.isProcessing = false
    managed.agent = null
  })

  it('captures a user correction only in the project from the captured root', async () => {
    if (process.platform === 'win32') return
    const { fixture, capturedProject, replacementProject, managed, runtime } = registerProjectSession('correction')
    const objective = { id: 'objective-a', role: 'user' as const, content: 'Explain the captured configuration.', timestamp: 10 }
    const answer = { id: 'answer-a', role: 'assistant' as const, content: 'The value is blue.', timestamp: 11 }
    const correction = { id: 'correction-a', role: 'user' as const, content: 'Correction: the captured value is amber.', timestamp: 12 }
    managed.messages = [objective, answer, correction]
    managed.activeObjective = {
      schemaVersion: 1,
      objectiveId: objective.id,
      userMessageId: objective.id,
      originalText: objective.content,
      startedAt: objective.timestamp,
      budgetBaselineUsd: 0,
      tokenBaseline: 0,
      continuationCount: 0,
      orchestrationMode: 'direct',
      risk: 'standard',
      completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'active',
    }

    await runtime.captureUserCorrection(managed, correction)

    const entries = loadProjectMemoryJournal(fixture.rootA, capturedProject.slug, { strict: true }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toContain('captured value is amber')
    expect(existsSync(getProjectMemoryJournalPath(fixture.rootA, replacementProject.slug))).toBe(false)
    expect(existsSync(getProjectMemoryJournalPath(fixture.rootB, replacementProject.slug))).toBe(false)
  })

  it('captures terminal learning only in the project from the captured root', async () => {
    if (process.platform === 'win32') return
    const { fixture, capturedProject, replacementProject, managed, runtime } = registerProjectSession('terminal')
    const objective = { id: 'terminal-objective-a', role: 'user' as const, content: 'Inspect the captured target.', timestamp: 20 }
    const failure = {
      id: 'terminal-failure-a',
      role: 'tool' as const,
      content: '',
      timestamp: 21,
      toolUseId: 'terminal-tool-a',
      toolName: 'Read',
      toolResult: 'captured target unavailable',
      toolStatus: 'error' as const,
      isError: true,
    }
    managed.messages = [objective, failure]
    managed.activeObjective = {
      schemaVersion: 1,
      objectiveId: objective.id,
      userMessageId: objective.id,
      originalText: objective.content,
      startedAt: objective.timestamp,
      budgetBaselineUsd: 0,
      tokenBaseline: 0,
      continuationCount: 0,
      orchestrationMode: 'direct',
      risk: 'standard',
      completionCriteria: ['requested-outcome-delivered'],
      terminalState: 'exhausted',
    }

    await runtime.captureSessionTerminalLearning(managed, 'exhausted')

    const entries = loadProjectMemoryJournal(fixture.rootA, capturedProject.slug, { strict: true }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toContain('Observed Read failure')
    expect(existsSync(getProjectMemoryJournalPath(fixture.rootA, replacementProject.slug))).toBe(false)
    expect(existsSync(getProjectMemoryJournalPath(fixture.rootB, replacementProject.slug))).toBe(false)
  })

  it('handles project-learning tool requests only against the captured project', async () => {
    if (process.platform === 'win32') return
    const { fixture, capturedProject, replacementProject, managed, runtime } = registerProjectSession('tool-learning')
    managed.messages = [{
      id: 'observed-user-a',
      role: 'user',
      content: 'The captured deployment requires the amber profile.',
      timestamp: 30,
    }]

    await runtime.handleSessionProjectLearning(managed, {
      action: 'propose',
      kind: 'observation',
      content: 'Observed that the captured deployment uses the amber profile.',
      evidenceIds: ['observed-user-a'],
    })

    const entries = loadProjectMemoryJournal(fixture.rootA, capturedProject.slug, { strict: true }).entries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.scope?.projectSlug).toBe(capturedProject.slug)
    expect(existsSync(getProjectMemoryJournalPath(fixture.rootA, replacementProject.slug))).toBe(false)
    expect(existsSync(getProjectMemoryJournalPath(fixture.rootB, replacementProject.slug))).toBe(false)
  })

  it('lists and revokes a legacy alias-scoped proposal only in the captured project', async () => {
    if (process.platform === 'win32') return
    const { fixture, capturedProject, managed, runtime } = registerProjectSession('legacy-mutation')
    const proposal = appendProjectMemoryEntry(fixture.rootA, capturedProject.slug, {
      id: 'legacy-proposal-a',
      kind: 'observation',
      content: 'Legacy proposal retained under captured workspace A.',
      status: 'proposed',
      confidence: 0.25,
      provenance: { sourceType: 'session', sourceId: 'legacy-evidence-a', actorId: 'legacy-source' },
    })
    const journalPath = getProjectMemoryJournalPath(fixture.rootA, capturedProject.slug)
    const legacyRecord = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      payload: { entry: { scope: { workspaceKey: string } } }
      checksum: string
    }
    legacyRecord.payload.entry.scope.workspaceKey = createHash('sha256')
      .update(resolve(fixture.alias))
      .digest('hex')
    legacyRecord.checksum = createHash('sha256')
      .update(JSON.stringify(legacyRecord.payload))
      .digest('hex')
    writeFileSync(journalPath, `${JSON.stringify(legacyRecord)}\n`)

    const listed = await runtime.handleSessionProjectLearning(managed, { action: 'list' }) as Array<{ id: string }>
    expect(listed.map(entry => entry.id)).toContain(proposal.id)
    await runtime.handleSessionProjectLearning(managed, { action: 'revoke', id: proposal.id })

    expect(loadProjectMemoryJournal(fixture.rootA, capturedProject.slug, { strict: true }).entries)
      .toContainEqual(expect.objectContaining({ id: proposal.id, status: 'forgotten' }))
  })

  it('retrieves project memory only from the captured root after alias retargeting', async () => {
    if (process.platform === 'win32') return
    const { fixture, capturedProject, replacementProject, managed, runtime } = registerProjectSession('memory-context')
    appendProjectMemoryEntry(fixture.rootA, capturedProject.slug, {
      id: 'captured-memory-a',
      kind: 'observation',
      content: 'The alphaquartz marker belongs to captured workspace A.',
      confidence: 0.9,
      provenance: { sourceType: 'tool', sourceId: 'captured-proof-a' },
    })
    // Simulate the exact scope key emitted before project memory used physical
    // workspace identity. The file itself remains under captured root A.
    const capturedJournalPath = getProjectMemoryJournalPath(fixture.rootA, capturedProject.slug)
    const legacyRecord = JSON.parse(readFileSync(capturedJournalPath, 'utf8')) as {
      payload: { entry: { scope: { workspaceKey: string } } }
      checksum: string
    }
    legacyRecord.payload.entry.scope.workspaceKey = createHash('sha256')
      .update(resolve(fixture.alias))
      .digest('hex')
    legacyRecord.checksum = createHash('sha256')
      .update(JSON.stringify(legacyRecord.payload))
      .digest('hex')
    writeFileSync(capturedJournalPath, `${JSON.stringify(legacyRecord)}\n`)
    appendProjectMemoryEntry(fixture.rootB, replacementProject.slug, {
      id: 'replacement-memory-b',
      kind: 'observation',
      content: 'The alphaquartz marker was replaced by workspace B.',
      confidence: 0.9,
      provenance: { sourceType: 'tool', sourceId: 'replacement-proof-b' },
    })

    const context = await runtime.loadSessionProjectMemoryContext(managed, 'alphaquartz marker captured')

    expect(context).toContain('belongs to captured workspace A')
    expect(context).not.toContain('replaced by workspace B')
  })

  it('loads a session-bound playbook only from the captured root after alias retargeting', () => {
    if (process.platform === 'win32') return
    const { fixture, managed, runtime } = registerProjectSession('playbook')
    const slug = 'captured-root-playbook'
    const playbook = (instructions: string) => `---
version: 1
slug: ${slug}
name: Captured root playbook
description: Verify physical workspace ownership
allowedTools:
  - Read
proofs:
  - id: physical-root
    description: Verify the captured root
    required: true
---
${instructions}`
    mkdirSync(join(fixture.rootA, 'playbooks'))
    mkdirSync(join(fixture.rootB, 'playbooks'))
    writeFileSync(join(fixture.rootA, 'playbooks', `${slug}.md`), playbook('Instructions from captured workspace A.'))
    writeFileSync(join(fixture.rootB, 'playbooks', `${slug}.md`), playbook('Instructions from replacement workspace B.'))
    managed.playbookSlug = slug

    const selected = runtime.loadSessionPlaybook(managed)

    expect(selected?.instructions).toContain('captured workspace A')
    expect(selected?.instructions).not.toContain('replacement workspace B')
  })
})
