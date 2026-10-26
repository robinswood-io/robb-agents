import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { ScriptedSessionAgent } from './testing/scripted-session-agent.ts';
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import "@craft-agent/core/types";
import { clearObjectiveEvidenceGate } from '@craft-agent/shared/agent';
import "@craft-agent/shared/sessions/jsonl";
import { pickSessionFields } from '@craft-agent/shared/sessions/utils';
import { createManagedSession, SessionManager } from './SessionManager';
import { buildAutomaticTurnRecoveryPrompt, createPendingTurnRecovery } from './turn-recovery';
import { transitionObjectiveContract } from './objective-contract';
import "./__fixtures__/delegated-review";

import type { SessionOperations } from './SessionManager/operation-types.ts';







import { type AgentEvent, type UserInputQuestion } from '@craft-agent/core/types';






type Managed = ReturnType<typeof createManagedSession>
const roots: string[] = []
const ids: string[] = []
const questions: UserInputQuestion[] = [{ id: 'format', question: 'Quel format souhaites-tu ?', options: [{ id: 'short', label: 'Court' }, { id: 'long', label: 'Détaillé' }] }]
const answers = [{ questionId: 'format', optionIds: ['short'], text: 'avec les résultats' }]
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
it('does not wake an idle session if Stop arrives while the answer is being flushed', async () => {
    const h = harness(); h.installAgent()
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    let release!: () => void
    const flushing = new Promise<void>(resolve => { release = resolve })
    let flushingAnswer = false
    h.internals.flushSession = async () => { if (!flushingAnswer) { flushingAnswer = true; await flushing } }
    const response = h.manager.respondToUserInput(h.managed.id, { requestId, answers })
    await new Promise<void>(resolve => setImmediate(resolve))
    await h.manager.cancelProcessing(h.managed.id)
    release()
    await expect(response).rejects.toThrow('endpoint')
    expect(h.managed.isProcessing).toBe(false)
    expect(h.managed.userInputRequests?.[0]?.status).toBe('cancelled')
    expect(h.managed.messages[1]?.isQueued).toBe(false)
    expect(h.redirects).toEqual([])
  })

it('finishes a pure text objective after a durable answer without classifying the technical wrapper as a new mission', async () => {
    const h = harness()
    const userText = 'Résume mes préférences en une courte phrase.'
    h.managed.messages[0]!.content = userText
    h.managed.activeObjective = { ...transitionObjectiveContract({ messageId: 'objective-root', text: userText, nowMs: 1 }), model: 'pi/gpt-5.6-terra', thinkingLevel: 'medium' }
    h.managed.model = 'pi/gpt-5.6-terra'; h.managed.thinkingLevel = 'medium'
    const original = structuredClone(h.managed.activeObjective)
    expect(original).toMatchObject({ risk: 'standard', orchestrationMode: 'direct' })
    expect(original?.requiresExecutionEvidence).toBeUndefined()
    expect(original?.requiresObservationEvidence).toBeUndefined()
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    const finalText = 'Voici le résumé demandé : format court, avec les résultats.'
    let classifiedObjective: Managed['activeObjective']
    h.installAgent(true, [{ type: 'text_complete', text: finalText, turnId: 'answer-final' }, { type: 'complete' }], () => {
      classifiedObjective = structuredClone(h.managed.activeObjective)
    })
    // Exercise the real getOrCreateAgent cost classifier; only external runtime
    // services are adapted. Mocking getOrCreateAgent would hide this regression.
    const routing = h.manager as unknown as {
      applyRoutingPolicyForNextTurn: () => Promise<void>
      applyExternalActionPolicyToRuntime: () => void
      tryRefreshAgentRuntime: () => Promise<void>
    }
    routing.applyRoutingPolicyForNextTurn = async () => {}
    routing.applyExternalActionPolicyToRuntime = () => {}
    routing.tryRefreshAgentRuntime = async () => {}
    h.internals.getOrCreateAgent = Object.getPrototypeOf(h.manager).getOrCreateAgent.bind(h.manager)
    const dispatchFinished = nextDispatchCompletion(h.manager)
    const result = await h.manager.respondToUserInput(h.managed.id, { requestId, answers })
    expect(result.delivery).toBe('started')
    await dispatchFinished
    expect(classifiedObjective).toEqual(original)
    expect(h.managed.activeObjective).toMatchObject({ objectiveId: original!.objectiveId, risk: 'standard', orchestrationMode: 'direct', terminalState: 'complete_verified' })
    const final = h.managed.messages.find(message => message.turnId === 'answer-final')
    expect(final?.content).toBe(finalText)
    expect(final?.isIntermediate).not.toBe(true)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.userInputRequests?.[0]?.status).toBe('answered')
  })

