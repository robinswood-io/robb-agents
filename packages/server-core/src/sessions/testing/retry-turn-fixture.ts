import { sessionManagerForTest } from "./private-runtime-access.ts";

import { withSessionOperationsForTest } from './session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultStatusConfig, saveStatusConfig } from "@craft-agent/shared/statuses";
import { createManagedSession, SessionManager } from "../SessionManager";



export type Managed = ReturnType<typeof createManagedSession>

export const roots: string[] = []

export const ids: string[] = []


export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}


export function harness() {
  const rootPath = mkdtempSync(join(tmpdir(), 'retry-turn-'))
  roots.push(rootPath)
  const statuses = getDefaultStatusConfig()
  statuses.statuses.push(
    { id: 'in-progress', label: 'En cours', category: 'open', isFixed: false, isDefault: false, order: 10 },
    { id: 'blocked', label: 'Bloqué', category: 'open', isFixed: false, isDefault: false, order: 11 },
  )
  saveStatusConfig(rootPath, statuses)
  const id = `retry-${roots.length}`
  ids.push(id)
  const managed = createManagedSession({ id, name: 'Retry test', sessionStatus: 'done' }, {
    id: `ws-${id}`, rootPath, name: 'Retry test', createdAt: 1,
  } as never, { messagesLoaded: true })
  managed.messages = [
    { id: 'root-user', role: 'user', content: 'Correct the deliverable and verify its state.', timestamp: 1 },
    { id: 'evidence', role: 'tool', content: 'Already saved.', toolName: 'Write', toolUseId: 'write-1', toolStatus: 'completed', timestamp: 2 },
    { id: 'latest-user', role: 'user', content: 'Keep the existing destination and finish the verification.', timestamp: 3 },
    { id: 'old-final', role: 'assistant', content: 'Done.', timestamp: 4 },
    { id: 'old-error', role: 'error', content: 'Connection ended.', timestamp: 5 },
  ]
  managed.activeObjective = {
    schemaVersion: 1, objectiveId: 'root-user', userMessageId: 'root-user', lastUserMessageId: 'latest-user',
    originalText: managed.messages[0]!.content, startedAt: 1, budgetBaselineUsd: 2, tokenBaseline: 100,
    continuationCount: 3, orchestrationMode: 'mission', risk: 'standard', requiresExecutionEvidence: true,
    requiresAcceptanceCriteria: true, acceptanceRegisteredAt: 2,
    acceptanceCriteria: [{ id: 'verified', description: 'Stored target verified', toolName: 'Read', input: { path: 'target' }, checks: [{ path: '$.ok', equals: true }] }],
    completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'], terminalState: 'complete_verified', completedAt: 4,
  }
  managed.pendingTurnRecovery = {
    userMessageId: 'root-user', startedAt: 1, attempts: 5, stagnantAttempts: 2, exhaustedAt: 5,
    leaseExpiresAt: 50, validationGaps: ['relevant-checks-passed'],
  }
  const manager = withSessionOperationsForTest(new SessionManager())
  const events: Array<Record<string, unknown>> = []
  const stopRuntime = deferred()
  const internals = sessionManagerForTest(manager)
  sessionRuntimeStateForTest(manager).sessions.set(id, managed)
  internals.enqueuePersist = () => true
  internals.flushSession = async () => {}
  internals.sendEvent = event => events.push(event)
  internals.getOrCreateAgent = async () => { await stopRuntime.promise; throw new Error('Fixture runtime stopped before API work') }
  internals.disposeManagedAgentRuntime = async () => { managed.agent = null }
  internals.processNextQueuedMessage = () => {}
  internals.startGenerationTelemetry = () => {}
  internals.finishGenerationTelemetry = () => {}
  let dispatch: Promise<void> | undefined
  const send = manager.sendMessage.bind(manager)
  manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
  const finish = async () => { stopRuntime.resolve(); await dispatch }
  return { manager, managed, internals, events, finish, rootPath }
}
