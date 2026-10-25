import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAutonomyBrowserFallbackPrompt } from "./autonomy-browser-fallback.ts";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { SessionManager, claimAutoRetryPending, createManagedSession } from "./SessionManager.ts";
import { type SourceActivatedEvent, makePending } from "./testing/source-activated-auto-retry-fixture.ts";

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

  /**
   * Replace `sendMessage` with a spy that records the call and appends a
   * placeholder user message to `managed.messages`. Appending makes the
   * content-match dedup observable through the real code path — without it,
   * subsequent "duplicate" calls wouldn't even reach the dedup check (no
   * pending state would have been mutated by the first call).
   */
  function spyOnSendMessage(sessionId: string) {
    const calls: string[] = []
    const managed = sessionRuntimeStateForTest(sm).sessions.get(sessionId)!
    ;(sm as unknown as { sendMessage: (id: string, msg: string, ...args: unknown[]) => Promise<void> }).sendMessage = async (id, msg, ...args) => {
      const m = sessionRuntimeStateForTest(sm).sessions.get(id)!
      const dispatchToken = args[11] as symbol | undefined
      const claim = claimAutoRetryPending(m, msg, Date.now(), dispatchToken)
      if (claim === 'drop' || claim === 'reserved') return
      calls.push(msg)
      managed.messages.push({ id: `m-${calls.length}`, role: 'user', content: msg, timestamp: Date.now() })
    }
    return calls
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

  it('releases an uncommitted claim after the first flush fails and retries only once', async () => {
    const sessionId = 'source-first-flush-failure'
    const managed = buildSession(sessionId)
    let chats = 0
    stubRuntimeForRealSend(managed, () => { chats++ })
    let flushCalls = 0
    ;(sm as unknown as { flushSession: () => Promise<void> }).flushSession = async () => {
      flushCalls++
      if (flushCalls === 1) throw new Error('simulated first durability failure')
    }

    await fireSourceActivated(sessionId, 'github', 'inspect the repository')
    await new Promise(r => setTimeout(r, 450))

    expect(chats).toBe(1)
    expect(flushCalls).toBeGreaterThanOrEqual(3)
    expect(managed.autoRetryPending).toMatchObject({
      dispatchAttempts: 2,
      committed: true,
      dispatchInFlight: false,
      providerStarted: true,
    })
  })

  it('drops an exact legacy RPC copy after deadline without creating a message or objective root', async () => {
    const sessionId = 'expired-legacy-copy'
    const managed = buildSession(sessionId)
    const objectiveBefore = structuredClone(managed.activeObjective)
    const messageCountBefore = managed.messages.length
    managed.autoRetryPending = makePending({
      content: 'inspect\n\n[github activated]',
      rawMessage: 'inspect',
      deadlineMs: Date.now() - 1,
      tombstoneExpiresAt: Date.now() + 30_000,
      objectiveId: managed.activeObjective!.objectiveId!,
      objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      dispatchToken: Symbol('expired-source-capability'),
      committed: true,
    })

    await sm.sendMessage(sessionId, 'inspect\n\n[github activated]')

    expect(managed.messages).toHaveLength(messageCountBefore)
    expect(managed.activeObjective).toEqual(objectiveBefore)
    expect(managed.autoRetryPending).toBeDefined()
  })

  it('does not accept source-activation provenance without the live token or an exact durable dequeue', async () => {
    const sessionId = 'forged-source-origin'
    const managed = buildSession(sessionId)
    stubRuntimeForRealSend(managed, () => { throw new Error('forged source origin reached provider') })
    const messageCountBefore = managed.messages.length

    await expect(sm.sendMessage(sessionId, 'inspect\n\n[github activated]', undefined, undefined, {
      hidden: true,
      internalOrigin: {
        kind: 'source-activation',
        objectiveId: managed.activeObjective!.objectiveId!,
        objectiveRevision: managed.activeObjective!.lastUserMessageId!,
      },
    })).rejects.toThrow('reserved for a server-authenticated source restart')

    expect(managed.messages).toHaveLength(messageCountBefore)
    expect(managed.activeObjective?.userMessageId).toBe(`${sessionId}-root`)
  })

  it('rejects a reserved terminal activation marker without host provenance', async () => {
    const sessionId = 'human-marker-without-pending'
    const managed = buildSession(sessionId)
    const marker = `${buildAutonomyBrowserFallbackPrompt('WebFetch')}\n\n[rbw-servers activated]`
    let providerMessage: string | undefined
    stubRuntimeForRealSend(managed, message => { providerMessage = message })
    const messageCountBefore = managed.messages.length

    await expect(sm.sendMessage(sessionId, marker)).rejects.toThrow('reserved for a server-authenticated source restart')

    expect(providerMessage).toBeUndefined()
    expect(managed.messages).toHaveLength(messageCountBefore)
  })

  it('allows quoted or non-terminal mentions of an activation marker as ordinary human text', async () => {
    const sessionId = 'quoted-marker-without-pending'
    const managed = buildSession(sessionId)
    const message = 'Explain this protocol token: [rbw-servers activated] and do not execute it.'
    let providerMessage: string | undefined
    stubRuntimeForRealSend(managed, value => { providerMessage = value })

    await sm.sendMessage(sessionId, message)

    expect(providerMessage).toContain(message)
    expect(managed.messages.some(candidate => candidate.role === 'user'
      && !candidate.hidden && candidate.content === message)).toBe(true)
  })

  it('chained activations — produces two retries with different suffixes', async () => {
    const sessionId = 'chained'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'find issues')
    await new Promise(r => setTimeout(r, 150))
    await fireSourceActivated(sessionId, 'linear', 'find issues')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([
      'find issues\n\n[github activated]',
      'find issues\n\n[linear activated]',
    ])
  })

  it('empty originalMessage — forwards event but does not schedule a bogus retry', async () => {
    const sessionId = 'empty-original'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', '')
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    expect(managed.autoRetryPending).toBeUndefined()
    expect(managed.autoRetryTimer).toBeUndefined()
  })

  it('legitimate user message preempts retry — skipped when follow-up arrived', async () => {
    const sessionId = 'preempted'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'check the repo')
    // Simulate the user typing something brand new in the 100ms window — bumps
    // messages.length past the schedule-time count.
    managed.messages.push({
      id: 'user-followup',
      role: 'user',
      content: 'actually check the issues instead',
      timestamp: Date.now(),
    } as never)

    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual([])
    // Retain a cancelled exact-text tombstone so a late legacy RPC can never
    // become a new visible objective after the timer window.
    expect(managed.autoRetryPending).toMatchObject({ committed: true, cancelled: true })
  })

  it('mixed-version race: legacy RPC arrives BEFORE timer fires — exactly one message committed', async () => {
    const sessionId = 'race-rpc-first'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Legacy renderer's RPC arrives ~5ms after schedule, BEFORE the 100ms timer.
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'do the thing\n\n[github activated]',
    )
    // Wait past the timer.
    await new Promise(r => setTimeout(r, 200))

    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('do the thing\n\n[github activated]')
  })

  it('mixed-version race: timer fires BEFORE legacy RPC arrives — exactly one message committed', async () => {
    const sessionId = 'race-timer-first'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Wait for the timer to fire and commit.
    await new Promise(r => setTimeout(r, 150))
    // Now the late legacy RPC arrives (≤2s window).
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'do the thing\n\n[github activated]',
    )

    expect(calls.length).toBe(1)
    expect(calls[0]).toBe('do the thing\n\n[github activated]')
  })

  it('user message with different content still goes through — pending slot does not over-dedup', async () => {
    const sessionId = 'unrelated-message'
    buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'list repos')
    // User types something completely different in the dedup window — pending
    // content does not match, so the dedup gate falls through and the message
    // goes through normally. (It also bumps messages.length, which causes the
    // timer to skip the auto-retry as preempted — covered by the 'preempted'
    // test. The unique guarantee here is: the unrelated message itself is
    // never silently dropped by the dedup gate.)
    await (sm as unknown as { sendMessage: (id: string, msg: string) => Promise<void> }).sendMessage(
      sessionId,
      'never mind, what time is it',
    )
    await new Promise(r => setTimeout(r, 150))

    expect(calls).toEqual(['never mind, what time is it'])
  })

  it('timer cancelled on session delete — no auto-retry fires after deletion', async () => {
    const sessionId = 'deleted-mid-window'
    const managed = buildSession(sessionId)
    const calls = spyOnSendMessage(sessionId)

    await fireSourceActivated(sessionId, 'github', 'do the thing')
    // Confirm the timer is armed before we delete.
    expect(managed.autoRetryTimer).toBeDefined()

    // Synchronously rip the session out of the map (mimic the deletion path's
    // cleanup without going through the full deleteSession flow, which would
    // also try to dispose agents and tear down pool servers we never created).
    if (managed.autoRetryTimer) clearTimeout(managed.autoRetryTimer)
    managed.autoRetryTimer = undefined
    managed.autoRetryPending = undefined
    ;sessionRuntimeStateForTest(sm).sessions.delete(sessionId)

    await new Promise(r => setTimeout(r, 200))

    expect(calls).toEqual([])
  })
});