it('keeps the initial direct contract when routing risk comes from an old conversation title', async () => {
    const h = harness()
    const text = 'Utilise request_user_input pour me demander ma couleur préférée entre Bleu et Vert. Attends ma réponse. Réponds uniquement avec 1200 mots sur ma couleur choisie. Aucune action externe, aucun fichier, aucune autre tâche.'
    h.managed.messages[0]!.content = text
    h.managed.name = 'Previous security audit'
    h.managed.activeObjective = transitionObjectiveContract({ messageId: 'objective-root', text, nowMs: 1,
      lifetimeCostUsd: 12, lifetimeTokens: 300 })
    const original = structuredClone(h.managed.activeObjective)
    expect(original).toMatchObject({ orchestrationMode: 'direct', risk: 'standard' })
    h.installAgent()
    const runtime = h.manager as unknown as SessionOperations
    runtime.applyExternalActionPolicyToRuntime = () => false
    runtime.tryRefreshAgentRuntime = async () => {}
    runtime.getOrCreateAgent = Object.getPrototypeOf(h.manager).getOrCreateAgent.bind(h.manager)
    await runtime.getOrCreateAgent(h.managed, { message: text, messageId: 'objective-root' })
    // The real cost classifier may choose a different model or reasoning level;
    // no other objective field belongs to that routing decision.
    const { model: _model, thinkingLevel: _thinking, ...after } = h.managed.activeObjective!
    expect(after).toEqual(original)
  })

it.each(['user_retry', 'app_restart', 'objective_incomplete'] as const)('preserves the direct contract through the real %s preparation envelope', async cause => {
    const h = harness()
    const text = 'Utilise request_user_input pour me demander ma couleur préférée entre Bleu et Vert. Attends ma réponse. Réponds uniquement avec 1200 mots sur ma couleur choisie. Aucune action externe, aucun fichier, aucune autre tâche.'
    h.managed.messages[0]!.content = text
    h.managed.activeObjective = transitionObjectiveContract({ messageId: 'objective-root', text, nowMs: 1,
      lifetimeCostUsd: 12, lifetimeTokens: 300 })
    const original = structuredClone(h.managed.activeObjective)
    h.installAgent()
    const runtime = h.manager as unknown as SessionOperations
    runtime.applyExternalActionPolicyToRuntime = () => false
    runtime.tryRefreshAgentRuntime = async () => {}
    runtime.getOrCreateAgent = Object.getPrototypeOf(h.manager).getOrCreateAgent.bind(h.manager)
    const message = buildAutomaticTurnRecoveryPrompt(h.managed.pendingTurnRecovery!, cause)
    await runtime.getOrCreateAgent(h.managed, { message, messageId: 'objective-root',
      options: { hidden: true, automaticRecovery: { originalUserMessageId: 'objective-root', cause } } })
    const { model: _model, thinkingLevel: _thinking, ...after } = h.managed.activeObjective!
    expect(after).toEqual(original)
    expect(h.managed.messages).toHaveLength(1)
  })

