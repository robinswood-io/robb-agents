import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionFilePath, loadSession } from '@craft-agent/shared/sessions/storage';
import "@craft-agent/shared/config";
import { storedToMessage } from '@craft-agent/core/types';
import { SessionManager, createManagedSession } from './SessionManager.ts';

import type { AgentBackend } from '@craft-agent/shared/agent/backend/types.ts';
import type { SessionEvent } from '@craft-agent/shared/protocol';
import type { SessionOperations } from './SessionManager/operation-types.ts';










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
  const runtime = manager as unknown as SessionOperations
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
  const agent = ({
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
  } satisfies Partial<AgentBackend> & { dispose?: () => void }) as Partial<AgentBackend> as AgentBackend
  runtime.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }
  const send = manager.sendMessage.bind(manager)
  manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
  const readHeader = () => JSON.parse(readFileSync(getSessionFilePath(rootPath, managed.id), 'utf8').split('\n')[0]!)
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
it('finishes the fresh conversational objective without inventing checks or losing its known recovery budget', async () => {
    const h = harness()
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    const initialBudget = structuredClone(h.managed.pendingTurnRecovery!)
    const initialObjective = structuredClone(h.managed.activeObjective!)
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    await h.manager.flushSession(h.managed.id)
    const stoppedHeader = h.readHeader()
    h.restore()
    const beforeRestartChats = h.chats()
    await h.runtime.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.chats()).toBe(beforeRestartChats)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()

    expect(await h.manager.retryTurn(h.managed.id, anchor)).toEqual({ status: 'started' })
    await h.dispatch()
    const retryBudget = structuredClone(h.managed.pendingTurnRecovery!)
    const result = await h.manager.respondToUserInput(h.managed.id, {
      requestId: h.requestId(), answers: [{ questionId: 'color', optionIds: ['blue'] }],
    })
    await h.dispatch()
    await h.manager.flushSession(h.managed.id)

    expect(result.delivery).toBe('started')
    expect(stoppedHeader.activeObjective.interruptedTurnRecovery?.recovery).toEqual(initialBudget)
    expect(retryBudget.attempts).toBe(initialBudget.attempts)
    expect(retryBudget.budgetHistoryUnavailable).not.toBe(true)
    expect(h.managed.activeObjective).toMatchObject({
      objectiveId: initialObjective.objectiveId, userMessageId: anchor,
      budgetBaselineUsd: initialObjective.budgetBaselineUsd, tokenBaseline: initialObjective.tokenBaseline,
      orchestrationMode: 'direct', terminalState: 'complete_verified',
    })
    expect(h.managed.activeObjective?.acceptanceCriteria).toBeUndefined()
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    expect(h.managed.messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(1)
    expect(h.managed.messages.filter(message => message.role === 'tool').map(message => message.toolName)).toEqual(['mcp__session__request_user_input'])
    expect(h.managed.messages.find(message => message.turnId === 'native-final')).toMatchObject({ content: 'UI-3af573b1 : Bleu' })
    expect(h.managed.messages.find(message => message.turnId === 'native-final')?.isIntermediate).not.toBe(true)
    expect(h.readHeader().activeObjective.terminalState).toBe('complete_verified')
    expect(h.chats()).toBe(3)
  })

