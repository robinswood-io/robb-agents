import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, type UserInputQuestion, messageToStored } from '@craft-agent/core/types';
import { clearObjectiveEvidenceGate } from '@craft-agent/shared/agent';
import { readSessionJsonl, writeSessionJsonl } from '@craft-agent/shared/sessions/jsonl';
import { pickSessionFields } from '@craft-agent/shared/sessions/utils';
import { createManagedSession, SessionManager } from './SessionManager';
import { createPendingTurnRecovery } from './turn-recovery';
import { transitionObjectiveContract } from './objective-contract';
import { delegatedReviewFixture } from './__fixtures__/delegated-review';

type Managed = ReturnType<typeof createManagedSession>
const roots: string[] = []
const ids: string[] = []
const questions: UserInputQuestion[] = [{ id: 'format', question: 'Quel format souhaites-tu ?', options: [{ id: 'short', label: 'Court' }, { id: 'long', label: 'Détaillé' }] }]
const costLimitQuestions: UserInputQuestion[] = [{
  id: 'cost-limit-next-step',
  question: 'La limite monétaire dure de cette mission est atteinte. Tout nouvel appel fournisseur est arrêté. Quelle suite souhaitez-vous ?',
  options: [
    {
      id: 'stop-objective',
      label: 'Arrêter cette mission',
      description: 'Conserver les résultats actuels sans reprise automatique supplémentaire.',
      recommended: true,
    },
    {
      id: 'continue-once',
      label: 'Autoriser une reprise',
      description: 'Autoriser explicitement un unique tour utilisateur ; toute nouvelle reprise automatique sera de nouveau arrêtée.',
    },
  ],
}]
const answers = [{ questionId: 'format', optionIds: ['short'], text: 'avec les résultats' }]
const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 }
/** Wait for the actual next turn, including asynchronous context IO and cleanup. */
function nextDispatchCompletion(manager: SessionManager): Promise<void> {
  const send = manager.sendMessage.bind(manager)
  return new Promise<void>((resolve, reject) => {
    manager.sendMessage = (...args) => {
      manager.sendMessage = send
      const dispatch = send(...args)
      void dispatch.then(resolve, reject)
      return dispatch
    }
  })
}
function harness() {
  const rootPath = mkdtempSync(join(tmpdir(), 'robb-user-input-')); roots.push(rootPath)
  const managed = createManagedSession({ id: `input-test-${roots.length}` }, { id: 'workspace', name: 'Test', slug: 'test', rootPath, createdAt: 1 }, { messagesLoaded: true })
  ids.push(managed.id)
  managed.messages = [{ id: 'objective-root', role: 'user', content: 'Prépare et vérifie le rapport.', timestamp: 1 }]
  managed.activeObjective = { schemaVersion: 1, objectiveId: 'objective-root', userMessageId: 'objective-root', lastUserMessageId: 'objective-root', originalText: 'Prépare et vérifie le rapport.', startedAt: 1, continuationCount: 0, budgetBaselineUsd: 12, tokenBaseline: 300, orchestrationMode: 'mission', risk: 'standard', completionCriteria: ['requested-outcome-delivered'], terminalState: 'active' }
  managed.pendingTurnRecovery = { ...createPendingTurnRecovery('objective-root', 1), attempts: 3, stagnantAttempts: 1, leaseExpiresAt: 123456 }
  const manager = withSessionOperationsForTest(new SessionManager())
  const events: Array<Record<string, unknown>> = []
  const snapshots: Array<Record<string, unknown>> = []
  const internals = manager as unknown as {
    sessions: Map<string, Managed>; enqueuePersist: (m: Managed) => void; flushSession: (id: string) => Promise<void>
    sendEvent: (e: Record<string, unknown>) => void; enqueueAutomaticTurnRecovery: (m: Managed, cause: 'objective_incomplete') => Promise<boolean>
    resumePendingTurnAfterRestart: (id: string) => Promise<void>; onProcessingStopped: (id: string, reason: 'interrupted') => Promise<void>
    emitExecutionTelemetry: () => void; startGenerationTelemetry: () => void; finishGenerationTelemetry: () => void
    beginAutomaticSessionStatusLifecycle: () => Promise<void>; finishAutomaticSessionStatusLifecycle: () => Promise<void>
    isSessionBeingViewed: () => boolean; markSessionRead: () => Promise<void>; processNextQueuedMessage: (id: string) => void
    disposeManagedAgentRuntime: () => Promise<void>; getOrCreateAgent: (m: Managed) => Promise<unknown>
    ensureMessagesLoaded: (m: Managed) => Promise<void>
    ensureDelegatedTerminalResultDelivery: (child: Managed, deferRecipientDispatch?: boolean) => Promise<boolean>
    queuedMessageDispatches: Map<string, symbol>
  }
  sessionRuntimeStateForTest(manager).sessions.set(managed.id, managed)
  internals.enqueuePersist = m => snapshots.push(JSON.parse(JSON.stringify({ ...pickSessionFields(m), messages: m.messages })))
  internals.flushSession = async () => {}
  internals.sendEvent = e => events.push(e)
  internals.emitExecutionTelemetry = () => {}; internals.startGenerationTelemetry = () => {}; internals.finishGenerationTelemetry = () => {}
  internals.beginAutomaticSessionStatusLifecycle = async () => {}; internals.finishAutomaticSessionStatusLifecycle = async () => {}
  internals.isSessionBeingViewed = () => true; internals.markSessionRead = async () => {}
  const realProcessNextQueuedMessage = internals.processNextQueuedMessage.bind(manager)
  internals.processNextQueuedMessage = () => {}; internals.disposeManagedAgentRuntime = async () => { managed.agent = null }
  const redirects: string[] = []
  const installAgent = (steer = true, stream: AgentEvent[] = [], beforeChat?: () => void) => {
    const agent = { redirect: (text: string) => { redirects.push(text); return steer }, getModel: () => 'test', getSessionId: () => null, setAllSources: () => {}, async *chat() { beforeChat?.(); for (const e of stream) yield e } }
    managed.agent = agent as never; internals.getOrCreateAgent = async m => { m.agent = agent as never; return agent }
  }
  const restoreQueueProcessing = () => { internals.processNextQueuedMessage = realProcessNextQueuedMessage }
  return { manager, managed, internals, events, snapshots, redirects, installAgent, restoreQueueProcessing }
}
afterEach(() => { for (const id of ids) clearObjectiveEvidenceGate(id); for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.length = 0; ids.length = 0 })

