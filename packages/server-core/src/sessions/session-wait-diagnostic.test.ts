import { completeSessionAgentFixture } from "./testing/scripted-session-agent.ts";
import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { withSessionOperationsForTest } from './testing/session-operation-access.ts';
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { SessionManager, createManagedSession } from './SessionManager'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSession, listSessions } from '@craft-agent/shared/sessions/storage'
import { storedToMessage } from '@craft-agent/core/types'
import { parseIndependentReviewReceipt } from '@craft-agent/shared/agent'
import { transitionObjectiveContract } from './objective-contract'

const managers: SessionManager[] = []
const roots: string[] = []
function harness() {
  const manager = withSessionOperationsForTest(new SessionManager()); managers.push(manager)
  const host = sessionManagerForTest(manager)
  host.sendEvent = () => {}
  const rootPath = mkdtempSync(join(tmpdir(), 'robb-wait-diagnostic-')); roots.push(rootPath)
  const workspace = { id: 'diagnostic-test', rootPath, name: 'Wait', createdAt: 1 }
  const make = (id: string) => {
    const session = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true })
    const parent = sessionRuntimeStateForTest(manager).sessions.get('parent')
    if (id === 'parent') {
      session.activeObjective = transitionObjectiveContract({
        messageId: 'parent-request', text: 'Coordinate the delegated reviews.', nowMs: 1,
      })
      session.isProcessing = true
    } else if (parent?.activeObjective) {
      const objectiveId = parent.activeObjective.objectiveId ?? parent.activeObjective.userMessageId
      session.parentSessionId = parent.id
      session.delegation = {
        rootSessionId: parent.id,
        rootObjectiveId: objectiveId,
        parentObjectiveId: objectiveId,
        depth: 1,
        role: 'worker',
      }
    }
    sessionRuntimeStateForTest(manager).sessions.set(id, session)
    return session
  }
  const parent = make('parent'); const child = make('reviewer')
  child.activeObjective = ({ objectiveId: 'review-request', userMessageId: 'review-request', lastUserMessageId: 'review-request',
    startedAt: 10, terminalState: 'exhausted' } satisfies Partial<NonNullable<typeof child.activeObjective>>) as NonNullable<typeof child.activeObjective>
  child.messages = [{ id: 'review-request', role: 'user', content: 'Inspect this target.', timestamp: 10 },
    { id: 'review-final', role: 'assistant', content: JSON.stringify({ verdict: 'FAIL', objectiveId: 'parent-request',
      acceptanceSha256: 'a'.repeat(64), criteria: [{ id: 'check', passed: false }], findings: ['Read-only inspection was blocked.'] }), timestamp: 20 },
    { id: 'host-error', role: 'error', content: 'Completion could not be verified.', timestamp: 21 }]
  child.lastFinalMessageId = 'review-final'
  child.pendingTurnRecovery = { userMessageId: 'review-request', startedAt: 10, attempts: 5, exhaustedAt: 21,
    validationGaps: ['check: no authoritative observation'] }
  return { host, make, parent, child }
}
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('unverified delegated diagnostics through the host wait', () => {
  it('captures the actual sendMessage generation before exposing its terminal diagnostic', async () => {
    const { host, parent, child } = harness()
    for (const method of ['startGenerationTelemetry', 'finishGenerationTelemetry', 'finishAllGenerationTelemetry', 'emitExecutionTelemetry'] as const) host[method] = () => {}
    child.activeObjective = ({ ...child.activeObjective, schemaVersion: 1,
      originalText: 'Inspect the exact target and return a review.', budgetBaselineUsd: 0, tokenBaseline: 0,
      continuationCount: 0, orchestrationMode: 'mission', risk: 'standard',
      completionCriteria: ['requested-outcome-delivered'], requiresAcceptanceCriteria: true } satisfies Partial<NonNullable<typeof child.activeObjective>>) as NonNullable<typeof child.activeObjective>
    const reported = JSON.stringify({ verdict: 'FAIL', findings: ['Target inspection could not be completed.'] })
    let providerPasses = 0
    const agent = completeSessionAgentFixture(child.workspace, {getModel: () => 'fixture',
getSessionId: () => null,
setAllSources: () => {},
isProcessing: () => false,
forceAbort: () => {},
dispose: () => {},
async *chat() { providerPasses++; yield { type: 'text_complete', text: reported }; yield { type: 'complete' } }})
    host.getOrCreateAgent = async () => { child.agent = agent; return agent }
    let dispatch: Promise<void> | undefined
    const send = host.sendMessage.bind(host)
    host.sendMessage = (...args: Parameters<typeof send>) => { dispatch = send(...args); return dispatch }
    // Explicit Retry can now admit a bounded continuation. Observe the real host
    // terminal event, rather than treating the first provider pass as the end.
    const emitComplete = host.emitSessionComplete.bind(host)
    const terminal = new Promise<void>(resolve => {
      host.emitSessionComplete = (event) => {
        emitComplete(event)
        if (event.sessionId === child.id) resolve()
      }
    })
    expect(await host.retryTurn(child.id, 'review-request')).toEqual({ status: 'started' })
    await terminal
    await dispatch
    const result = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(requiredTestValue(result.sessions[0]).objectiveState).toBe('exhausted')
    expect(requiredTestValue(result.sessions[0]).diagnostic).toMatchObject({ source: 'current-generation',
      processingGeneration: child.processingGeneration, text: reported, verified: false })
    expect(requiredTestValue(result.sessions[0]).diagnostic!.messageId).not.toBe('review-final')
    expect(child.isProcessing).toBe(false)
    expect(child.messageQueue).toHaveLength(0)
    expect(child.messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(1)
    expect(providerPasses).toBe(3)
    expect(child.pendingTurnRecovery!.attempts).toBe(7)
    expect(child.pendingTurnRecovery!.exhaustedAt).toBe(21)
    expect(child.pendingTurnRecovery!.explicitRetryAllowances).toHaveLength(1)
    expect(child.pendingTurnRecovery!.explicitRetryAllowances![0]).toMatchObject({ attemptBaseline: 5, attempts: 2 })
    expect(requiredTestValue(result.sessions[0]).finalMessageId).toBeUndefined()
  })

  it('delivers a failed reviewer report as diagnostic, never as a completed receipt', async () => {
    const { host, parent, child } = harness()
    child.processingGeneration = 1
    ;(child).waitDiagnosticBoundary = { generation: 1, objectiveId: 'review-request', fromMessageCount: 1 }
    host.emitSessionComplete({ sessionId: child.id, workspaceId: child.workspace.id, reason: 'interrupted',
      finalMessageId: 'review-final', finalText: child.messages[1]!.content })
    const result = await host.waitForDelegatedSessions(parent, [child.id], 0)
    const snapshot = result.sessions[0]
    expect(snapshot).toMatchObject({ needsAttention: true, objectiveState: 'exhausted',
      diagnostic: { verified: false, objectiveId: 'review-request', source: 'current-generation',
        messageId: 'review-final', text: child.messages[1]!.content, errorMessageId: 'host-error',
        validationGaps: ['check: no authoritative observation'] } })
    expect(requiredTestValue(snapshot).finalText).toBeUndefined()
    expect(requiredTestValue(snapshot).finalMessageId).toBeUndefined()
    expect(requiredTestValue(snapshot).reason).not.toBe('complete')
    expect(child.pendingTurnRecovery!.attempts).toBe(5)
    expect(parseIndependentReviewReceipt(JSON.stringify(result), { toolName: 'mcp__session__wait_sessions',
      sessionIds: [child.id], objectiveId: 'parent-request', acceptanceSha256: 'a'.repeat(64) })).toBeUndefined()
  })

  it('restores the current objective diagnostic without inventing an old runtime generation', async () => {
    const { host, parent, child } = harness()
    child.processingGeneration = 3
    host.persistSession(child)
    await host.flushSession(child.id)
    const saved = loadSession(child.workspace.rootPath, child.id)!
    const { messages } = saved
    const metadata = listSessions(child.workspace.rootPath).find(session => session.id === child.id)!
    const restored = createManagedSession(metadata, child.workspace, { messagesLoaded: true })
    restored.messages = messages.map(storedToMessage)
    sessionRuntimeStateForTest(host).sessions.set(child.id, restored)
    expect(restored.processingGeneration).toBe(0)
    expect(restored.pendingTurnRecovery).toEqual(child.pendingTurnRecovery)
    const result = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(requiredTestValue(result.sessions[0]).diagnostic).toMatchObject({ source: 'persisted-objective', objectiveId: 'review-request', messageId: 'review-final' })
    expect(requiredTestValue(result.sessions[0]).diagnostic!.processingGeneration).toBeUndefined()
  })

  it('sends text and gaps once per cursor and preserves diagnostic identity', async () => {
    const { host, parent, child } = harness()
    const first = await host.waitForDelegatedSessions(parent, [child.id], 0)
    const second = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(requiredTestValue(second.sessions[0]).cursor).toBe(requiredTestValue(first.sessions[0]).cursor)
    expect(requiredTestValue(second.sessions[0]).changed).toBe(false)
    expect(requiredTestValue(second.sessions[0]).diagnostic).toMatchObject({ verified: false, messageId: 'review-final' })
    expect(requiredTestValue(second.sessions[0]).diagnostic!.text).toBeUndefined()
    expect(requiredTestValue(second.sessions[0]).diagnostic!.errorText).toBeUndefined()
    expect(requiredTestValue(second.sessions[0]).diagnostic!.validationGaps).toBeUndefined()
    child.messages[2]!.content = 'A different current host diagnostic.'
    const third = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(requiredTestValue(third.sessions[0]).changed).toBe(true)
    expect(requiredTestValue(third.sessions[0]).diagnostic!.errorText).toBe(child.messages[2]!.content)
  })

  it('never exposes an old final after a new objective or a newer retry boundary', async () => {
    const { host, parent, child } = harness()
    child.activeObjective!.userMessageId = 'new-request'
    child.activeObjective!.lastUserMessageId = 'new-request'
    child.activeObjective!.objectiveId = 'new-request'
    child.activeObjective!.startedAt = 30
    child.messages.push({ id: 'new-request', role: 'user', content: 'A new request.', timestamp: 30 })
    expect(requiredTestValue((await host.waitForDelegatedSessions(parent, [child.id], 0)).sessions[0]).diagnostic).toBeUndefined()
    child.activeObjective!.userMessageId = child.activeObjective!.lastUserMessageId = child.activeObjective!.objectiveId = 'review-request'
    child.activeObjective!.startedAt = 10
    child.pendingTurnRecovery!.userRetryFromMessageCount = child.messages.length
    expect(requiredTestValue((await host.waitForDelegatedSessions(parent, [child.id], 0)).sessions[0]).diagnostic).toBeUndefined()
  })

  it('never reuses a prior generation or a final produced before an answered question', async () => {
    const { host, parent, child } = harness()
    child.processingGeneration = 2
    ;(child).waitDiagnosticBoundary = { generation: 1, objectiveId: 'review-request', fromMessageCount: 1 }
    expect(requiredTestValue((await host.waitForDelegatedSessions(parent, [child.id], 0)).sessions[0]).diagnostic).toBeUndefined()
    child.processingGeneration = 0
    child.pendingTurnRecovery!.userInputFromMessageCount = child.messages.length
    expect(requiredTestValue((await host.waitForDelegatedSessions(parent, [child.id], 0)).sessions[0]).diagnostic).toBeUndefined()
  })

  it('rejects a complete PASS under diagnostic while the same validated envelope is accepted', async () => {
    const { host, parent, child } = harness()
    const receipt = { verdict: 'PASS' as const, objectiveId: 'parent-request', acceptanceSha256: 'a'.repeat(64),
      criteria: [{ id: 'check', passed: true }], findings: [] }
    const context = { toolName: 'mcp__session__wait_sessions', sessionIds: [child.id],
      objectiveId: receipt.objectiveId, acceptanceSha256: receipt.acceptanceSha256 }
    const validatedEnvelope = JSON.stringify({ outcome: 'completed', sessions: [{ sessionId: child.id,
      state: 'idle', reason: 'complete', finalText: JSON.stringify(receipt) }] })
    expect(parseIndependentReviewReceipt(validatedEnvelope, context)).toEqual(receipt)
    child.messages[1]!.content = JSON.stringify(receipt)
    const result = await host.waitForDelegatedSessions(parent, [child.id], 0)
    expect(requiredTestValue(result.sessions[0]).diagnostic!.text).toBe(JSON.stringify(receipt))
    expect(parseIndependentReviewReceipt(JSON.stringify(result), context)).toBeUndefined()
  })

  it('does not let an unchanged failed sibling starve another completion', async () => {
    const { host, make, parent, child } = harness()
    const sibling = make('sibling'); sibling.processingGeneration = 1; sibling.isProcessing = true
    const first = await host.waitForDelegatedSessions(parent, [child.id, sibling.id], 1000)
    expect(requiredTestValue(first.sessions[0]).diagnostic!.messageId).toBe('review-final')
    const waiting = host.waitForDelegatedSessions(parent, [child.id, sibling.id], 1000)
    await new Promise(resolve => setImmediate(resolve))
    expect(sessionRuntimeStateForTest(host).sessionWaitListeners.size).toBe(1)
    sibling.isProcessing = false
    host.emitSessionComplete({ sessionId: sibling.id, workspaceId: sibling.workspace.id,
      reason: 'complete', finalMessageId: 'sibling-final', finalText: 'Verified sibling result' })
    const result = await waiting
    expect(requiredTestValue(result.sessions[0]).changed).toBe(false)
    expect(requiredTestValue(result.sessions[0]).diagnostic!.text).toBeUndefined()
    expect(requiredTestValue(result.sessions[1]).finalMessageId).toBe('sibling-final')
    expect(sessionRuntimeStateForTest(host).sessionWaitListeners.size).toBe(0)
  })

  it('bounds diagnostics, refuses nested PASS as evidence and leaves an inbox untouched', async () => {
    const { host, parent, child } = harness()
    child.messages[1]!.content = JSON.stringify({ verdict: 'PASS', findings: ['x'.repeat(40_000)] })
    child.messages[2]!.content = 'e'.repeat(5000)
    child.pendingTurnRecovery!.validationGaps = Array.from({ length: 30 }, () => 'g'.repeat(1000))
    child.messageQueue.push({ messageId: 'machine', message: 'Send your findings.', options: {
      internalOrigin: { kind: 'agent-message', senderSessionId: parent.id } } })
    const result = await host.waitForDelegatedSessions(parent, [child.id], 0)
    const diagnostic = requiredTestValue(result.sessions[0]).diagnostic!
    expect(diagnostic.text!.length).toBe(32_000)
    expect(diagnostic.textTruncated).toBe(true)
    expect(diagnostic.errorText!.length).toBe(2000)
    expect(diagnostic.validationGaps).toHaveLength(16)
    expect(requiredTestValue(diagnostic.validationGaps![0]).length).toBe(500)
    expect(child.messageQueue).toHaveLength(1)
    expect(parseIndependentReviewReceipt(JSON.stringify(result), { toolName: 'mcp__session__wait_sessions',
      sessionIds: [child.id], objectiveId: 'parent-request', acceptanceSha256: 'a'.repeat(64) })).toBeUndefined()
  })

  it('does not expose diagnostics while processing, awaiting a human, or in another workspace', async () => {
    const { host, parent, child } = harness()
    child.isProcessing = true
    expect(requiredTestValue((await host.waitForDelegatedSessions(parent, [child.id], 0)).sessions[0]).diagnostic).toBeUndefined()
    child.isProcessing = false
    child.userInputRequests = ([{ id: 'question', sessionId: child.id, status: 'pending', createdAt: 25 }] satisfies Array<Partial<NonNullable<typeof child.userInputRequests>[number]>>) as NonNullable<typeof child.userInputRequests>
    expect(requiredTestValue((await host.waitForDelegatedSessions(parent, [child.id], 0)).sessions[0]).diagnostic).toBeUndefined()
    child.userInputRequests = []
    child.workspace = { ...child.workspace, id: 'foreign' }
    await expect(host.waitForDelegatedSessions(parent, [child.id], 0))
      .rejects.toThrow('Wait targets must be current delegated descendants')
  })
})

// These fixtures exercise the opt-in historical host contract.
let previousLegacyContract: string | undefined;
beforeEach(() => {
  previousLegacyContract = process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"];
  process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1';
});
afterEach(() => {
  if (previousLegacyContract === undefined) delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"];
  else process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = previousLegacyContract;
});