it('preserves spent attempts and expired/exhausted budget fields across Stop, persistence and explicit Retry', async () => {
    const h = harness()
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    const budget = { ...h.managed.pendingTurnRecovery!, attempts: 7, stagnantAttempts: 1,
      leaseExpiresAt: 100, exhaustedAt: 99, lastCause: 'runtime_error' as const,
      lastProgressAt: 80, lastProgressFingerprint: 'preserved-proof', validationGaps: ['existing-gap'] }
    h.managed.pendingTurnRecovery = structuredClone(budget)
    h.managed.messages.push({ id: 'existing-read-receipt', role: 'tool', toolName: 'Read', toolUseId: 'prior-read',
      content: 'Previously observed data', toolInput: { path: '/fixture/existing.txt' },
      toolResult: 'Existing observed contents. '.repeat(40), toolStatus: 'completed', toolExecuted: true, timestamp: Date.now() })
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    await h.manager.flushSession(h.managed.id)
    h.restore()
    expect(h.managed.activeObjective?.interruptedTurnRecovery?.recovery).toEqual(budget)
    await h.runtime.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.chats()).toBe(1)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    expect(h.managed.pendingTurnRecovery).toMatchObject({ attempts: 7, stagnantAttempts: 1, leaseExpiresAt: 100,
      exhaustedAt: 99, lastProgressAt: 80, lastProgressFingerprint: 'preserved-proof', validationGaps: ['existing-gap'] })
    expect(h.managed.pendingTurnRecovery?.budgetHistoryUnavailable).not.toBe(true)
    expect(h.managed.activeObjective?.interruptedTurnRecovery).toBeUndefined()
    expect(h.chatPrompts[1]).toMatch(/observed evidence candidates for this objective/i)
    expect(h.chatPrompts[1]).toContain('existing-read-receipt')
    expect(h.chats()).toBe(2)
  })

it('migrates an exact legacy restart transcript and grants Retry only a bounded remainder', async () => {
    const h = harness()
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.interruptedTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'exhausted'
    const recoveryStartedAt = h.managed.messages.find(message => message.id === anchor)!.timestamp + 10
    for (const attempt of [1, 2]) h.managed.messages.push({
      id: `legacy-recovery-${attempt}`, role: 'user', hidden: true, timestamp: recoveryStartedAt + attempt,
      content: `<automatic_turn_recovery original_user_message_id="${anchor}" attempt="${attempt}">\nLegacy host recovery.\n</automatic_turn_recovery>`,
    })
    h.managed.messages.push({ id: 'legacy-validation-stop', role: 'error', timestamp: recoveryStartedAt + 3,
      content: 'Completion could not be verified.', errorCode: 'objective_validation_failed',
      errorCanRetry: true, errorDetails: ['legacy validation gap'] })
    h.runtime.persistSession(h.managed)
    await h.manager.flushSession(h.managed.id)
    h.restore()

    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    expect(h.chatBudgets[1]).toMatchObject({
      userMessageId: anchor, attempts: 2, exhaustedAt: recoveryStartedAt + 3,
      validationExhausted: true, validationGaps: ['legacy validation gap'],
    })
    expect(h.chatBudgets[1]?.budgetHistoryUnavailable).not.toBe(true)
    expect(h.chatBudgets[1]?.explicitRetryAllowances).toHaveLength(1)
    expect(h.chatBudgets[1]?.explicitRetryAllowances?.[0]).toMatchObject({
      userMessageId: anchor, attemptBaseline: 2, attempts: 0, maxAttempts: 6,
    })
    expect(h.chatPrompts[1]).toContain('attempt="3"')
    expect(h.chatPrompts[1]).toContain('grants no new authorization for writes')
  })

it('migrates an exact legacy restart transcript anchored to the latest accepted amendment', async () => {
    const h = harness()
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const rootAnchor = h.managed.activeObjective!.userMessageId
    await h.manager.cancelProcessing(h.managed.id)
    await initial

    const rootTimestamp = h.managed.messages.find(message => message.id === rootAnchor)!.timestamp
    const amendmentId = 'legacy-public-amendment'
    const amendmentText = 'Conserve la réponse attendue et termine le contrôle.'
    h.managed.messages.push({
      id: amendmentId, role: 'user', content: amendmentText, timestamp: rootTimestamp + 10,
    })
    h.managed.activeObjective!.lastUserMessageId = amendmentId
    h.managed.activeObjective!.amendments = [{
      messageId: amendmentId, text: amendmentText, timestamp: rootTimestamp + 10,
    }]
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.interruptedTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'exhausted'
    const recoveryStartedAt = rootTimestamp + 20
    for (const attempt of [1, 2]) h.managed.messages.push({
      id: `legacy-amended-recovery-${attempt}`, role: 'user', hidden: true,
      timestamp: recoveryStartedAt + attempt,
      content: `<automatic_turn_recovery original_user_message_id="${amendmentId}" attempt="${attempt}">\nLegacy host recovery.\n</automatic_turn_recovery>`,
    })
    h.managed.messages.push({
      id: 'legacy-amended-validation-stop', role: 'error', timestamp: recoveryStartedAt + 3,
      content: 'Completion could not be verified.', errorCode: 'objective_validation_failed',
      errorCanRetry: true, errorDetails: ['legacy amended validation gap'],
    })
    h.runtime.persistSession(h.managed)
    await h.manager.flushSession(h.managed.id)
    h.restore()

    expect(h.managed.activeObjective).toMatchObject({
      userMessageId: rootAnchor,
      lastUserMessageId: amendmentId,
      terminalState: 'exhausted',
    })
    await h.manager.retryTurn(h.managed.id, amendmentId)
    await h.dispatch()
    expect(h.chatBudgets[1]).toMatchObject({
      userMessageId: amendmentId, attempts: 2, exhaustedAt: recoveryStartedAt + 3,
      validationExhausted: true, validationGaps: ['legacy amended validation gap'],
    })
    expect(h.chatBudgets[1]?.budgetHistoryUnavailable).not.toBe(true)
    expect(h.chatBudgets[1]?.explicitRetryAllowances?.[0]).toMatchObject({
      userMessageId: amendmentId, attemptBaseline: 2, attempts: 0, maxAttempts: 6,
    })
    expect(h.chatPrompts[1]).toContain('attempt="3"')
  })