describe('durable interactive user questions', () => {
it.each([
    'automatic-recovery-next-step',
    'clean-continuation-unavailable',
    'context-limit-next-step',
    'cost-limit-next-step',
  ])('executes %s stop-objective as a host terminal transition without a provider turn', async questionId => {
    const h = harness()
    let providerStarts = 0
    h.installAgent(false, [
      { type: 'tool_start', toolName: 'Bash', toolUseId: 'must-not-run', input: { command: 'false' } },
      { type: 'complete' },
    ], () => { providerStarts++ })
    const automaticMessage = {
      id: `queued-${questionId}`,
      role: 'user' as const,
      content: 'Synthetic automatic recovery that must be revoked.',
      timestamp: 2,
      hidden: true,
      isQueued: true,
    }
    h.managed.messages.push(automaticMessage)
    h.managed.messageQueue.push({
      message: automaticMessage.content,
      messageId: automaticMessage.id,
      options: {
        hidden: true,
        automaticRecovery: { originalUserMessageId: 'objective-root', cause: 'user_retry' },
      },
    })
    const { requestId } = await h.manager.requestUserInput(h.managed.id, [{
      id: questionId,
      question: 'Quelle suite souhaitez-vous ?',
      options: [
        { id: 'provide-guidance', label: 'Préciser la reprise' },
        { id: 'stop-objective', label: 'Arrêter cette mission' },
      ],
    }])

    const result = await h.manager.respondToUserInput(h.managed.id, {
      requestId,
      answers: [{ questionId, optionIds: ['stop-objective'] }],
    })

    expect(result).toEqual({ status: 'accepted' })
    expect(providerStarts).toBe(0)
    expect(h.managed.activeObjective).toMatchObject({
      terminalState: 'exhausted',
      completedAt: expect.any(Number),
    })
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.messages.some(message => message.id === automaticMessage.id)).toBe(false)
    expect(h.managed.messages.some(message => message.internalOrigin?.kind === 'user-input')).toBe(false)
    expect(h.managed.userInputRequests?.find(request => request.id === requestId)).toMatchObject({
      status: 'answered',
      answers: [{ questionId, optionIds: ['stop-objective'] }],
    })
  })

it('admits exactly the authenticated cost-limit continuation answer past the provider fence', async () => {
    const h = harness()
    h.managed.tokenUsage = { ...usage, costUsd: 37 }
    let providerStarts = 0
    h.installAgent(false, [{ type: 'complete' }], () => { providerStarts++ })
    h.internals.enqueueAutomaticTurnRecovery = async () => false
    const completion = nextDispatchCompletion(h.manager)
    const { requestId } = await h.manager.requestUserInput(h.managed.id, costLimitQuestions)

    const result = await h.manager.respondToUserInput(h.managed.id, {
      requestId,
      answers: [{ questionId: 'cost-limit-next-step', optionIds: ['continue-once'] }],
    })
    await completion

    expect(result).toMatchObject({ status: 'accepted', delivery: 'started' })
    expect(providerStarts).toBe(1)
    expect(h.managed.userInputRequests?.[0]).toMatchObject({
      status: 'answered',
      answers: [{ questionId: 'cost-limit-next-step', optionIds: ['continue-once'] }],
    })
  })

it('spends one cost-limit continuation on the agent delivery already at the FIFO head', async () => {
    const h = harness()
    h.managed.tokenUsage = { ...usage, costUsd: 37 }
    h.managed.pendingTurnRecovery = undefined
    let providerStarts = 0
    let providerStarted!: () => void
    const started = new Promise<void>(resolve => { providerStarted = resolve })
    h.installAgent(false, [{ type: 'complete' }], () => {
      providerStarts++
      providerStarted()
    })
    h.internals.enqueueAutomaticTurnRecovery = async () => false

    const child = createManagedSession(
      { id: `${h.managed.id}-cost-child`, parentSessionId: h.managed.id },
      h.managed.workspace,
      { messagesLoaded: true },
    )
    const parentObjectiveId = h.managed.activeObjective!.objectiveId
      ?? h.managed.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: h.managed.id,
      rootObjectiveId: parentObjectiveId,
      parentObjectiveId,
      depth: 1,
      role: 'worker',
      finishedAt: 3,
    }
    child.messages = [
      { id: 'cost-child-root', role: 'user', content: 'Vérifie le rapport.', timestamp: 2 },
      { id: 'cost-child-final', role: 'assistant', content: 'Rapport vérifié.', timestamp: 3 },
    ]
    child.activeObjective = {
      ...transitionObjectiveContract({ messageId: 'cost-child-root', text: 'Vérifie le rapport.', nowMs: 2 }),
      terminalState: 'complete_verified',
      completedAt: 3,
    }
    child.pendingTurnRecovery = undefined
    sessionRuntimeStateForTest(h.internals).sessions.set(child.id, child)

    // Hold the recipient so terminal delivery is durably accepted into FIFO
    // before the user grants the one-use cost continuation.
    h.managed.isProcessing = true
    expect(await h.internals.ensureDelegatedTerminalResultDelivery(child)).toBe(true)
    h.managed.isProcessing = false
    const receipt = h.managed.messages.find(message => message.agentDelivery)
    expect(receipt).toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 0 } })
    expect(h.managed.messageQueue.map(item => item.messageId)).toEqual([receipt!.id])

    const { requestId } = await h.manager.requestUserInput(h.managed.id, costLimitQuestions)
    h.restoreQueueProcessing()
    const response = await h.manager.respondToUserInput(h.managed.id, {
      requestId,
      answers: [{ questionId: 'cost-limit-next-step', optionIds: ['continue-once'] }],
    })
    await started
    for (let attempt = 0; attempt < 20 && h.managed.isProcessing; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    const answer = h.managed.messages.find(message => message.id === response.responseMessageId)
    expect(response).toMatchObject({ status: 'accepted', delivery: 'queued' })
    expect(providerStarts).toBe(1)
    expect(receipt).toMatchObject({ isQueued: false, agentDelivery: { status: 'processed', attempts: 1 } })
    expect(answer).toMatchObject({ isQueued: false, internalOrigin: { kind: 'user-input' } })
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.userInputRequests?.filter(request => request.status === 'pending')).toEqual([])
  })

