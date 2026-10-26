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
import { createPendingTurnRecovery } from './turn-recovery';
import "./objective-contract";
import "./__fixtures__/delegated-review";

import { type AgentEvent, type UserInputQuestion } from '@craft-agent/core/types';





type Managed = ReturnType<typeof createManagedSession>
const roots: string[] = []
const ids: string[] = []
const questions: UserInputQuestion[] = [{ id: 'format', question: 'Quel format souhaites-tu ?', options: [{ id: 'short', label: 'Court' }, { id: 'long', label: 'Détaillé' }] }]
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
it('keeps a failed direct send recoverable after irreversibly denying its old permission capability', async () => {
    const h = harness()
    h.managed.activeObjective!.terminalState = 'blocked_human'
    h.managed.activeObjective!.completedAt = 10
    h.managed.pendingTurnRecovery!.waitingForPermission = {
      requestId: 'old-permission', requestedAt: 2, toolName: 'Bash', toolUseId: 'old-tool', recoveryRequired: true,
    }
    const permissionResponses: Array<[string, boolean, boolean]> = []
    const permissionAgent = Object.assign(new ScriptedSessionAgent(h.managed.workspace), {
      respondToPermission: (id: string, allowed: boolean, always: boolean) => { permissionResponses.push([id, allowed, always]); },
    })
    h.managed.agent = permissionAgent
    ;sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set('old-permission', {
      sessionId: h.managed.id, toolName: 'Bash', toolUseId: 'old-tool', processingGeneration: h.managed.processingGeneration,
      runtimeAgent: permissionAgent, requestedAt: 2, expiresAt: Date.now() + 60_000,
      request: { requestId: 'old-permission', sessionId: h.managed.id, toolName: 'Bash', description: 'Offline permission fixture' }, timeout: setTimeout(() => {}, 60_000),
    })
    h.internals.flushSession = async () => { throw new Error('disk full') }

    await expect(h.manager.sendMessage(h.managed.id, 'unacknowledged replacement')).rejects.toThrow('disk full')

    expect(permissionResponses).toEqual([['old-permission', false, false]])
    expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.size).toBe(0)
    expect(h.manager.respondToPermission(h.managed.id, 'old-permission', true, true)).toBe(false)
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toMatchObject({
      requestId: 'old-permission', toolUseId: 'old-tool', recoveryRequired: true,
    })
    expect(h.managed.pendingTurnRecovery?.recoveryDispatch).toBeUndefined()
    expect(h.managed.messages.find(message => message.content === 'unacknowledged replacement')).toBeUndefined()
    expect(h.managed.messageQueue).toEqual([])
    expect(sessionRuntimeStateForTest(h.internals).liveDirectHumanContinuationIds.get(h.managed)).toBeUndefined()
  })

