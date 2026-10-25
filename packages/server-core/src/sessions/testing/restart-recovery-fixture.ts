import { withSessionOperationsForTest } from './session-operation-access.ts';
import { sessionManagerForTest, type SessionManagerTestView, type SessionSentEvent } from "./private-runtime-access.ts";
import { ScriptedSessionAgent } from "./scripted-session-agent.ts";
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { listSessions } from "@craft-agent/shared/sessions/storage";
import { SessionManager, createManagedSession } from "../SessionManager";
import { createPendingTurnRecovery, buildAutomaticTurnRecoveryPrompt } from "../turn-recovery";

export type Managed = ReturnType<typeof createManagedSession>

export const roots: string[] = []

export const managers: SessionManager[] = []

export const spies: Array<{ mockRestore(): void }> = []

export const tick = () => new Promise<void>(resolve => setImmediate(resolve))

export function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { resolve, promise } }

export function bindToolAdmissionTurn(
  runtime: SessionManagerTestView,
  managed: Managed,
  runtimeAgent: NonNullable<Managed['agent']>,
  generation: number,
  userMessageId = managed.messages.filter(message => message.role === 'user').at(-1)?.id,
) {
  const userMessage = managed.messages.find(message => message.id === userMessageId && message.role === 'user')
  if (!userMessage) throw new Error(`Missing tool-admission user turn ${userMessageId ?? '<none>'}`)
  sessionRuntimeStateForTest(runtime).runtimeProcessingGenerations.set(runtimeAgent, generation)
  sessionRuntimeStateForTest(runtime).runtimeToolAdmissionBindings.set(runtimeAgent, {
    managed,
    sessionId: managed.id,
    generation,
    activeObjective: managed.activeObjective,
    authorityEpoch: sessionRuntimeStateForTest(runtime).objectiveAuthorityEpochs.get(managed) ?? 0,
    userMessage,
    userMessageId: userMessage.id,
    messageCountAtHandoff: managed.messages.length,
    lastSentOptions: managed.lastSentOptions,
    automaticRecovery: managed.lastSentOptions?.automaticRecovery,
    pendingTurnRecovery: managed.pendingTurnRecovery,
    recoveryDispatch: managed.pendingTurnRecovery?.recoveryDispatch,
  })
}

export function configureSpentDispatchBudget(h: ReturnType<typeof harness>): void {
  writeFileSync(join(h.rootPath, 'config.json'), JSON.stringify({
    schemaVersion: 1, id: h.workspace.id, name: h.workspace.name, slug: h.workspace.id,
    createdAt: 1, updatedAt: 1, costControl: { recovery: { maxAutomaticAttempts: 2 } },
  }));
}

export function harness() {
  const rootPath = mkdtempSync(join(tmpdir(), 'restart-recovery-'))
  roots.push(rootPath)
  const workspace = { id: `restart-${roots.length}`, slug: `restart-${roots.length}`, rootPath, name: 'Restart test', createdAt: 1 }
  const manager = withSessionOperationsForTest(new SessionManager())
  const registerManager = (candidate: SessionManager) => {
    const cleanup = candidate.cleanup.bind(candidate)
    candidate.cleanup = async () => {
      // Runtime fixtures in this file intentionally implement only the methods
      // exercised by recovery. Give partial fakes the AgentInstance teardown
      // contract so shutdown proof failures remain reserved for causal tests.
      for (const managed of sessionRuntimeStateForTest(candidate).sessions.values()) {
        const agent = managed.agent as { dispose?: () => void; disposeForRestart?: () => void } | null
        if (agent && typeof agent.dispose !== 'function' && typeof agent.disposeForRestart !== 'function') {
          agent.dispose = () => {}
        }
      }
      await cleanup()
    }
    managers.push(candidate)
  }
  registerManager(manager)
  // Exercise storage and real event/queue boundaries, replacing only transport/model work.
  const runtime = sessionManagerForTest(manager)
  const events: SessionSentEvent[] = []
  runtime.sendEvent = (event) => events.push(event)
  runtime.startGenerationTelemetry = () => {}
  runtime.finishGenerationTelemetry = () => {}
  runtime.finishAllGenerationTelemetry = () => {}
  runtime.emitExecutionTelemetry = () => {}
  const make = (id: string, parentSessionId?: string) => {
    const managed = createManagedSession({ id, name: 'Restart test', parentSessionId }, workspace as never, { messagesLoaded: true })
    managed.messages = [{ id: `${id}-user`, role: 'user', content: 'Explain the existing result.', timestamp: 1 }]
    managed.activeObjective = {
      schemaVersion: 1, objectiveId: `${id}-user`, userMessageId: `${id}-user`, originalText: 'Explain the existing result.',
      startedAt: 1, budgetBaselineUsd: 2, tokenBaseline: 100, continuationCount: 2,
      orchestrationMode: 'direct', risk: 'standard', completionCriteria: ['requested-outcome-delivered'], terminalState: 'active',
    }
    managed.pendingTurnRecovery = { ...createPendingTurnRecovery(`${id}-user`), attempts: 2, stagnantAttempts: 1 }
    sessionRuntimeStateForTest(manager).sessions.set(id, managed)
    return managed
  }
  const save = async (managed: Managed) => { runtime.persistSession(managed); await manager.flushSession(managed.id) }
  const cold = () => {
    const next = withSessionOperationsForTest(new SessionManager()); registerManager(next)
    const coldRuntime = sessionManagerForTest(next)
    coldRuntime.sendEvent = (event) => events.push(event)
    for (const meta of listSessions(rootPath)) sessionRuntimeStateForTest(coldRuntime).sessions.set(meta.id, createManagedSession(meta, workspace as never))
    return { manager: next, runtime: coldRuntime }
  }
  return { manager, runtime, events, workspace, rootPath, make, save, cold }
}