it('delivers an observed negative review after a human answer without retrying the findings or replacing the objective', async () => {
    const h = harness(); const f = delegatedReviewFixture('objective-root')
    h.managed.parentSessionId = 'review-parent'
    h.managed.messages[0]!.content = f.scope
    h.managed.messages.push(f.observation)
    h.managed.activeObjective = f.objective
    const originalObjective = structuredClone(f.objective)
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    let recoveries = 0
    h.internals.enqueueAutomaticTurnRecovery = async () => { recoveries++; return false }
    h.installAgent(true, [{ type: 'text_complete', text: f.finalText, turnId: 'negative-review' }, { type: 'complete' }])
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    const result = await h.manager.respondToUserInput(h.managed.id, { requestId, answers })
    // The response acknowledges durable admission before preparation/IO finishes.
    // Await the real turn promise, not a number of event-loop iterations.
    expect(dispatch).toBeDefined()
    await dispatch
    expect(h.managed.isProcessing).toBe(false)
    expect(result.delivery).toBe('started')
    expect(recoveries).toBe(0)
    expect(h.managed.activeObjective).toMatchObject({ userMessageId: 'objective-root', terminalState: 'complete_verified', budgetBaselineUsd: 12, tokenBaseline: 300 })
    for (const key of ['objectiveId', 'userMessageId', 'lastUserMessageId', 'originalText', 'startedAt',
      'continuationCount', 'acceptanceCriteria', 'acceptanceRegisteredAt', 'acceptanceRevision',
      'acceptanceHistory', 'acceptanceNeedsReview', 'amendments'] as const) {
      expect(h.managed.activeObjective?.[key]).toEqual(originalObjective[key])
    }
    expect(h.managed.activeObjective?.lastOutcome?.criteria.map(item => item.id)).toEqual(['delegated-review-delivered'])
    const final = h.managed.messages.find(message => message.turnId === 'negative-review')
    expect(final?.content).toBe(f.finalText)
    expect(final?.isIntermediate).not.toBe(true)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    expect(h.managed.messages.filter(message => message.internalOrigin?.kind === 'user-input')).toHaveLength(1)
    expect(h.events.some(event => event.type === 'complete')).toBe(true)
  })

