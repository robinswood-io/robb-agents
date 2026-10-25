import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAutonomyBrowserFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { SessionManager, createManagedSession } from "./SessionManager.ts";
import { type SourceActivatedEvent } from "./testing/source-activated-auto-retry-fixture.ts";

describe('source_activated auto-retry', () => {
  let tmpRoot: string

  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-autoretry-'))
    sm = new SessionManager()
    const internals = sm as unknown as { enqueuePersist: () => boolean; flushSession: () => Promise<void> }
    internals.enqueuePersist = () => true
    internals.flushSession = async () => {}
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string) {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'auto-retry test' },
      workspace as never,
      { messagesLoaded: true },
    )
    const rootId = `${id}-root`
    managed.messages.push({
      id: rootId,
      role: 'user',
      content: `Initial objective for ${id}`,
      timestamp: 100,
    })
    managed.activeObjective = {
      schemaVersion: 1,
      originalText: `Initial objective for ${id}`,
      objectiveId: rootId,
      userMessageId: rootId,
      lastUserMessageId: rootId,
      startedAt: 100,
      budgetBaselineUsd: 0,
      tokenBaseline: 0,
      continuationCount: 0,
      orchestrationMode: 'direct',
      risk: 'standard',
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      terminalState: 'active',
    }
    managed.pendingTurnRecovery = createPendingTurnRecovery(rootId, 100)
    ;sessionRuntimeStateForTest(sm).sessions.set(id, managed)
    return managed
  }

  function stubRuntimeForRealSend(
    managed: ReturnType<typeof buildSession>,
    onChat: (message: string) => void,
  ) {
    const internals = sm as unknown as {
      enqueuePersist: () => boolean
      flushSession: () => Promise<void>
      sendEvent: () => void
      emitExecutionTelemetry: () => void
      startGenerationTelemetry: () => void
      finishGenerationTelemetry: () => void
      beginAutomaticSessionStatusLifecycle: () => Promise<void>
      finishAutomaticSessionStatusLifecycle: () => Promise<void>
      isSessionBeingViewed: () => boolean
      markSessionRead: () => Promise<void>
      processNextQueuedMessage: () => void
      getOrCreateAgent: () => Promise<unknown>
    }
    internals.enqueuePersist = () => true
    internals.flushSession = async () => {}
    internals.sendEvent = () => {}
    internals.emitExecutionTelemetry = () => {}
    internals.startGenerationTelemetry = () => {}
    internals.finishGenerationTelemetry = () => {}
    internals.beginAutomaticSessionStatusLifecycle = async () => {}
    internals.finishAutomaticSessionStatusLifecycle = async () => {}
    internals.isSessionBeingViewed = () => true
    internals.markSessionRead = async () => {}
    internals.processNextQueuedMessage = () => {}
    const agent: {
      onProviderHandoff?: () => void
      chat(message: string): AsyncGenerator<{ type: 'complete' }>
      getModel(): string
      getSessionId(): null
      isProcessing(): boolean
      setAllSources(): void
      redirect(): boolean
    } = {
      onProviderHandoff: undefined,
      async *chat(message: string) {
        onChat(message)
        agent.onProviderHandoff?.()
        // End this isolated replay without asking the completion gate to spend
        // another recovery attempt after the state snapshot has been captured.
        managed.stopRequested = true
        if (false) yield { type: 'complete' as const }
      },
      getModel: () => 'test/source-activation',
      getSessionId: () => null,
      isProcessing: () => false,
      setAllSources: () => {},
      redirect: () => false,
    }
    managed.agent = agent as never
    internals.getOrCreateAgent = async () => agent
  }

  async function fireSourceActivated(
    sessionId: string,
    sourceSlug: string,
    originalMessage: string,
    cleanRawMessage = originalMessage,
  ) {
    const managed = sessionRuntimeStateForTest(sm).sessions.get(sessionId)!
    const binding = managed.activeObjective!
    managed.sourceActivationTurn = {
      generation: managed.processingGeneration,
      cancellationEpoch: 0,
      rawMessage: cleanRawMessage,
      objectiveId: binding.objectiveId ?? binding.userMessageId,
      objectiveRevision: binding.lastUserMessageId ?? binding.userMessageId,
    }
    const event: SourceActivatedEvent = { type: 'source_activated', sourceSlug, originalMessage }
    await (sm as unknown as { processEvent: (m: unknown, e: unknown) => Promise<void> }).processEvent(managed, event)
  }

  it('restores a queued source-activation continuation with durable provenance and the original objective budget', () => {
    const managed = buildSession('cold-source-activation')
    const humanMessageId = 'msg-1789638600000-coldhuman'
    const objective: NonNullable<typeof managed.activeObjective> = {
      schemaVersion: 1 as const,
      originalText: 'Corrige et vérifie le contrat 3602 via le serveur.',
      objectiveId: humanMessageId,
      userMessageId: humanMessageId,
      lastUserMessageId: humanMessageId,
      startedAt: 1789638600000,
      budgetBaselineUsd: 31.67,
      tokenBaseline: 1_183_646,
      continuationCount: 9,
      orchestrationMode: 'direct' as const,
      risk: 'standard' as const,
      requiresExecutionEvidence: true,
      completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'],
      terminalState: 'active' as const,
      acceptanceCriteria: [{
        id: 'contract-3602', description: 'Contrat corrigé', toolName: 'mcp__rbw-servers__ssh_execute',
        input: { server: 'pns' }, checks: [{ path: '$.contractId', equals: 3602 }],
      }],
    }
    const recovery = {
      ...createPendingTurnRecovery(humanMessageId, 1789638600000),
      attempts: 8,
      continuationRequired: true,
      continuationOrigin: 'objective_continue' as const,
      continuationWork: ['Corriger le traitement 3602'],
    }
    managed.messages.push(
      { id: humanMessageId, role: 'user', content: objective.originalText!, timestamp: objective.startedAt },
      {
        id: 'msg-source-retry', role: 'user', timestamp: objective.startedAt + 1,
        content: `${buildAutonomyBrowserFallbackPrompt('WebFetch')}\n\n[rbw-servers activated]`,
        hidden: true, isQueued: true, internalOrigin: {
          kind: 'source-activation', objectiveId: humanMessageId, objectiveRevision: humanMessageId,
          sourceSlug: 'rbw-servers', sourceActivationId: 'cold-source-activation-id',
        },
      },
    )
    managed.activeObjective = objective
    managed.pendingTurnRecovery = recovery
    ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}

    ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
      .restoreDurableRuntimeState(managed)

    expect(managed.activeObjective).toEqual(objective)
    expect(managed.pendingTurnRecovery).toEqual(recovery)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      messageId: 'msg-source-retry',
      options: { hidden: true, internalOrigin: {
        kind: 'source-activation', objectiveId: humanMessageId, objectiveRevision: humanMessageId,
        sourceSlug: 'rbw-servers', sourceActivationId: 'cold-source-activation-id',
      } },
    })
    expect(managed.messageQueue[0]!.options?.automaticRecovery).toBeUndefined()
  })

  it('drops cold source-activation rows whose durable root or revision binding is absent or stale', () => {
    for (const variant of ['missing', 'root', 'revision'] as const) {
      const managed = buildSession(`cold-source-mismatch-${variant}`)
      const binding = {
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      }
      const internalOrigin = variant === 'missing'
        ? { kind: 'source-activation' as const }
        : {
            kind: 'source-activation' as const,
            objectiveId: variant === 'root' ? 'another-objective' : binding.objectiveId,
            objectiveRevision: variant === 'revision' ? 'another-revision' : binding.objectiveRevision,
          }
      managed.messages.push({
        id: `stale-source-${variant}`,
        role: 'user',
        timestamp: 101,
        content: `inspect\n\n[github activated]`,
        hidden: true,
        isQueued: true,
        internalOrigin,
      })
      ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}

      ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
        .restoreDurableRuntimeState(managed)

      expect(managed.messageQueue).toEqual([])
      expect(managed.messages.some(message => message.id === `stale-source-${variant}`)).toBe(false)
    }
  })

  it('queues and flushes the durable cleanup of a stale restored source row', async () => {
    const managed = buildSession('cold-source-cleanup-flush')
    managed.messages.push({
      id: 'stale-source-row',
      role: 'user',
      timestamp: Date.now(),
      content: 'inspect\n\n[github activated]',
      hidden: true,
      isQueued: true,
      internalOrigin: {
        kind: 'source-activation',
        objectiveId: 'obsolete-root',
        objectiveRevision: 'obsolete-revision',
        sourceSlug: 'github',
        sourceActivationId: 'obsolete-activation',
      },
    })
    let enqueued = 0
    let flushed = 0
    ;(sm as unknown as { enqueuePersist: () => boolean; flushSession: () => Promise<void> }).enqueuePersist = () => { enqueued++; return true }
    ;(sm as unknown as { flushSession: () => Promise<void> }).flushSession = async () => { flushed++ }

    ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
      .restoreDurableRuntimeState(managed)
    await new Promise(resolve => setImmediate(resolve))

    expect(managed.messages.some(message => message.id === 'stale-source-row')).toBe(false)
    expect(enqueued).toBe(1)
    expect(flushed).toBe(1)
  })

  it('lets a later durable human instruction supersede a matching source continuation during cold restore', () => {
    const managed = buildSession('cold-human-supersession')
    const origin = {
      kind: 'source-activation' as const,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      sourceSlug: 'github',
      sourceActivationId: 'cold-human-supersession-id',
    }
    managed.messages.push(
      {
        id: 'cold-deferred-source', role: 'user', timestamp: 101,
        content: 'inspect\n\n[github activated]', hidden: true, isQueued: true,
        internalOrigin: origin,
      },
      {
        id: 'cold-new-human', role: 'user', timestamp: 102,
        content: 'Nouvelle instruction humaine durable', isQueued: true,
      },
    )
    ;(sm as unknown as { processNextQueuedMessage: () => void }).processNextQueuedMessage = () => {}

    ;(sm as unknown as { restoreDurableRuntimeState: (session: typeof managed) => void })
      .restoreDurableRuntimeState(managed)

    expect(managed.messages.some(message => message.id === 'cold-deferred-source')).toBe(false)
    expect(managed.messages.some(message => message.id === 'cold-new-human')).toBe(true)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      messageId: 'cold-new-human',
      message: 'Nouvelle instruction humaine durable',
    })
    expect(managed.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
  })

  it('revalidates the objective binding at dequeue and removes a stale queued row', async () => {
    const sessionId = 'dequeue-source-mismatch'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    const origin = {
      kind: 'source-activation' as const,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      sourceSlug: 'github',
      sourceActivationId: 'dequeue-source-activation-id',
    }
    const content = 'inspect\n\n[github activated]'
    managed.messages.push({
      id: 'deferred-source-row', role: 'user', content, timestamp: 101,
      hidden: true, isQueued: true, internalOrigin: origin,
    })
    managed.messageQueue.push({
      messageId: 'deferred-source-row', message: content,
      options: { hidden: true, internalOrigin: origin },
    })
    managed.activeObjective = {
      ...managed.activeObjective!,
      lastUserMessageId: 'newer-human-revision',
    }
    delete (sm as unknown as { processNextQueuedMessage?: unknown }).processNextQueuedMessage

    ;(sm as unknown as { processNextQueuedMessage: (id: string) => void }).processNextQueuedMessage(sessionId)
    await new Promise(r => setTimeout(r, 20))

    expect(chats).toBe(0)
    expect(managed.messageQueue).toEqual([])
    expect(managed.messages.some(message => message.id === 'deferred-source-row')).toBe(false)
  })

  it('a new human instruction removes an already durable deferred source row before it can run', async () => {
    const sessionId = 'human-supersedes-deferred-source'
    const managed = buildSession(sessionId)
    stubRuntimeForRealSend(managed, () => {})
    managed.isProcessing = true

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await new Promise(r => setTimeout(r, 150))
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]?.options?.internalOrigin?.kind).toBe('source-activation')
    expect(managed.messages.some(message => message.isQueued
      && message.internalOrigin?.kind === 'source-activation')).toBe(true)

    await sm.sendMessage(sessionId, 'Nouvelle instruction humaine : traite plutôt les issues.')
    await new Promise(r => setTimeout(r, 20))

    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
    expect(managed.autoRetryTimer).toBeUndefined()
    expect(managed.messages.some(message => message.internalOrigin?.kind === 'source-activation')).toBe(false)
    expect(managed.messageQueue).toHaveLength(1)
    expect(managed.messageQueue[0]).toMatchObject({
      message: 'Nouvelle instruction humaine : traite plutôt les issues.',
    })
    expect(managed.messageQueue[0]?.options?.internalOrigin).toBeUndefined()
    await sm.sendMessage(sessionId, 'inspect the repository\n\n[github activated]')
    expect(managed.messageQueue).toHaveLength(1)
  })

  it('a human instruction accepted during source preparation prevents provider start', async () => {
    const sessionId = 'human-during-source-preparation'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    let releasePreparation!: () => void
    let preparationEntered!: () => void
    const preparationGate = new Promise<void>(resolve => { releasePreparation = resolve })
    const entered = new Promise<void>(resolve => { preparationEntered = resolve })
    const agent = managed.agent!
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown>; processNextQueuedMessage: () => void }).getOrCreateAgent = async () => {
      preparationEntered()
      await preparationGate
      return agent
    }

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('source preparation did not start')), 1_000)),
    ])
    await sm.sendMessage(sessionId, 'Traite plutôt les issues ouvertes.')
    releasePreparation()
    await new Promise(r => setTimeout(r, 50))

    expect(chats).toBe(0)
    expect(managed.messages.some(message => message.internalOrigin?.kind === 'source-activation')).toBe(false)
    expect(managed.messages.some(message => message.role === 'user'
      && !message.hidden && message.content === 'Traite plutôt les issues ouvertes.')).toBe(true)
    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
  })

  it('a human instruction accepted during the source durability flush wins before provider start', async () => {
    const sessionId = 'human-during-source-flush'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    let releaseFirstFlush!: () => void
    let firstFlushEntered!: () => void
    const firstFlushGate = new Promise<void>(resolve => { releaseFirstFlush = resolve })
    const entered = new Promise<void>(resolve => { firstFlushEntered = resolve })
    let firstFlush = true
    ;(sm as unknown as { flushSession: () => Promise<void> }).flushSession = async () => {
      if (!firstFlush) return
      firstFlush = false
      firstFlushEntered()
      await firstFlushGate
    }

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await Promise.race([
      entered,
      new Promise((_, reject) => setTimeout(() => reject(new Error('source flush did not start')), 1_000)),
    ])
    await sm.sendMessage(sessionId, 'Traite plutôt les pull requests.')
    releaseFirstFlush()
    await new Promise(r => setTimeout(r, 50))

    expect(chats).toBe(0)
    expect(managed.messages.some(message => message.internalOrigin?.kind === 'source-activation')).toBe(false)
    expect(managed.messages.some(message => message.role === 'user'
      && !message.hidden && message.content === 'Traite plutôt les pull requests.')).toBe(true)
    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
  })
});