it('keeps a high-risk mission and its registered acceptance checks through runtime preparation', async () => {
    const h = harness()
    const text = 'Fix the security configuration, then verify the service.'
    h.managed.messages[0]!.content = text
    h.managed.activeObjective = { ...transitionObjectiveContract({ messageId: 'objective-root', text, nowMs: 1,
      lifetimeCostUsd: 12, lifetimeTokens: 300 }),
      acceptanceRegisteredAt: 2,
      acceptanceCriteria: [{ id: 'service-ready', description: 'Requested service verified', toolName: 'Read',
        input: { path: '/service.json' }, checks: [{ path: '$.ready', equals: true }] }],
    }
    const original = structuredClone(h.managed.activeObjective)
    expect(original).toMatchObject({ orchestrationMode: 'mission', risk: 'high-stakes', requiresExecutionEvidence: true,
      requiresObservationEvidence: true, requiresAcceptanceCriteria: true })
    expect(original.completionCriteria).toContain('independent-review-passed')
    h.installAgent()
    const runtime = h.manager as unknown as SessionOperations
    runtime.applyExternalActionPolicyToRuntime = () => false
    runtime.tryRefreshAgentRuntime = async () => {}
    runtime.getOrCreateAgent = Object.getPrototypeOf(h.manager).getOrCreateAgent.bind(h.manager)
    await runtime.getOrCreateAgent(h.managed, { message: 'Continue', messageId: 'objective-root', options: { hidden: true,
      automaticRecovery: { originalUserMessageId: 'objective-root', cause: 'user_retry' } } })
    const { model: _model, thinkingLevel: _thinking, ...after } = h.managed.activeObjective!
    expect(after).toEqual(original)
  })

for (const sessionStatus of ['blocked', 'done'] as const) {
    it(`lets only the exact live human continuation supersede an expired permission in ${sessionStatus} status`, async () => {
      const h = harness()
      h.managed.sessionStatus = sessionStatus
      h.managed.activeObjective!.terminalState = 'blocked_human'
      h.managed.activeObjective!.completedAt = 10
      h.managed.pendingTurnRecovery!.waitingForPermission = {
        requestId: 'expired-permission', requestedAt: 2, toolName: 'Bash', toolUseId: 'old-tool', recoveryRequired: true,
      }
      h.managed.messages.push({
        id: 'old-tool-message', role: 'tool', content: '', timestamp: 2, toolName: 'Bash', toolUseId: 'old-tool',
        toolStatus: 'error', toolResult: 'Authorization closed before execution.', toolExecuted: false, isError: true,
      }, {
        id: 'machine-delivery', role: 'user', content: 'old machine delivery', timestamp: 3, isQueued: true,
        internalOrigin: { kind: 'agent-message', senderSessionId: 'child', deliveryId: 'delivery' },
        agentDelivery: { id: 'delivery', status: 'queued', attempts: 0 },
      })
      h.managed.messageQueue.push({
        messageId: 'machine-delivery', message: 'old machine delivery',
        options: { internalOrigin: { kind: 'agent-message', senderSessionId: 'child', deliveryId: 'delivery' } },
      })
      const permissionResponses: Array<[string, boolean, boolean]> = []
      const permissionAgent = Object.assign(new ScriptedSessionAgent(h.managed.workspace), {
        respondToPermission: (id: string, allowed: boolean, always: boolean) => { permissionResponses.push([id, allowed, always]); },
      })
      h.managed.agent = permissionAgent
      ;sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set('expired-permission', {
        sessionId: h.managed.id, toolName: 'Bash', toolUseId: 'old-tool', processingGeneration: h.managed.processingGeneration,
        runtimeAgent: permissionAgent, requestedAt: 2, expiresAt: Date.now() + 60_000,
        request: { requestId: 'expired-permission', sessionId: h.managed.id, toolName: 'Bash', description: 'Offline permission fixture' }, timeout: setTimeout(() => {}, 60_000),
      })
      h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
      const send = h.manager.sendMessage.bind(h.manager)
      const replayed: string[] = []
      h.manager.sendMessage = (...args) => {
        if (args[5]) {
          replayed.push(args[5])
          args[7]?.(args[5])
          return Promise.resolve()
        }
        return send(...args)
      }

      await h.manager.sendMessage(h.managed.id, 'Continue la mission en tenant compte de mon instruction.')
      for (let index = 0; index < 20 && !replayed.length; index++) await new Promise<void>(resolve => setImmediate(resolve))

      expect(replayed).toHaveLength(1)
      expect(h.managed.messages.find(message => message.id === replayed[0])).toMatchObject({
        role: 'user', content: 'Continue la mission en tenant compte de mon instruction.',
      })
      expect(h.managed.messages.find(message => message.id === replayed[0])?.hidden).toBeUndefined()
      expect(h.managed.messageQueue.map(item => item.messageId)).toEqual(['machine-delivery'])
      expect(h.managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
      expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.size).toBe(0)
      expect(permissionResponses).toEqual([['expired-permission', false, false]])
      expect(h.managed.messages.find(message => message.toolUseId === 'old-tool')).toMatchObject({
        toolExecuted: false, toolStatus: 'error', isError: true,
      })
      expect(h.manager.respondToPermission(h.managed.id, 'expired-permission', true, true)).toBe(false)
      expect(permissionResponses).toHaveLength(1)
    })
  }