it('deduplicates identical pending questions, rejects replacement, and restores the header without messages', async () => {
    const h = harness()
    const first = await h.manager.requestUserInput(h.managed.id, questions)
    expect(await h.manager.requestUserInput(h.managed.id, questions)).toEqual(first)
    await expect(h.manager.requestUserInput(h.managed.id, [{ id: 'other', question: 'Autre question' }])).rejects.toThrow('pending')
    expect(h.managed.userInputRequests).toHaveLength(1)
    const path = join(h.managed.workspace.rootPath, 'session.jsonl')
    writeSessionJsonl(path, { ...pickSessionFields(h.managed), workspaceRootPath: h.managed.workspace.rootPath, createdAt: 1, lastUsedAt: 2, messages: h.managed.messages.map(messageToStored), tokenUsage: usage } as never)
    const restored = readSessionJsonl(path)!
    expect(restored.userInputRequests).toEqual(h.managed.userInputRequests)
    const cold = createManagedSession(restored as never, h.managed.workspace)
    sessionRuntimeStateForTest(h.internals).sessions.set(cold.id, cold)
    expect(h.manager.getSessions()[0]?.userInputRequests).toEqual(restored.userInputRequests)
    expect(cold.messages).toEqual([])
  })

it('aggregates descendants only in their workspace, preserving the origin and detached event snapshots', async () => {
    const h = harness()
    const child = createManagedSession({ id: 'child', parentSessionId: h.managed.id }, h.managed.workspace, { messagesLoaded: true })
    const foreign = createManagedSession({ id: 'foreign', parentSessionId: h.managed.id }, { ...h.managed.workspace, id: 'elsewhere' }, { messagesLoaded: true })
    sessionRuntimeStateForTest(h.internals).sessions.set(child.id, child); sessionRuntimeStateForTest(h.internals).sessions.set(foreign.id, foreign)
    await h.manager.requestUserInput(child.id, questions)
    await h.manager.requestUserInput(foreign.id, questions)
    const rootDTO = await h.manager.getSession(h.managed.id)
    expect(rootDTO?.userInputRequests).toHaveLength(1)
    expect(rootDTO?.userInputRequests?.[0]).toMatchObject({ sessionId: 'child', originWorkspaceId: 'workspace' })
    expect(h.managed.userInputRequests).toBeUndefined()
    const event = h.events.find(e => e.type === 'user_input_changed' && e.sessionId === h.managed.id)!
    await h.manager.respondToUserInput(child.id, { requestId: child.userInputRequests![0]!.id, cancelled: true })
    expect(event).toMatchObject({ requests: [{ status: 'pending' }] })
    expect((await h.manager.getSession(h.managed.id))?.userInputRequests?.[0]?.status).toBe('cancelled')
    await expect(h.manager.respondToUserInput(h.managed.id, { requestId: foreign.userInputRequests![0]!.id, answers })).rejects.toThrow('belong')
  })