it('keeps malformed, cross-objective, duplicate and over-cap legacy histories unavailable after restart', async () => {
    for (const variant of ['malformed', 'cross-objective', 'duplicate', 'over-cap'] as const) {
      const h = harness()
      const initial = h.manager.sendMessage(h.managed.id, prompt)
      await h.started.promise
      const anchor = h.managed.activeObjective!.userMessageId
      await h.manager.cancelProcessing(h.managed.id)
      await initial
      h.managed.pendingTurnRecovery = undefined
      h.managed.activeObjective!.interruptedTurnRecovery = undefined
      h.managed.activeObjective!.terminalState = 'exhausted'
      const startedAt = h.managed.messages.find(message => message.id === anchor)!.timestamp + 10
      const row = (id: string, objectiveId: string, attempt: number, contentAttempt = String(attempt)) => ({
        id, role: 'user' as const, hidden: true, timestamp: startedAt + attempt,
        content: `<automatic_turn_recovery original_user_message_id="${objectiveId}" attempt="${contentAttempt}">\nLegacy host recovery.\n</automatic_turn_recovery>`,
      })
      const rows = variant === 'malformed'
        ? [{ ...row('legacy-malformed', anchor, 1),
            content: `<automatic_turn_recovery original_user_message_id="${anchor}" attempt="1">malformed</automatic_turn_recovery>` }]
        : variant === 'cross-objective'
          ? [row('legacy-1', anchor, 1), row('legacy-cross', 'other-objective', 2)]
          : variant === 'duplicate'
            ? [row('legacy-1', anchor, 1), row('legacy-duplicate', anchor, 2, '1')]
            : [row('legacy-1', anchor, 1), row('legacy-over-cap', anchor, 2, '9')]
      h.managed.messages.push(...rows, {
        id: `legacy-validation-stop-${variant}`, role: 'error', timestamp: startedAt + 20,
        content: 'Completion could not be verified.', errorCode: 'objective_validation_failed',
        errorCanRetry: true, errorDetails: ['legacy validation gap'],
      })
      h.runtime.persistSession(h.managed)
      await h.manager.flushSession(h.managed.id)
      h.restore()

      await h.manager.retryTurn(h.managed.id, anchor)
      await h.dispatch()
      expect(h.chatBudgets[1]).toMatchObject({
        userMessageId: anchor, attempts: 0, budgetHistoryUnavailable: true,
      })
      expect(h.chatBudgets[1]?.explicitRetryAllowances).toBeUndefined()
    }
  })