export function enableAutomaticToolFallback(h: ReturnType<typeof harness>): void {
  writeFileSync(join(h.rootPath, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    id: h.workspace.id,
    name: h.workspace.name,
    slug: 'automatic-tool-fallback-fixture',
    createdAt: 1,
    updatedAt: 1,
    automaticToolFallbackEnabled: true,
  }))
}

export async function prepareStartedRecoveryAdmission(
  h: ReturnType<typeof harness>,
  id: string,
  generation = 1,
) {
  const managed = h.make(id)
  const allocatedAt = Date.now() - 3_000
  const startedAt = allocatedAt + 1_000
  const dispatchId = `${id}-dispatch-2`
  managed.pendingTurnRecovery = {
    ...managed.pendingTurnRecovery!,
    attempts: 2,
    stagnantAttempts: 0,
    leaseExpiresAt: Date.now() + 60_000,
    lastCause: 'objective_incomplete',
    validationGaps: ['finish the exact recovery work'],
    recoveryDispatch: {
      schemaVersion: 1,
      id: dispatchId,
      attempt: 2,
      cause: 'objective_incomplete',
      origin: 'automatic',
      allocatedAt,
      phase: 'started',
      startedAt,
      preToolExecutionReceiptVersion: 1,
    },
  }
  managed.messages.push({
    id: dispatchId,
    role: 'user',
    content: buildAutomaticTurnRecoveryPrompt(
      managed.pendingTurnRecovery,
      'objective_incomplete',
      undefined,
      2,
      managed.activeObjective,
    ),
    timestamp: startedAt + 1,
    hidden: true,
  })
  await h.save(managed)
  const runtimeAgent = Object.assign(new ScriptedSessionAgent(managed.workspace, { async *chat() {}, isProcessing: () => true }), { dispose: async () => {} })
  managed.agent = runtimeAgent
  managed.isProcessing = true
  managed.processingGeneration = generation
  managed.lastSentOptions = {
    hidden: true,
    automaticRecovery: {
      originalUserMessageId: managed.pendingTurnRecovery.userMessageId,
      cause: 'objective_incomplete',
      dispatchId,
      dispatchAttempt: 2,
      dispatchOrigin: 'automatic',
      dispatchAllocatedAt: allocatedAt,
    },
  }
  bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, generation)
  return { managed, runtimeAgent, dispatchId }
}

export const bindDelegation = (root: Managed, parent: Managed, child: Managed) => {
    child.delegation = {
      rootSessionId: root.id,
      rootObjectiveId: root.activeObjective!.objectiveId ?? root.activeObjective!.userMessageId,
      parentObjectiveId: parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId,
      depth: (parent.delegation?.depth ?? 0) + 1,
      role: 'worker',
    }
  }

export const queueTypedUpwardDelivery = (
    target: Managed,
    sender: Managed,
    messageType: 'progress' | 'result' | 'question' | 'decision',
    id = `${sender.id}-${messageType}-delivery`,
  ) => {
    const internalOrigin = {
      kind: 'agent-message' as const,
      senderSessionId: sender.id,
      deliveryId: id,
      agentMessageType: messageType,
    }
    target.messages.push({
      id, role: 'user', content: `${messageType} from ${sender.id}`, timestamp: 2,
      hidden: true, isQueued: true, internalOrigin,
      agentDelivery: { id, status: 'queued', attempts: 0 },
    })
    const item = {
      messageId: id,
      message: `${messageType} from ${sender.id}`,
      options: { hidden: true, internalOrigin },
    }
    target.messageQueue.push(item)
    return item
  }

export const queueMachine = (managed: Managed, id = 'machine') => {
    const options = { internalOrigin: { kind: 'spawned-session' as const, senderSessionId: managed.parentSessionId ?? managed.id } }
    managed.messages.push({ id, role: 'user', content: id, timestamp: 2, isQueued: true, internalOrigin: options.internalOrigin })
    const item = { messageId: id, message: id, options, storedAttachments: [{ name: 'preserved.txt', storedPath: '/fixture/preserved.txt' }] as never }
    managed.messageQueue.push(item); return item
  }

export function setAutomaticToolFallback(
    h: ReturnType<typeof harness>,
    automaticToolFallbackEnabled: boolean,
  ): void {
    writeFileSync(join(h.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: h.workspace.id,
      name: h.workspace.name,
      slug: 'routing-kill-switch-recovery',
      createdAt: 1,
      updatedAt: 1,
      // Keep automatic model selection ON throughout: it must be independent
      // from the dedicated channel-fallback kill switch under test.
      automaticRoutingEnabled: true,
      automaticToolFallbackEnabled,
    }))
  }

export async function cleanupRestartRecovery() {
  delete process.env.ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT
  spies.splice(0).forEach(spy => spy.mockRestore())
  for (const manager of managers.splice(0)) {
    for (const id of sessionRuntimeStateForTest(manager).sessions.keys()) clearObjectiveEvidenceGate(id)
    await manager.cleanup()
  }
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
}