it('queues one durable answer under concurrent retries and preserves the objective and recovery budgets', async () => {
    const h = harness(); h.installAgent(); h.managed.isProcessing = true
    const objective = structuredClone(h.managed.activeObjective)
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    const [first, duplicate] = await Promise.all([h.manager.respondToUserInput(h.managed.id, { requestId, answers }), h.manager.respondToUserInput(h.managed.id, { requestId, answers })])
    expect(first).toMatchObject({ status: 'accepted', delivery: 'queued' })
    expect(duplicate.responseMessageId).toBe(first.responseMessageId)
    expect(h.redirects).toHaveLength(0)
    expect(h.managed.messages).toHaveLength(2)
    expect(h.managed.messages[1]).toMatchObject({ id: first.responseMessageId, role: 'user', hidden: true, internalOrigin: { kind: 'user-input' }, isQueued: true })
    expect(h.managed.activeObjective).toEqual(objective)
    expect(h.managed.pendingTurnRecovery).toMatchObject({ attempts: 3, stagnantAttempts: 1, startedAt: 1, leaseExpiresAt: 123456, userMessageId: 'objective-root' })
    expect(await h.manager.respondToUserInput(h.managed.id, { requestId, answers })).toMatchObject({ status: 'already_answered', responseMessageId: first.responseMessageId })
    await expect(h.manager.respondToUserInput(h.managed.id, { requestId, answers: [{ questionId: 'format', optionIds: ['long'] }] })).rejects.toThrow('different')
    const receipt = h.snapshots.find(snapshot => (snapshot.userInputRequests as Array<{status:string}>)?.[0]?.status === 'answered')!
    expect(receipt).toMatchObject({ userInputRequests: [{ responseMessageId: first.responseMessageId }], messages: [{}, { id: first.responseMessageId, isQueued: true }] })
  })

it('resumes the same already-acknowledged answer behind a restored permission wait without granting permission', async () => {
    const h = harness(); h.installAgent(false, [{ type: 'complete' }]); h.managed.isProcessing = true
    Object.assign(h.managed.agent!, { isProcessing: () => false })
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    const receipt = await h.manager.respondToUserInput(h.managed.id, { requestId, answers })
    expect(receipt.delivery).toBe('queued')
    h.managed.isProcessing = false
    h.managed.pendingTurnRecovery!.waitingForPermission = { requestId: 'old-permission', requestedAt: 2, toolName: 'Bash', recoveryRequired: true }
    const objective = structuredClone(h.managed.activeObjective)
    let releaseAgent!: () => void
    const ready = new Promise<void>(resolve => { releaseAgent = resolve })
    const getAgent = h.internals.getOrCreateAgent.bind(h.manager)
    h.internals.getOrCreateAgent = async managed => { await ready; return getAgent(managed) }
    let dispatch: Promise<void> | undefined
    const send = h.manager.sendMessage.bind(h.manager)
    h.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    expect(await h.manager.retryTurn(h.managed.id, 'objective-root')).toEqual({ status: 'started' })
    expect(h.managed.userInputRequests).toMatchObject([{ id: requestId, status: 'answered', responseMessageId: receipt.responseMessageId }])
    expect(h.managed.messages.filter(message => message.role === 'user')).toHaveLength(2)
    expect(h.managed.messages[1]).toMatchObject({ id: receipt.responseMessageId, isQueued: false, hidden: true })
    expect(h.managed.pendingTurnRecovery).toMatchObject({ userMessageId: receipt.responseMessageId, attempts: 3, stagnantAttempts: 1, leaseExpiresAt: 123456 })
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
    expect(h.managed.activeObjective).toEqual(objective)
    expect(h.redirects).toEqual([])
    // A genuinely open question remains a blocker; a saved answer is not one.
    await h.manager.requestUserInput(h.managed.id, [{ id: 'next', question: 'Quel détail ajouter ?' }])
    await expect(h.manager.retryTurn(h.managed.id, 'objective-root')).rejects.toThrow('pending questions')
    releaseAgent()
    await dispatch
  })