for (const mismatch of ['objectiveId', 'userMessageId'] as const) {
    it(`refuses a persisted stopped snapshot from a different ${mismatch} without granting a new automatic budget`, async () => {
      const h = harness()
      const initial = h.manager.sendMessage(h.managed.id, prompt)
      await h.started.promise
      const anchor = h.managed.activeObjective!.userMessageId
      await h.manager.cancelProcessing(h.managed.id)
      await initial
      h.managed.activeObjective!.interruptedTurnRecovery![mismatch] = 'different-anchor-or-objective'
      h.runtime.persistSession(h.managed)
      await h.manager.flushSession(h.managed.id)
      h.restore()
      await h.manager.retryTurn(h.managed.id, anchor)
      await h.dispatch()
      expect(h.managed.pendingTurnRecovery?.budgetHistoryUnavailable).toBe(true)
      expect(h.managed.pendingTurnRecovery?.exhaustedAt).toBeGreaterThan(0)
      expect(h.managed.activeObjective?.objectiveId).toBe(anchor)
      expect(h.chats()).toBe(2)
    })
  }

it('does not reset an unknown legacy budget retained in a stopped snapshot', async () => {
    const h = harness()
    const initial = h.manager.sendMessage(h.managed.id, prompt)
    await h.started.promise
    const anchor = h.managed.activeObjective!.userMessageId
    await h.manager.cancelProcessing(h.managed.id)
    await initial
    // Simulate a persisted snapshot already carrying an unknown historical
    // budget; the new field must never launder it into fresh automatic credit.
    Object.assign(h.managed.activeObjective!.interruptedTurnRecovery!.recovery,
      { attempts: 4, budgetHistoryUnavailable: true, exhaustedAt: 123, leaseExpiresAt: 456 })
    h.runtime.persistSession(h.managed)
    await h.manager.flushSession(h.managed.id)
    h.restore()
    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    expect(h.managed.pendingTurnRecovery).toMatchObject({ attempts: 4, budgetHistoryUnavailable: true, exhaustedAt: 123, leaseExpiresAt: 456 })
    expect(h.chats()).toBe(2)
  })

it('persists a prospective Retry reserve, reuses its remainder after Stop, and never mints one from the hidden answer', async () => {
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
    await h.runtime.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.chats()).toBe(1)
    expect(h.managed.pendingTurnRecovery?.explicitRetryAllowances).toBeUndefined()

    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    const grant = structuredClone(h.managed.pendingTurnRecovery!.explicitRetryAllowances![0]!)
    expect(h.readHeader().pendingTurnRecovery.explicitRetryAllowances).toEqual([grant])
    await h.manager.respondToUserInput(h.managed.id, { requestId: h.requestId(),
      answers: [{ questionId: 'color', optionIds: ['blue'] }] })
    await h.answerStarted.promise
    expect(h.chatBudgets[2]?.explicitRetryAllowances).toEqual([grant])
    await h.manager.cancelProcessing(h.managed.id)
    await h.dispatch()
    await h.manager.flushSession(h.managed.id)
    const stoppedAnswerHeader = h.readHeader()
    expect(stoppedAnswerHeader.pendingTurnRecovery).toBeUndefined()
    expect(stoppedAnswerHeader.activeObjective.interruptedTurnRecovery.recovery.explicitRetryAllowances).toEqual([grant])

    // Recreate the exact shape written by an older host so startup migration,
    // not only the live Stop path above, proves it cannot spend the reserve.
    h.managed.pendingTurnRecovery = structuredClone(h.managed.activeObjective!.interruptedTurnRecovery!.recovery)
    h.managed.activeObjective!.interruptedTurnRecovery = undefined
    h.runtime.persistSession(h.managed)
    await h.manager.flushSession(h.managed.id)
    h.restore()
    await h.runtime.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.chats()).toBe(3)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    expect(h.readHeader().activeObjective.interruptedTurnRecovery.recovery.explicitRetryAllowances).toEqual([grant])

    await h.manager.retryTurn(h.managed.id, anchor)
    await h.dispatch()
    expect(h.chatBudgets[3]?.explicitRetryAllowances).toEqual([grant])
    expect(h.chatBudgets[3]?.attempts).toBe(2)
    expect(h.chatBudgets[3]?.exhaustedAt).toBe(99)
    expect(h.chatBudgets[3]?.leaseExpiresAt).toBe(100)
    expect(h.managed.messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(1)
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
  })
});