it('cancels only the obsolete local pending question before dispatching a direct continuation', async () => {
    const h = harness()
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    const send = h.manager.sendMessage.bind(h.manager)
    const replayed: string[] = []
    h.manager.sendMessage = (...args) => {
      if (args[5]) { replayed.push(args[5]); args[7]?.(args[5]); return Promise.resolve() }
      return send(...args)
    }

    await h.manager.sendMessage(h.managed.id, 'Le canal est ISAGRI. Poursuis et termine la mission.')
    for (let index = 0; index < 20 && !replayed.length; index++) await new Promise<void>(resolve => setImmediate(resolve))

    expect(replayed).toHaveLength(1)
    expect(h.managed.userInputRequests).toMatchObject([{ id: requestId, status: 'cancelled' }])
    expect(h.managed.userInputRequests?.[0]?.answers).toBeUndefined()
    expect(h.managed.userInputRequests?.[0]?.responseMessageId).toBeUndefined()
    expect(h.managed.messages.some(message => message.internalOrigin?.kind === 'user-input')).toBe(false)
    expect((h.internals as unknown as Pick<SessionOperations, 'autonomousAdmissionBlock'>).autonomousAdmissionBlock(h.managed, true, false)).toBeUndefined()
    expect(h.events.some(event => event.type === 'user_input_changed'
      && (event.requests as Array<{ status: string }>)[0]?.status === 'cancelled')).toBe(true)
  })

