import { sessionManagerForTest } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { classifyAutomaticRecoveryWorkForSession as policyClassifyAutomaticRecoveryWorkForSession } from "./SessionManager/policy.ts";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messageToStored, storedToMessage, type AgentEvent, type Message, type ObjectiveOutcomeDeclaration } from "@craft-agent/core/types";
import { readSessionJsonl, writeSessionJsonl } from "@craft-agent/shared/sessions/jsonl";
import { pickSessionFields } from "@craft-agent/shared/sessions/utils";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import { createPendingTurnRecovery } from "./turn-recovery.ts";
import { createManagedSession } from "./SessionManager.ts";
import { activeObjective, installAgent, installReviewedAgent, makeHarness, outcomeComment, roots, sessionIds } from "./testing/session-objective-outcome-integration-fixture.ts";

beforeEach(() => {
  roots.length = 0
  sessionIds.length = 0
  process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
})
afterEach(() => {
  delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
  for (const sessionId of sessionIds) clearObjectiveEvidenceGate(sessionId)
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('SessionManager objective outcome integration', () => {
  it('grants one escalated bounded recovery before maxNoProgress=1 exhausts the unchanged gap', async () => {
    const harness = makeHarness('bounded-escalation-before-exhaustion')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'bounded-escalation-before-exhaustion',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 4, maxNoProgressAttempts: 1 } },
    }))
    harness.managed.messages.push({ id: 'root', role: 'user', content: 'Vérifie le résultat en lecture seule.', timestamp: 1 })
    harness.managed.activeObjective = {
      ...activeObjective('root'),
      originalText: 'Vérifie le résultat en lecture seule.',
      requiresExecutionEvidence: false,
    }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('root')
    const enqueue = (sessionManagerForTest(harness.manager)).enqueueAutomaticTurnRecovery.bind(harness.manager)
    const gaps = ['missing structured objective outcome receipt']

    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(true)
    expect(harness.managed.messageQueue[0]?.message).toContain('attempt="1"')
    harness.managed.messageQueue.length = 0

    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({ attempts: 2, stagnantAttempts: 1 })
    expect(harness.managed.messageQueue[0]?.message).toContain('attempt="2"')
    harness.managed.messageQueue.length = 0

    expect(await enqueue(harness.managed, 'objective_incomplete', gaps)).toBe(false)
    expect<unknown>(harness.managed.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      stagnantAttempts: 1,
      exhaustedAt: (expect.any(Number) as unknown),
    })
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('keeps an execution recovery substantive when the only mutation is unrelated to its target', () => {
    const harness = makeHarness('unrelated-mutation-is-not-execution-proof')
    const rootText = 'Déploie le service Orion sur le serveur de production.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 }, {
      id: 'unrelated-write', role: 'tool', content: '', timestamp: 2,
      toolName: 'Write', toolUseId: 'unrelated-write', toolStatus: 'completed', toolExecuted: true,
      toolInput: { file_path: '/tmp/unrelated-note.txt' }, toolResult: 'Wrote unrelated note.',
    })
    harness.managed.activeObjective = {
      ...activeObjective('root'),
      originalText: rootText,
      requiresExecutionEvidence: true,
    }
    const classify = policyClassifyAutomaticRecoveryWorkForSession.bind(harness.manager)

    expect(classify(harness.managed, 'objective_incomplete', [
      'missing structured objective outcome receipt',
    ])).toBe('substantive')
  })

  it('routes terminal reconciliation recovery as read-only even when the root requested a mutation', () => {
    const harness = makeHarness('terminal-reconciliation-is-read-only')
    const rootText = 'Déploie le service Orion sur le serveur de production.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 })
    harness.managed.activeObjective = {
      ...activeObjective('root'),
      originalText: rootText,
      requiresExecutionEvidence: true,
      terminalReconciliation: { messageId: 'terminal-close', timestamp: 2 },
    }
    const classify = policyClassifyAutomaticRecoveryWorkForSession.bind(harness.manager)

    expect(classify(harness.managed, 'objective_incomplete', [
      'missing structured objective outcome receipt',
    ])).toBe('read-only-verification')
  })

  it('retains a rejected contract across an empty runtime diagnostic and exhausts only on the next unchanged rejection', async () => {
    const harness = makeHarness('runtime-keeps-validation-gap')
    writeFileSync(join(harness.managed.workspace.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1,
      id: harness.managed.workspace.id,
      name: harness.managed.workspace.name,
      slug: 'runtime-keeps-validation-gap',
      createdAt: 1,
      updatedAt: 1,
      costControl: { recovery: { maxAutomaticAttempts: 4, maxNoProgressAttempts: 1 } },
    }))
    const rootText = 'Déploie le résultat demandé puis vérifie-le.'
    harness.managed.messages.push({ id: 'root', role: 'user', content: rootText, timestamp: 1 })
    harness.managed.activeObjective = { ...activeObjective('root'), originalText: rootText }
    harness.managed.pendingTurnRecovery = createPendingTurnRecovery('root')
    const enqueue = (sessionManagerForTest(harness.manager)).enqueueAutomaticTurnRecovery.bind(harness.manager)
    const gap = 'malformed objective outcome receipt: criteria[2].satisfied must be a boolean'

    expect(await enqueue(harness.managed, 'objective_incomplete', [gap])).toBe(true)
    harness.managed.messageQueue.length = 0
    expect(await enqueue(harness.managed, 'runtime_error', [])).toBe(true)
    expect(harness.managed.pendingTurnRecovery).toMatchObject({
      stagnantAttempts: 0,
      validationGaps: [gap],
    })
    expect(harness.managed.pendingTurnRecovery?.exhaustedAt).toBeUndefined()
    harness.managed.messageQueue.length = 0
    expect(await enqueue(harness.managed, 'objective_incomplete', [gap])).toBe(false)
    expect<unknown>(harness.managed.pendingTurnRecovery).toMatchObject({
      exhaustedAt: (expect.any(Number) as unknown),
      validationGaps: [gap],
    })
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('repairs only a persisted false completion contradicted by its own final receipt', () => {
    const harness = makeHarness('restore-unfinished-final')
    const unfinished: ObjectiveOutcomeDeclaration = {
      state: 'continue',
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: false, evidence: ['assistant-final'] },
        { id: 'no-safe-work-remaining', satisfied: false, evidence: ['assistant-final'] },
      ],
      remainingWork: ['Send and verify the two approved messages.'],
      blocker: null,
    }
    const final: Message = {
      id: 'unfinished-final', role: 'assistant', content: 'Two sends remain.',
      timestamp: 4, objectiveOutcome: unfinished,
    }
    const restored = createManagedSession({
      id: 'restored-unfinished',
      lastFinalMessageId: final.id,
      activeObjective: {
        ...activeObjective('root'), startedAt: 1,
        terminalState: 'complete_verified', completedAt: 5,
      },
    }, harness.managed.workspace, { messagesLoaded: true, messages: [final] })
    expect(restored.activeObjective).toMatchObject({
      terminalState: 'exhausted', lastOutcome: unfinished,
    })
    expect(restored.activeObjective?.completedAt).toBeUndefined()
    expect(restored.pendingTurnRecovery).toBeUndefined()

    const unrelated = createManagedSession({
      id: 'restored-unrelated', lastFinalMessageId: 'other-final',
      activeObjective: {
        ...activeObjective('root'), startedAt: 1,
        terminalState: 'complete_verified', completedAt: 5,
      },
    }, harness.managed.workspace, { messagesLoaded: true, messages: [final] })
    expect(unrelated.activeObjective?.terminalState).toBe('complete_verified')

    const duplicate = createManagedSession({
      id: 'restored-duplicate', lastFinalMessageId: final.id,
      activeObjective: {
        ...activeObjective('root'), startedAt: 1,
        terminalState: 'complete_verified', completedAt: 5,
      },
    }, harness.managed.workspace, { messagesLoaded: true, messages: [final, { ...final }] })
    expect(duplicate.activeObjective?.terminalState).toBe('complete_verified')
  })

  it('never marks a delivered final as verified when registered outcome evidence is missing', async () => {
    const harness = makeHarness('final-with-unmet-objective')
    const declaration: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      criteria: [
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['assistant-final'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['assistant-final'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
        { id: 'target-verified', satisfied: true, evidence: ['assistant-final'] },
      ],
      remainingWork: [],
      blocker: null,
    }
    installAgent(harness, [
      { type: 'text_complete', text: `Travail annoncé.\n${outcomeComment(declaration)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.pendingTurnRecovery = {
        ...harness.managed.pendingTurnRecovery!, attempts: 256,
      }
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'target-verified', description: 'Read the requested result',
        toolName: 'Read', input: { path: 'target.json' }, checks: [{ path: '$.valid', equals: true }],
      }])
    })

    await harness.manager.sendMessage(harness.managed.id, 'Livre le résultat et vérifie target.json.')
    expect(harness.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(harness.managed.activeObjective?.completedAt).toBeUndefined()
    expect<unknown>(harness.managed.pendingTurnRecovery).toMatchObject({
      exhaustedAt: (expect.any(Number) as unknown),
      validationGaps: (expect.arrayContaining([
        'Business criterion lacks matching post-action evidence: target-verified',
      ]) as unknown),
    })
    expect(harness.managed.messages.findLast(message => message.role === 'error'))
      .toMatchObject({ errorCode: 'objective_validation_failed', errorCanRetry: true })
  })

  it('preserves the actual exhausted validation diagnostic across disk, restart and retry without resetting its objective budget', async () => {
    const harness = makeHarness('durable-validation-failure')
    const invalidFinal: AgentEvent[] = [
      { type: 'text_complete', text: 'Résultat conservé. <!-- robb_objective_outcome {"state":"complete_verified"} -->' },
      { type: 'complete' },
    ]
    installAgent(harness, invalidFinal, () => {
      harness.managed.pendingTurnRecovery = {
        ...harness.managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 7,
        validationGaps: ['Previous rejection which is no longer the current diagnostic'],
      }
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'saved-target', description: 'Existing target must be verified', toolName: 'Read',
        input: { path: 'target.json' }, checks: [{ path: '$.valid', equals: true }],
      }])
      harness.managed.messages.push({
        id: 'preserved-action', role: 'tool', content: '', timestamp: Date.now(),
        toolName: 'Write', toolUseId: 'existing-write', toolStatus: 'completed', toolExecuted: true,
        toolInput: { file_path: 'target.json' }, toolResult: 'The requested target was saved successfully.',
      })
      harness.managed.messages.push({
        id: 'preserved-check', role: 'tool', content: '', timestamp: Date.now(),
        toolName: 'Read', toolUseId: 'provider-check-id', toolStatus: 'completed', toolExecuted: true,
        toolInput: { path: 'target.json' }, toolResult: '{"valid":true}',
      })
    })
    await harness.manager.sendMessage(harness.managed.id, 'Implémente le résultat puis teste-le.')
    const diagnostic = 'malformed objective outcome receipt: criteria must be a bounded array'
    const stopped = structuredClone(harness.managed.pendingTurnRecovery)
    expect<unknown>(structuredClone(stopped)).toMatchObject({ attempts: 256, stagnantAttempts: 7, lastCause: 'objective_incomplete', exhaustedAt: (expect.any(Number) as unknown), validationGaps: (expect.arrayContaining([diagnostic]) as unknown) })
    expect(stopped?.validationGaps).not.toContain('Previous rejection which is no longer the current diagnostic')
    const error = harness.managed.messages.at(-1)!
    expect<unknown>(structuredClone(error)).toMatchObject({ role: 'error', errorCode: 'objective_validation_failed', errorCanRetry: true, errorDetails: (expect.arrayContaining([diagnostic]) as unknown) })
    expect(harness.sentEvents.findLast(event => event["type"] === 'typed_error')).toMatchObject({ error: { code: 'objective_validation_failed', details: error.errorDetails } })

    const path = join(harness.managed.workspace.rootPath, 'session.jsonl')
    writeSessionJsonl(path, {
      ...pickSessionFields(harness.managed), workspaceRootPath: harness.managed.workspace.rootPath,
      createdAt: 1, lastUsedAt: Date.now(), messages: harness.managed.messages.map(messageToStored),
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as never)
    const persisted = readSessionJsonl(path)!
    const restored = createManagedSession(persisted as never, harness.managed.workspace, {
      messagesLoaded: true, messages: persisted.messages.map(storedToMessage),
    })
    harness.managed = restored
    const internals = sessionManagerForTest(harness.manager)
    sessionRuntimeStateForTest(internals).sessions.set(restored.id, restored)
    await internals.resumePendingTurnAfterRestart(restored.id)
    expect(restored.isProcessing).toBe(false)
    expect(restored.messageQueue).toEqual([])
    expect(restored.pendingTurnRecovery).toEqual(stopped)
    const objective = structuredClone(restored.activeObjective)
    const originalMessages = structuredClone(restored.messages)
    const userId = restored.messages.find(message => message.role === 'user' && !message.hidden)!.id

    internals.flushSession = async () => { throw new Error('Fixture retry marker flush failed') }
    await expect(harness.manager.retryTurn(restored.id, userId)).rejects.toThrow('Fixture retry marker flush failed')
    expect(restored.pendingTurnRecovery).toEqual(stopped)
    expect(restored.activeObjective).toEqual(objective)
    expect(restored.messages).toEqual(originalMessages)
    expect(restored.isProcessing).toBe(false)
    internals.flushSession = async () => {}
    installAgent(harness, invalidFinal)
    let dispatch: Promise<void> | undefined
    const send = harness.manager.sendMessage.bind(harness.manager)
    harness.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    await expect(harness.manager.retryTurn(restored.id, userId)).resolves.toEqual({ status: 'started' })
    expect(restored.lastSentMessage).toContain(diagnostic)
    expect(restored.lastSentMessage).toContain('Do not repeat an external mutation')
    expect(restored.lastSentMessage).toContain('"messageId":"preserved-check"')
    await dispatch
    expect<unknown>(structuredClone(restored.pendingTurnRecovery)).toMatchObject({ attempts: 256, stagnantAttempts: 7, exhaustedAt: (expect.any(Number) as unknown), validationGaps: (expect.arrayContaining([diagnostic]) as unknown) })
    expect(restored.activeObjective).toEqual(objective)
    expect(restored.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(restored.messages.filter(message => message.role === 'tool')).toEqual(originalMessages.filter(message => message.role === 'tool'))

    installAgent(harness, [{ type: 'text_complete', text: 'Une phrase nouvelle.' }, { type: 'complete' }], () => {
      expect(restored.pendingTurnRecovery?.attempts).toBe(0)
      expect(restored.activeObjective?.userMessageId).not.toBe(userId)
      expect(restored.activeObjective?.acceptanceCriteria).toBeUndefined()
    })
    await harness.manager.sendMessage(restored.id, 'Nouvel objectif : bonjour.')
    expect(restored.activeObjective?.terminalState).toBe('complete_verified')
    expect(restored.pendingTurnRecovery).toBeUndefined()
  })

  it.each(['setup', 'network'])('keeps the exhausted validation budget when an accepted retry fails during %s and does not restart it automatically', async failure => {
    const harness = makeHarness(`validation-retry-${failure}`)
    installAgent(harness, [
      { type: 'text_complete', text: 'Résultat fixture. <!-- robb_objective_outcome {"state":"complete_verified"} -->' },
      { type: 'complete' },
    ], () => { harness.managed.pendingTurnRecovery = { ...harness.managed.pendingTurnRecovery!, attempts: 256, stagnantAttempts: 7 } })
    await harness.manager.sendMessage(harness.managed.id, 'Implémente le résultat puis vérifie-le.')
    const stopped = structuredClone(harness.managed.pendingTurnRecovery!)
    const root = harness.managed.activeObjective!.userMessageId
    if (failure === 'setup') {
      ;(sessionManagerForTest(harness.manager)).getOrCreateAgent = async () => { throw new Error('Fixture runtime unavailable before provider startup') }
      harness.managed.agent = null
    } else {
      installAgent(harness, [
        { type: 'typed_error', error: { code: 'network_error', title: 'Fixture network failure', message: 'Connection unavailable', actions: [], canRetry: true } },
        { type: 'complete' },
      ])
    }
    let dispatch: Promise<void> | undefined
    const send = harness.manager.sendMessage.bind(harness.manager)
    harness.manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
    await expect(harness.manager.retryTurn(harness.managed.id, root)).resolves.toEqual({ status: 'started' })
    await dispatch
    expect(harness.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(harness.managed.pendingTurnRecovery?.attempts).toBe(stopped.attempts)
    expect(harness.managed.pendingTurnRecovery?.stagnantAttempts).toBe(stopped.stagnantAttempts)
    expect(harness.managed.pendingTurnRecovery?.validationGaps).toEqual(stopped.validationGaps)
    expect(harness.managed.pendingTurnRecovery?.validationExhausted).toBe(true)
    expect(harness.managed.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(harness.managed.isProcessing).toBe(false)
    harness.manager.retryTurn = async () => { throw new Error('A stopped retry must not start automatically') }
    const marker = structuredClone(harness.managed.pendingTurnRecovery)
    await (sessionManagerForTest(harness.manager)).resumePendingTurnAfterRestart(harness.managed.id)
    expect(harness.managed.pendingTurnRecovery).toEqual(marker)
    expect(harness.managed.messageQueue).toEqual([])
  })

  it('accepts exact absolute input and JSON output from the actual event persistence path without another turn', async () => {
    const harness = makeHarness('exact-tool-evidence')
    const target = join(process.cwd(), 'output.json')
    const command = `cat '${target}'`
    const result = JSON.stringify({ path: target, passed: true })
    const receipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        { id: 'document-verified', satisfied: true, evidence: ['verify-document'] },
        { id: 'requested-outcome-delivered', satisfied: true, evidence: ['verify-document'] },
        { id: 'relevant-checks-passed', satisfied: true, evidence: ['verify-document'] },
        { id: 'no-safe-work-remaining', satisfied: true, evidence: ['assistant-final'] },
      ],
    }
    installReviewedAgent(harness, [
      { type: 'tool_start', toolName: 'Bash', toolUseId: 'verify-document', input: { command } },
      { type: 'tool_result', toolName: 'Bash', toolUseId: 'verify-document', result, isError: false, executed: true },
      { type: 'text_complete', text: `Document vérifié.\n${outcomeComment(receipt)}` },
      { type: 'complete' },
    ], () => {
      harness.managed.activeObjective = registerObjectiveAcceptanceCriteria(harness.managed.activeObjective!, [{
        id: 'document-verified', description: 'Document exact inspected', toolName: 'functions.bash',
        input: { command }, checks: [{ path: '$.path', equals: target }, { path: '$.passed', equals: true }],
      }])
    })
    await harness.manager.sendMessage(harness.managed.id, 'Vérifie le document demandé.')
    const tool = harness.managed.messages.find(message => message.toolUseId === 'verify-document')!
    expect(tool.toolInput).toEqual({ command })
    expect(tool.toolResult).toBe(result)
    expect(messageToStored(tool).toolInput).toEqual({ command })
    expect(messageToStored(tool).toolResult).toBe(result)
    expect(harness.sentEvents.find(event => event["type"] === 'tool_start')?.["toolInput"]).toEqual({ command })
    expect(harness.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(harness.managed.messageQueue).toEqual([])
    expect(harness.resumedSessionIds).toEqual([])
  })
});