for (const resolution of ['answered', 'cancelled'] as const) {
    it(`wakes a parent's saved answer after its last child question is ${resolution}, and publishes idle while waiting`, async () => {
      const h = harness(); h.installAgent(false, [{ type: 'complete' }]); h.managed.isProcessing = true
      const child = createManagedSession({ id: `child-${resolution}`, parentSessionId: h.managed.id }, h.managed.workspace, { messagesLoaded: true })
      child.messages = [{ id: 'child-root', role: 'user', content: 'Verify the existing report.', timestamp: 1 }]
      child.activeObjective = { ...h.managed.activeObjective!, objectiveId: 'child-root', userMessageId: 'child-root', lastUserMessageId: 'child-root' }
      child.pendingTurnRecovery = createPendingTurnRecovery('child-root')
      child.isProcessing = true
      sessionRuntimeStateForTest(h.internals).sessions.set(child.id, child)
      const parentQuestion = await h.manager.requestUserInput(h.managed.id, questions)
      const childQuestion = await h.manager.requestUserInput(child.id, questions)
      const receipt = await h.manager.respondToUserInput(h.managed.id, { requestId: parentQuestion.requestId, answers })
      h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
      await h.internals.onProcessingStopped(h.managed.id, 'interrupted')
      expect(h.managed.isProcessing).toBe(false)
      expect(h.managed.messageQueue.map(item => item.messageId)).toEqual([receipt.responseMessageId])
      expect(h.events.some(event => event.type === 'complete' && event.sessionId === h.managed.id && event.reason === 'interrupted')).toBe(true)
      let releaseAgent!: () => void
      const ready = new Promise<void>(resolve => { releaseAgent = resolve })
      const prepared: string[] = []
      const getAgent = h.internals.getOrCreateAgent.bind(h.manager)
      h.internals.getOrCreateAgent = async managed => { prepared.push(managed.id); await ready; return getAgent(managed) }
      let parentDispatch: Promise<void> | undefined
      const send = h.manager.sendMessage.bind(h.manager)
      h.manager.sendMessage = (...args) => { const promise = send(...args); if (args[0] === h.managed.id) parentDispatch = promise; return promise }
      const response = { requestId: childQuestion.requestId, ...(resolution === 'answered' ? { answers } : { cancelled: true }) }
      await h.manager.respondToUserInput(child.id, response)
      for (let index = 0; index < 20 && !prepared.length; index++) await new Promise<void>(resolve => setImmediate(resolve))
      expect(prepared).toEqual([h.managed.id])
      expect(h.managed.messages.find(message => message.id === receipt.responseMessageId)?.isQueued).toBe(false)
      expect(h.managed.userInputRequests?.[0]).toMatchObject({ status: 'answered', responseMessageId: receipt.responseMessageId })
      expect(h.managed.pendingTurnRecovery).toMatchObject({ userMessageId: receipt.responseMessageId, attempts: 3, stagnantAttempts: 1, leaseExpiresAt: 123456 })
      await h.manager.respondToUserInput(child.id, response)
      expect(prepared).toHaveLength(1)
      await h.manager.requestUserInput(child.id, [{ id: 'next', question: 'Quel détail ajouter ?' }])
      releaseAgent(); await parentDispatch
    })
  }

it('queues a valid answer once if steering is unavailable, without coalescing it with agent messages', async () => {
    const h = harness(); h.installAgent(false); h.managed.isProcessing = true
    h.managed.messageQueue.push({ message: 'Independent agent report', options: { internalOrigin: { kind: 'agent-message' } } })
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    const result = await h.manager.respondToUserInput(h.managed.id, { requestId, answers })
    expect(result.delivery).toBe('queued')
    expect(h.managed.messageQueue).toHaveLength(2)
    expect(h.managed.messageQueue[1]?.messageId).toBe(result.responseMessageId)
    await h.manager.respondToUserInput(h.managed.id, { requestId, answers })
    expect(h.managed.messageQueue).toHaveLength(2)
    expect(h.managed.activeObjective?.userMessageId).toBe('objective-root')
  })
});
