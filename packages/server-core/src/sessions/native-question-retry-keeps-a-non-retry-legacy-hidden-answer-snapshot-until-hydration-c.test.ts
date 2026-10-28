import { completeSessionAgentFixture } from './testing/scripted-session-agent.ts';
import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionFilePath, loadSession } from '@craft-agent/shared/sessions/storage';
import * as config from '@craft-agent/shared/config';
import { storedToMessage } from '@craft-agent/core/types';
import { SessionManager, createManagedSession } from './SessionManager.ts';

import type { AgentBackend } from '@craft-agent/shared/agent/backend/types.ts';
import type { SessionEvent } from '@craft-agent/shared/protocol';












const prompt = 'Nouvel objectif : contrôle natif UI-3af573b1. Utilise request_user_input pour me demander « Couleur du contrôle UI-3af573b1 ? », avec Bleu et Vert. Attends ma réponse. Puis réponds uniquement « UI-3af573b1 : [couleur choisie] ». Aucun fichier, aucune action externe, aucun sous-agent.'
const managers: SessionManager[] = []
const roots: string[] = []
const releases: Array<() => void> = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
// Real host lifecycle and JSONL persistence; the provider is a local generator.
// No model API, local command, acceptance criterion or business tool executes.
function harness(stallAnswer = false) {
  const rootPath = mkdtempSync(join(tmpdir(), 'native-question-retry-')); roots.push(rootPath)
  const workspace = { id: 'native-fixture', slug: 'native-fixture', name: 'Native fixture', rootPath, createdAt: 1 }
  const manager = withSessionOperationsForTest(new SessionManager()); managers.push(manager)
  const runtime = sessionManagerForTest(manager)
  let managed = createManagedSession({ id: 'native-question' }, workspace, { messagesLoaded: true })
  sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
  const events: SessionEvent[] = []
  runtime.sendEvent = (event: SessionEvent) => events.push(event)
  for (const method of ['startGenerationTelemetry', 'finishGenerationTelemetry', 'finishAllGenerationTelemetry', 'emitExecutionTelemetry'] as const) runtime[method] = () => {}
  const started = deferred(), release = deferred(); releases.push(release.resolve)
  const answerStarted = deferred(), releaseAnswer = deferred(); releases.push(releaseAnswer.resolve)
  const chatBudgets: Array<typeof managed.pendingTurnRecovery> = []
  const chatPrompts: string[] = []
  let answerWasStopped = false
  let chats = 0, requestId = '', dispatch: Promise<void> | undefined
  const agent = completeSessionAgentFixture(managed.workspace, ({
    getModel: () => 'fixture', getSessionId: () => null, setAllSources: () => {},
    isProcessing: () => managed.isProcessing, forceAbort: () => {
      if (chats === 1) release.resolve()
      if (chats === 3) { answerWasStopped = true; releaseAnswer.resolve() }
    }, dispose: () => {},
    async *chat(message: string) {
      const turn = ++chats
      chatPrompts.push(message)
      chatBudgets.push(structuredClone(managed.pendingTurnRecovery))
      if (turn === 1) { started.resolve(); await release.promise; return }
      else if (turn === 2) {
        yield { type: 'tool_start', toolName: 'mcp__session__request_user_input', toolUseId: 'question-tool', input: {} }
        const result = await manager.requestUserInput(managed.id, [{ id: 'color', question: 'Couleur du contrôle ?', options: [{ id: 'blue', label: 'Bleu' }, { id: 'green', label: 'Vert' }] }])
        requestId = result.requestId
        yield { type: 'tool_result', toolUseId: 'question-tool', toolName: 'mcp__session__request_user_input', result: JSON.stringify(result), isError: false, toolExecuted: true }
      } else if (turn === 3 || stallAnswer && turn === 4) {
        if (stallAnswer && turn === 3) { answerStarted.resolve(); await releaseAnswer.promise; if (answerWasStopped) return }
        yield { type: 'text_complete', text: 'UI-3af573b1 : Bleu', turnId: 'native-final' }
      }
      else throw new Error('Unexpected extra model continuation in a conversational fixture')
      yield { type: 'complete' }
    },
  } satisfies Partial<AgentBackend> & { dispose?: () => void }))
  runtime.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  const send = manager.sendMessage.bind(manager)
  manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
  const readHeader = () => parseRecoveryJournalObservation(readFileSync(getSessionFilePath(rootPath, managed.id), 'utf8').split('\n')[0]!)
  const restore = () => {
    const saved = loadSession(rootPath, managed.id)!
    const { messages, ...metadata } = saved
    managed = createManagedSession(metadata, workspace, { messagesLoaded: true })
    managed.messages = messages.map(storedToMessage)
    sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
  }
  return { manager, runtime, get managed() { return managed }, events, started, answerStarted, chatBudgets, chatPrompts, readHeader, restore, requestId: () => requestId, dispatch: () => dispatch!, chats: () => chats }
}
afterEach(async () => {
  releases.splice(0).forEach(release => release())
  for (const manager of managers.splice(0)) await manager.cleanup()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

describe('native Stop, Retry and question response', () => {
it('keeps a non-Retry legacy hidden-answer snapshot until hydration can authenticate and quarantine it for explicit Retry', async () => {
    const h = harness(true)
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, attempts: 2,
      exhaustedAt: 99, validationExhausted: true, leaseExpiresAt: 100, lastCause: 'tool_checkpoint' }
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    await h.manager.flushSession(h.managed.id)
    h.restore()
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    const grant = structuredClone(h.managed.pendingTurnRecovery!.explicitRetryAllowances![0]!)
    await h.manager.respondToUserInput(h.managed.id, { requestId: h.requestId(),
      answers: [{ questionId: 'color', optionIds: ['blue'] }] })
    await h.answerStarted.promise
    await h.manager.cancelProcessing(h.managed.id)
    await h.dispatch()
    await h.manager.flushSession(h.managed.id)

    const interrupted = structuredClone(h.managed.activeObjective!.interruptedTurnRecovery!.recovery)
    interrupted.lastCause = 'tool_checkpoint'
    h.managed.pendingTurnRecovery = interrupted
    delete h.managed.activeObjective!.interruptedTurnRecovery;
    h.runtime.persistSession(h.managed)
    await h.manager.flushSession(h.managed.id)

    const getWorkspaces = spyOn(config, 'getWorkspaces').mockReturnValue([h.managed.workspace] as never)
    try {
      const restarted = withSessionOperationsForTest(new SessionManager()); managers.push(restarted)
      const runtime = sessionManagerForTest(restarted)
      let scheduled: string[] = []
      runtime.resumePendingTurnsAfterRestart = async (ids: string[]) => { scheduled = ids }
      runtime.getOrCreateAgent = async () => { throw new Error('Consumed answer must not start a provider') }
      runtime.loadSessionsFromDisk()
      await new Promise<void>(resolve => setImmediate(resolve))

      const restored = requiredTestValue(sessionRuntimeStateForTest(restarted).sessions.get(h.managed.id))
      expect(scheduled).toContain(h.managed.id)
      expect(restored.messagesLoaded).toBe(false)
      expect(restored.pendingTurnRecovery).toMatchObject({
        lastCause: 'tool_checkpoint', attempts: 2, exhaustedAt: 99,
        explicitRetryAllowances: [grant],
      })

      await runtime.resumePendingTurnAfterRestart(restored.id)
      expect(restored.pendingTurnRecovery).toBeUndefined()
      expect(requiredTestValue(requiredTestValue(restored.activeObjective).interruptedTurnRecovery).recovery).toMatchObject({
        lastCause: 'tool_checkpoint', attempts: 2, exhaustedAt: 99,
        explicitRetryAllowances: [grant],
      })
    } finally {
      getWorkspaces.mockRestore()
    }
  })

for (const corruption of ['duplicate-answer', 'mismatched-request'] as const) {
    it(`revokes a ${corruption} live Stop snapshot instead of retaining its Retry grant`, async () => {
      const h = harness(true)
      const initial = h.manager.sendMessage(h.managed.id, prompt)
      await h.started.promise
      const anchor = h.managed.activeObjective!.userMessageId
      h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, attempts: 2,
        exhaustedAt: 99, validationExhausted: true, leaseExpiresAt: 100, lastCause: 'tool_checkpoint' }
      await h.manager.cancelProcessing(h.managed.id)
      await initial
      h.restore()
      await h.manager.retryTurn(h.managed.id, anchor)
      await h.dispatch()
      await h.manager.respondToUserInput(h.managed.id, { requestId: h.requestId(),
        answers: [{ questionId: 'color', optionIds: ['blue'] }] })
      await h.answerStarted.promise
      expect(h.managed.pendingTurnRecovery?.explicitRetryAllowances).toHaveLength(1)

      const request = h.managed.userInputRequests?.[0]
      const answer = h.managed.messages.find(message => message.id === request?.responseMessageId)
      if (!request || !answer) throw new Error('Expected a persisted hidden answer fixture')
      if (corruption === 'duplicate-answer') h.managed.messages.push(structuredClone(answer))
      else request.objectiveUserMessageId = 'different-objective'

      await h.manager.cancelProcessing(h.managed.id)
      await h.dispatch()
      await h.manager.flushSession(h.managed.id)
      expect(h.managed.pendingTurnRecovery).toBeUndefined()
      expect(h.managed.activeObjective?.interruptedTurnRecovery).toBeUndefined()
      expect(h.readHeader().pendingTurnRecovery).toBeUndefined()
      expect(requiredTestValue(h.readHeader().activeObjective).interruptedTurnRecovery).toBeUndefined()
    })
  }

it('lets Stop supersede a restart migration while message hydration is suspended', async () => {
    const h = harness(true)
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, attempts: 2,
      exhaustedAt: 99, validationExhausted: true, leaseExpiresAt: 100, lastCause: 'tool_checkpoint' }
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    h.restore()
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    const grant = structuredClone(h.managed.pendingTurnRecovery!.explicitRetryAllowances![0]!)
    await h.manager.respondToUserInput(h.managed.id, { requestId: h.requestId(),
      answers: [{ questionId: 'color', optionIds: ['blue'] }] })
    await h.answerStarted.promise
    await h.manager.cancelProcessing(h.managed.id)
    await h.dispatch()
    const interrupted = structuredClone(h.managed.activeObjective!.interruptedTurnRecovery!.recovery)
    h.managed.pendingTurnRecovery = interrupted
    delete h.managed.activeObjective!.interruptedTurnRecovery;
    h.runtime.persistSession(h.managed)
    await h.manager.flushSession(h.managed.id)
    h.restore()

    const entered = deferred(), releaseHydration = deferred()
    const ensureMessagesLoaded = h.runtime.ensureMessagesLoaded.bind(h.manager)
    let hydrations = 0
    h.runtime.ensureMessagesLoaded = async managed => {
      if (++hydrations === 1) { entered.resolve(); await releaseHydration.promise }
      await ensureMessagesLoaded(managed)
    }
    const before = h.chats()
    const resuming = h.runtime.resumePendingTurnAfterRestart(h.managed.id)
    await entered.promise
    await h.manager.cancelProcessing(h.managed.id)
    releaseHydration.resolve()
    await resuming

    expect(h.chats()).toBe(before)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    expect(requiredTestValue(requiredTestValue(h.readHeader().activeObjective).interruptedTurnRecovery).recovery.explicitRetryAllowances).toEqual([grant])
  })

it('revokes an ambiguous legacy hidden-answer snapshot instead of admitting or preserving its Retry reserve', async () => {
    const h = harness(true)
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, attempts: 2,
      exhaustedAt: 99, validationExhausted: true, leaseExpiresAt: 100, lastCause: 'tool_checkpoint' }
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    await h.manager.flushSession(h.managed.id)
    h.restore()
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    await h.manager.respondToUserInput(h.managed.id, { requestId: h.requestId(),
      answers: [{ questionId: 'color', optionIds: ['blue'] }] })
    await h.answerStarted.promise
    await h.manager.cancelProcessing(h.managed.id)
    await h.dispatch()
    await h.manager.flushSession(h.managed.id)

    const interrupted = h.managed.activeObjective!.interruptedTurnRecovery!.recovery
    const responseMessageId = h.managed.userInputRequests?.[0]?.responseMessageId
    const answer = h.managed.messages.find(message => message.id === responseMessageId)
    if (!responseMessageId || !answer) throw new Error('Expected a persisted hidden answer fixture')
    // A duplicate durable identity is ambiguous: neither row may authorize
    // automatic recovery or retain the prospective grant for explicit Retry.
    h.managed.messages.push(structuredClone(answer))
    h.managed.pendingTurnRecovery = structuredClone(interrupted)
    delete h.managed.activeObjective!.interruptedTurnRecovery;
    h.runtime.persistSession(h.managed)
    await h.manager.flushSession(h.managed.id)
    h.restore()

    await h.runtime.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.chats()).toBe(3)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    expect(h.managed.activeObjective?.interruptedTurnRecovery).toBeUndefined()
    expect(h.readHeader().pendingTurnRecovery).toBeUndefined()
    expect(requiredTestValue(h.readHeader().activeObjective).interruptedTurnRecovery).toBeUndefined()
  })