it('keeps an answered structured response ahead of a simultaneous direct continuation', async () => {
    const h = harness()
    const { requestId } = await h.manager.requestUserInput(h.managed.id, questions)
    let releaseAnswerFlush!: () => void
    const answerFlush = new Promise<void>(resolve => { releaseAnswerFlush = resolve })
    let flushes = 0
    h.internals.flushSession = async () => { if (++flushes === 1) await answerFlush }
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    const send = h.manager.sendMessage.bind(h.manager)
    const replayed: string[] = []
    h.manager.sendMessage = (...args) => {
      if (args[5]) { replayed.push(args[5]); args[7]?.(args[5]); return Promise.resolve() }
      return send(...args)
    }

    const response = h.manager.respondToUserInput(h.managed.id, { requestId, answers })
    for (let index = 0; index < 20 && h.managed.userInputRequests?.[0]?.status !== 'answered'; index++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const responseMessageId = h.managed.userInputRequests![0]!.responseMessageId!
    await h.manager.sendMessage(h.managed.id, 'Poursuis aussi avec cette précision libre.')

    expect(h.managed.userInputRequests?.[0]).toMatchObject({ status: 'answered', responseMessageId, answers })
    expect(h.managed.messages.find(message => message.id === responseMessageId)).toMatchObject({
      hidden: true, isQueued: true, internalOrigin: { kind: 'user-input' },
    })
    expect(replayed).toEqual([])
    expect(h.managed.messageQueue).toHaveLength(1)
    releaseAnswerFlush()
    await response
    expect(replayed[0]).toBe(responseMessageId)
    expect(h.managed.userInputRequests?.[0]?.status).toBe('answered')
    expect(h.managed.messageQueue).toHaveLength(1)
    expect(h.managed.messageQueue[0]?.message).toBe('Poursuis aussi avec cette précision libre.')
  })

it('keeps cold terminal and duplicate identities fail-closed, but releases no live message before its flush', async () => {
    const h = harness()
    h.managed.sessionStatus = 'done'
    h.managed.activeObjective!.terminalState = 'blocked_human'
    h.managed.activeObjective!.completedAt = 10
    h.managed.pendingTurnRecovery!.waitingForPermission = {
      requestId: 'expired', requestedAt: 2, toolName: 'Bash', recoveryRequired: true,
    }
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    const send = h.manager.sendMessage.bind(h.manager)
    const replayed: string[] = []
    h.manager.sendMessage = (...args) => {
      if (args[5]) { replayed.push(args[5]); args[7]?.(args[5]); return Promise.resolve() }
      return send(...args)
    }

    h.managed.messages.push({ id: 'cold-human', role: 'user', content: 'old cold row', timestamp: 3, isQueued: true })
    h.managed.messageQueue.push({ messageId: 'cold-human', message: 'old cold row' })
    h.internals.processNextQueuedMessage(h.managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(replayed).toEqual([])

    // Even an injected transient id cannot authenticate an ambiguous transcript.
    h.managed.messages.push({ id: 'cold-human', role: 'user', content: 'old cold row', timestamp: 4, isQueued: true })
    ;sessionRuntimeStateForTest(h.internals).liveDirectHumanContinuationIds.set(h.managed, new Set(['cold-human']))
    h.internals.processNextQueuedMessage(h.managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(replayed).toEqual([])
    h.managed.messages.pop()
    ;sessionRuntimeStateForTest(h.internals).liveDirectHumanContinuationIds.delete(h.managed)

    let releaseFlush!: () => void
    const flushing = new Promise<void>(resolve => { releaseFlush = resolve })
    h.internals.flushSession = async () => { await flushing }
    const liveSend = h.manager.sendMessage(h.managed.id, 'fresh live row')
    for (let index = 0; index < 20
      && !h.managed.messages.some(message => message.content === 'fresh live row'); index++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    h.internals.processNextQueuedMessage(h.managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(replayed).toEqual([])
    releaseFlush()
    await liveSend
    for (let index = 0; index < 20 && !replayed.length; index++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(h.managed.messages.find(message => message.id === replayed[0])?.content).toBe('fresh live row')
    expect(h.managed.messageQueue.map(item => item.messageId)).toEqual(['cold-human'])
  })

it('does not dispatch an open-session continuation whose durability fence fails', async () => {
    const h = harness()
    await h.manager.requestUserInput(h.managed.id, questions)
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    const send = h.manager.sendMessage.bind(h.manager)
    const replayed: string[] = []
    h.manager.sendMessage = (...args) => {
      if (args[5]) { replayed.push(args[5]); return Promise.resolve() }
      return send(...args)
    }
    h.internals.flushSession = async () => { throw new Error('disk full') }

    await expect(h.manager.sendMessage(h.managed.id, 'must remain unacknowledged')).rejects.toThrow('disk full')
    h.internals.processNextQueuedMessage(h.managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(replayed).toEqual([])
    expect(h.managed.messages.find(message => message.content === 'must remain unacknowledged')).toBeUndefined()
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.userInputRequests).toMatchObject([{ status: 'pending' }])
    expect(h.managed.userInputRequests?.[0]?.answers).toBeUndefined()
    expect(h.managed.userInputRequests?.[0]?.responseMessageId).toBeUndefined()
    expect((h.internals as unknown as Pick<SessionOperations, 'autonomousAdmissionBlock'>).autonomousAdmissionBlock(h.managed, true, false)).toBeDefined()
  })
});
