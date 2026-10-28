import { sessionManagerForTest } from "./private-runtime-access.ts";
import { completeSessionAgentFixture } from './scripted-session-agent.ts';
import { withSessionOperationsForTest } from './session-operation-access.ts';
import { sessionRuntimeStateForTest } from "./runtime-state-access.ts";
import { scopeReviewFixture } from "../__fixtures__/scope-review.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { READ_ONLY_GIT_HARDENING_ARGS } from "@craft-agent/shared/agent/bash-validator";
import { SessionManager, createManagedSession } from "../SessionManager.ts";



export type Managed = ReturnType<typeof createManagedSession>


export type CompletionEvent = {
  sessionId: string
  workspaceId: string
  reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  finalMessageId?: string
  finalText?: string
}


export interface Harness {
  manager: SessionManager
  managed: Managed
  sentEvents: Array<Record<string, unknown>>
  telemetryNames: string[]
  resumedSessionIds: string[]
  completions: CompletionEvent[]
}


export const roots: string[] = []

export const sessionIds: string[] = []

export const safeGit = `git ${READ_ONLY_GIT_HARDENING_ARGS.join(' ')}`


export function makeHarness(id: string): Harness {
  const rootPath = mkdtempSync(join(tmpdir(), 'session-objective-outcome-'))
  roots.push(rootPath)
  sessionIds.push(id)
  const managed = createManagedSession({
    id,
    name: 'Objective outcome integration',
  }, {
    id: `workspace-${id}`,
    name: 'Objective outcome workspace',
    rootPath,
    createdAt: Date.now(),
  } as never, { messagesLoaded: true })
  const manager = withSessionOperationsForTest(new SessionManager())
  const sentEvents: Array<Record<string, unknown>> = []
  const telemetryNames: string[] = []
  const resumedSessionIds: string[] = []
  const completions: CompletionEvent[] = []
  const internals = sessionManagerForTest(manager)
  sessionRuntimeStateForTest(manager).sessions.set(id, managed)
  // Exercise the real persistence boundary's UI publication without disk writes.
  internals.enqueuePersist = () => true
  internals.flushSession = async () => {}
  internals.sendEvent = event => sentEvents.push(event)
  internals.emitExecutionTelemetry = (_session, event) => telemetryNames.push(event.name)
  internals.startGenerationTelemetry = () => {}
  internals.finishGenerationTelemetry = () => {}
  internals.beginAutomaticSessionStatusLifecycle = async () => {}
  internals.finishAutomaticSessionStatusLifecycle = async () => {}
  internals.isSessionBeingViewed = () => true
  internals.markSessionRead = async () => {}
  internals.processNextQueuedMessage = sessionId => resumedSessionIds.push(sessionId)
  internals.disposeManagedAgentRuntime = async () => {
    managed.agent = null
  }
  manager.onSessionComplete(event => completions.push(event as CompletionEvent))
  return { manager, managed, sentEvents, telemetryNames, resumedSessionIds, completions }
}


export function installAgent(harness: Harness, events: AgentEvent[], beforeChat?: () => void, reviewed = false): string[] {
  const redirected: string[] = []
  const agent = completeSessionAgentFixture(harness.managed.workspace, {
    async *chat(): AsyncGenerator<AgentEvent, void, unknown> {
      beforeChat?.()
      for (const event of events) {
        if (reviewed && event.type === 'text_complete' && harness.managed.activeObjective?.acceptanceCriteria?.length) {
          const review = scopeReviewFixture(harness.managed.activeObjective, harness.managed.messages)
          yield { type: 'tool_start', toolName: review.toolName!, toolUseId: review.toolUseId!, input: review.toolInput! }
          yield { type: 'tool_result', toolName: review.toolName!, toolUseId: review.toolUseId!, result: review.toolResult!, executed: true, isError: false }
        }
        yield event
      }
    },
    getModel: () => 'test/objective-model',
    getSessionId: () => null,
    isProcessing: () => false,
    setAllSources: () => {},
    redirect: (message: string) => {
      redirected.push(message)
      return true
    },
  })
  harness.managed.agent = agent
  ;(sessionManagerForTest(harness.manager)).getOrCreateAgent = async session => {
    session.agent = agent
    return agent
  }
  return redirected
}


export function installReviewedAgent(harness: Harness, events: AgentEvent[], beforeChat?: () => void): string[] {
  return installAgent(harness, events, beforeChat, true)
}


export function bindLiveToolAdmission(harness: Harness): void {
  const agent = harness.managed.agent
  const userMessage = harness.managed.messages.findLast(message => message.role === 'user')
  if (!agent || !userMessage) throw new Error('Live tool admission requires an agent and user boundary')
  const runtime = sessionManagerForTest(harness.manager)
  sessionRuntimeStateForTest(runtime).runtimeProcessingGenerations.set(agent, harness.managed.processingGeneration)
  sessionRuntimeStateForTest(runtime).runtimeToolAdmissionBindings.set(agent, {
    managed: harness.managed,
    sessionId: harness.managed.id,
    generation: harness.managed.processingGeneration,
    activeObjective: harness.managed.activeObjective,
    authorityEpoch: sessionRuntimeStateForTest(runtime).objectiveAuthorityEpochs.get(harness.managed) ?? 0,
    userMessage,
    userMessageId: userMessage.id,
    messageCountAtHandoff: harness.managed.messages.length,
    lastSentOptions: harness.managed.lastSentOptions,
    automaticRecovery: harness.managed.lastSentOptions?.automaticRecovery,
    pendingTurnRecovery: harness.managed.pendingTurnRecovery,
    recoveryDispatch: harness.managed.pendingTurnRecovery?.recoveryDispatch,
  })
}


export async function processEvent(harness: Harness, event: AgentEvent): Promise<void> {
  await (sessionManagerForTest(harness.manager)).processEvent(harness.managed, event, harness.managed.processingGeneration)
}


export function enableAutomaticToolFallback(harness: Harness): void {
  writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    id: harness.managed.workspace.id,
    name: harness.managed.workspace.name,
    slug: harness.managed.workspace.id,
    createdAt: 1,
    updatedAt: 1,
    automaticToolFallbackEnabled: true,
  }))
}


export function outcomeComment(declaration: ObjectiveOutcomeDeclaration): string {
  return `<!-- robb_objective_outcome ${JSON.stringify(declaration)} -->`
}


export function activeObjective(userMessageId: string): NonNullable<Managed['activeObjective']> {
  return {
    schemaVersion: 1,
    objectiveId: userMessageId,
    userMessageId,
    lastUserMessageId: userMessageId,
    startedAt: Date.now(),
    budgetBaselineUsd: 0,
    tokenBaseline: 0,
    continuationCount: 0,
    orchestrationMode: 'mission',
    risk: 'standard',
    requiresExecutionEvidence: true,
    completionCriteria: [
      'requested-outcome-delivered',
      'relevant-checks-passed',
      'no-safe-work-remaining',
    ],
    terminalState: 'active',
  }
}