it('retries the public anchor after Stop interrupts an answered hidden question turn, without asking again', async () => {
    const h = harness(true)
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    Object.assign(h.managed.pendingTurnRecovery!, { attempts: 2, leaseExpiresAt: Date.now() + 60_000 })
    const budgetBeforeAnswer = structuredClone(h.managed.pendingTurnRecovery!)
    const accepted = await h.manager.respondToUserInput(h.managed.id, {
      requestId: h.requestId(), answers: [{ questionId: 'color', optionIds: ['blue'] }],
    })
    const answerTurn = h.dispatch()
    await h.answerStarted.promise
    expect(h.managed.pendingTurnRecovery?.userMessageId).toBe(accepted.responseMessageId)
    expect(h.managed.activeObjective?.lastUserMessageId).toBe(anchor)
    await h.manager.cancelProcessing(h.managed.id)
    await answerTurn
    await h.manager.flushSession(h.managed.id)
    h.restore()
    expect(h.managed.activeObjective?.interruptedTurnRecovery).toMatchObject({ userMessageId: anchor,
      recovery: { userMessageId: accepted.responseMessageId, attempts: 2, leaseExpiresAt: budgetBeforeAnswer.leaseExpiresAt } })
    await h.runtime.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.chats()).toBe(3)
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    expect(h.chatBudgets[3]).toMatchObject({ userMessageId: anchor, attempts: 2, leaseExpiresAt: budgetBeforeAnswer.leaseExpiresAt })
    expect(h.chatBudgets[3]?.budgetHistoryUnavailable).not.toBe(true)
    expect(h.managed.userInputRequests).toHaveLength(1)
    expect(h.managed.userInputRequests?.[0]).toMatchObject({ status: 'answered', responseMessageId: accepted.responseMessageId })
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(h.managed.activeObjective?.interruptedTurnRecovery).toBeUndefined()
    expect(h.chats()).toBe(4)
  })

it('un-cancels and delivers a valid answer when submitting to a previously cancelled question', async () => {
    const h = harness()
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    const req = h.managed.userInputRequests?.[0]
    expect(req).toBeDefined()
    expect(req?.status).toBe('pending')
    // Simulate question being cancelled (e.g. by parallel message or timeout)
    req!.status = 'cancelled'
    // Answering now should revive the question and deliver the response without throwing
    const result = await h.manager.respondToUserInput(h.managed.id, {
      requestId: req!.id,
      answers: [{ questionId: 'color', optionIds: ['blue'] }],
    })
    expect(result.status).toBe('accepted')
    expect((req!.status as string)).toBe('answered')
    await h.dispatch()
    expect(h.chats()).toBe(3)
  })
});