it('serializes concurrent direct supersessions so a failed first flush cannot revive the second handoff', async () => {
    const h = harness()
    await h.manager.requestUserInput(h.managed.id, questions)
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    const send = h.manager.sendMessage.bind(h.manager)
    const replayed: string[] = []
    h.manager.sendMessage = (...args) => {
      if (args[5]) { replayed.push(args[5]); args[7]?.(args[5]); return Promise.resolve() }
      return send(...args)
    }
    let rejectFirstFlush!: (error: Error) => void
    let notifyFirstFlush!: () => void
    const firstFlushStarted = new Promise<void>(resolve => { notifyFirstFlush = resolve })
    const firstFlush = new Promise<void>((_resolve, reject) => { rejectFirstFlush = reject })
    let flushes = 0
    h.internals.flushSession = async () => {
      if (++flushes === 1) { notifyFirstFlush(); await firstFlush }
    }

    const first = h.manager.sendMessage(h.managed.id, 'première continuation non durable')
    await firstFlushStarted
    const second = h.manager.sendMessage(h.managed.id, 'seconde continuation durable')
    rejectFirstFlush(new Error('disk full'))

    await expect(first).rejects.toThrow('disk full')
    await second
    for (let index = 0; index < 20 && !replayed.length; index++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(replayed).toHaveLength(1)
    expect(h.managed.messages.find(message => message.id === replayed[0])?.content).toBe('seconde continuation durable')
    expect(h.managed.messages.some(message => message.content === 'première continuation non durable')).toBe(false)
    expect(h.managed.userInputRequests).toMatchObject([{ status: 'cancelled' }])
    expect(h.managed.userInputRequests?.[0]?.answers).toBeUndefined()
    expect(h.managed.userInputRequests?.[0]?.responseMessageId).toBeUndefined()
  })

for (const transition of ['closed', 'terminal'] as const) {
    it(`revalidates a cold human reservation that becomes ${transition} before setImmediate dispatch`, async () => {
      const h = harness()
      h.managed.sessionStatus = 'todo'
      h.managed.messages.push({ id: 'cold-human', role: 'user', content: 'old cold row', timestamp: 3, isQueued: true })
      const queued = { messageId: 'cold-human', message: 'old cold row' }
      h.managed.messageQueue.push(queued)
      h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
      const starts: string[] = []
      h.manager.sendMessage = async (...args) => { if (args[5]) starts.push(args[5]) }

      h.internals.processNextQueuedMessage(h.managed.id)
      expect(h.managed.messageQueue).toEqual([])
      if (transition === 'closed') h.managed.sessionStatus = 'done'
      else {
        h.managed.activeObjective!.terminalState = 'blocked_human'
        h.managed.activeObjective!.completedAt = 10
      }
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(starts).toEqual([])
      expect(h.managed.messageQueue).toEqual([queued])
      expect(h.managed.messages.find(message => message.id === 'cold-human')?.isQueued).toBe(true)
      expect(h.events.some(event => event.type === 'user_message'
        && event.status === 'processing'
        && (event.message as { id?: string } | undefined)?.id === 'cold-human')).toBe(false)
      expect(sessionRuntimeStateForTest(h.internals).queuedMessageDispatches.has(h.managed.id)).toBe(false)
      expect(sessionRuntimeStateForTest(h.internals).automaticAdmissionReservations.has(h.managed.id)).toBe(false)
    })
  }

it('queues instead of steering while permission cleanup is still processing, then resumes after stop cleanup', async () => {
    const h = harness()
    h.managed.isProcessing = true
    h.managed.activeObjective!.terminalState = 'blocked_human'
    h.managed.activeObjective!.completedAt = 10
    h.managed.pendingTurnRecovery!.waitingForPermission = {
      requestId: 'expiring', requestedAt: 2, toolName: 'Bash', recoveryRequired: true,
    }
    const redirects: string[] = []
    h.managed.agent = {
      redirect: (text: string) => { redirects.push(text); return true },
      isProcessing: () => false,
    } as never
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    const send = h.manager.sendMessage.bind(h.manager)
    const replayed: string[] = []
    h.manager.sendMessage = (...args) => {
      if (args[5]) { replayed.push(args[5]); args[7]?.(args[5]); return Promise.resolve() }
      return send(...args)
    }

    await h.manager.sendMessage(h.managed.id, 'Nouvelle continuation après expiration.')
    expect(redirects).toEqual([])
    expect(replayed).toEqual([])
    expect(h.managed.messageQueue).toHaveLength(1)
    expect(h.managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()

    await h.internals.onProcessingStopped(h.managed.id, 'interrupted')
    for (let index = 0; index < 20 && !replayed.length; index++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(replayed).toHaveLength(1)
  })

it('retries the exact live dequeue after a permission-deny stop callback loses the flush race', async () => {
    const h = harness()
    h.managed.isProcessing = true
    h.managed.activeObjective!.terminalState = 'blocked_human'
    h.managed.activeObjective!.completedAt = 10
    h.managed.pendingTurnRecovery!.waitingForPermission = {
      requestId: 'expiring', requestedAt: 2, toolName: 'Bash', recoveryRequired: true,
    }
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    const send = h.manager.sendMessage.bind(h.manager)
    const replayed: string[] = []
    h.manager.sendMessage = (...args) => {
      if (args[5]) { replayed.push(args[5]); args[7]?.(args[5]); return Promise.resolve() }
      return send(...args)
    }
    let stopCallback: Promise<void> | undefined
    const permissionAgent = Object.assign(new ScriptedSessionAgent(h.managed.workspace), {
      redirect: () => true,
      isProcessing: () => false,
      respondToPermission: () => {
        stopCallback = h.internals.onProcessingStopped(h.managed.id, 'interrupted')
      },
    })
    h.managed.agent = permissionAgent
    ;sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.set('expiring', {
      sessionId: h.managed.id, toolName: 'Bash', processingGeneration: h.managed.processingGeneration,
      runtimeAgent: permissionAgent, requestedAt: 2, expiresAt: Date.now() + 60_000,
      request: { requestId: 'expiring', sessionId: h.managed.id, toolName: 'Bash', description: 'Offline permission fixture' }, timeout: setTimeout(() => {}, 60_000),
    })
    let releaseFlush!: () => void
    const flushing = new Promise<void>(resolve => { releaseFlush = resolve })
    h.internals.flushSession = async () => { await flushing }

    const liveSend = h.manager.sendMessage(h.managed.id, 'Continuation durable après le callback de refus.')
    for (let index = 0; index < 20 && h.managed.isProcessing; index++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    expect(stopCallback).toBeDefined()
    expect(h.managed.isProcessing).toBe(false)
    expect(replayed).toEqual([])

    releaseFlush()
    await liveSend
    await stopCallback
    for (let index = 0; index < 20 && !replayed.length; index++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(replayed).toHaveLength(1)
    expect(h.managed.messages.find(message => message.id === replayed[0])?.content)
      .toBe('Continuation durable après le callback de refus.')
  })

it('does not acknowledge or resurrect a direct continuation when Stop wins its durability race', async () => {
    const h = harness()
    h.managed.activeObjective!.terminalState = 'blocked_human'
    h.managed.pendingTurnRecovery!.waitingForPermission = {
      requestId: 'expired', requestedAt: 2, toolName: 'Bash', recoveryRequired: true,
    }
    h.internals.processNextQueuedMessage = Object.getPrototypeOf(h.manager).processNextQueuedMessage.bind(h.manager)
    let releaseDirectFlush!: () => void
    const directFlush = new Promise<void>(resolve => { releaseDirectFlush = resolve })
    let flushes = 0
    h.internals.flushSession = async () => { if (++flushes === 1) await directFlush }
    let acknowledgements = 0
    const send = h.manager.sendMessage(h.managed.id, 'continuation stopped during flush', undefined, undefined,
      undefined, undefined, undefined, () => { acknowledgements++ })
    for (let index = 0; index < 20
      && !h.managed.messages.some(message => message.content === 'continuation stopped during flush'); index++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    await h.manager.cancelProcessing(h.managed.id)
    releaseDirectFlush()
    await expect(send).rejects.toThrow('cancelled by Stop')
    h.internals.processNextQueuedMessage(h.managed.id)
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(acknowledgements).toBe(0)
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.messages.find(message => message.content === 'continuation stopped during flush')).toBeUndefined()
    expect(sessionRuntimeStateForTest(h.internals).liveDirectHumanContinuationIds.get(h.managed)).toBeUndefined()
  })
});
