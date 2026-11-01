import { parseRecoveryJournalObservation } from './testing/recovery-journal-observation.ts';
import type { SendMessageOptions } from '../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { registerObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria";
import { cleanupRestartRecovery, type Managed, bindToolAdmissionTurn, deferred, harness, prepareStartedRecoveryAdmission, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('keeps the parent tool boundary authoritative while an exact child delivery waits durably behind it', async () => {
    const h = harness(); const parent = h.make('parent-tool-with-child-inbox'); const child = h.make('queued-child-result', parent.id)
    const parentObjectiveId = parent.activeObjective!.objectiveId ?? parent.activeObjective!.userMessageId
    child.delegation = {
      rootSessionId: parent.id,
      rootObjectiveId: parentObjectiveId,
      parentObjectiveId,
      depth: 1,
      role: 'worker',
    }
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(parent.workspace, { async *chat() {}, isProcessing: () => true }), { dispose: async () => {} })
    parent.agent = runtimeAgent
    parent.isProcessing = true
    parent.processingGeneration = 7
    bindToolAdmissionTurn(h.runtime, parent, runtimeAgent, 7)
    const deliveryId = 'queued-child-result-delivery'
    const queuedDelivery: Managed['messages'][number] = {
      id: 'queued-child-result-message',
      role: 'user',
      content: 'Child progress retained for the next parent turn.',
      timestamp: 2,
      hidden: true,
      isQueued: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: child.id, deliveryId },
      agentDelivery: { id: deliveryId, status: 'queued', attempts: 0 },
    }
    parent.messages.push(queuedDelivery)
    parent.messageQueue.push({
      messageId: queuedDelivery.id,
      message: queuedDelivery.content,
      options: { hidden: true, ...(queuedDelivery.internalOrigin !== undefined ? { internalOrigin: queuedDelivery.internalOrigin } : {}) },
    })
    await h.save(parent)

    await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(parent, runtimeAgent, {
      toolUseId: 'parent-read-after-child-queue',
      toolName: 'Read',
      toolInput: { file_path: '/fixture/current-parent-target.txt' },
    })

    expect(parent.messages.find(message => message.toolUseId === 'parent-read-after-child-queue'))
      .toMatchObject({ toolStatus: 'executing', toolInput: { file_path: '/fixture/current-parent-target.txt' } })
    expect(queuedDelivery).toMatchObject({ isQueued: true, agentDelivery: { status: 'queued', attempts: 0 } })
    expect(parent.messageQueue.map(item => item.messageId)).toEqual([queuedDelivery.id])
    const stored = readFileSync(getSessionFilePath(h.rootPath, parent.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
    expect(stored.find(message => message.toolUseId === 'parent-read-after-child-queue'))
      .toMatchObject({ toolStatus: 'executing' })

    const queuedHuman: Managed['messages'][number] = {
      id: 'queued-human-supersession', role: 'user', content: 'Use a different target.', timestamp: 3,
      isQueued: true,
    }
    parent.messages.push(queuedHuman)
    parent.messageQueue.push({ messageId: queuedHuman.id, message: queuedHuman.content })
    await h.save(parent)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(parent, runtimeAgent, {
      toolUseId: 'parent-read-after-human-queue',
      toolName: 'Read',
      toolInput: { file_path: '/fixture/must-not-run.txt' },
    })).rejects.toThrow('exact provider turn')
    expect(parent.messages.some(message => message.toolUseId === 'parent-read-after-human-queue')).toBe(false)
  })

  it('admits a deferred child result after historical turns but fences a new human turn', async () => {
    const h = harness(); const managed = h.make('deferred-child-old-boundary')
    const deliveryId = 'historical-child-delivery'
    const delivered: Managed['messages'][number] = {
      id: 'historical-child-result', role: 'user', content: 'Verified child result.', timestamp: 2,
      hidden: true, isQueued: false,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'child', deliveryId },
      agentDelivery: { id: deliveryId, status: 'processed', attempts: 1 },
    }
    managed.messages.push(delivered, {
      id: 'historical-human-answer', role: 'user', content: 'Continue the same objective.', timestamp: 3,
    }, {
      id: 'historical-recovery', role: 'user', hidden: true, timestamp: 4,
      content: '<automatic_turn_recovery>Continue.</automatic_turn_recovery>',
    })
    const laterDeliveryId = 'later-child-delivery'
    managed.messages.push({
      id: 'later-child-result', role: 'user', content: 'Another child result.', timestamp: 5,
      hidden: true, isQueued: true,
      internalOrigin: { kind: 'agent-message', senderSessionId: 'other-child', deliveryId: laterDeliveryId },
      agentDelivery: { id: laterDeliveryId, status: 'queued', attempts: 0 },
    })
    managed.messageQueue.push({
      messageId: 'later-child-result', message: 'Another child result.',
      options: { hidden: true, internalOrigin: { kind: 'agent-message', senderSessionId: 'other-child', deliveryId: laterDeliveryId } },
    })
    managed.lastSentOptions = omitUndefined<SendMessageOptions>({ hidden: true, internalOrigin: delivered.internalOrigin })
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(managed.workspace, { async *chat() {}, isProcessing: () => true }), { dispose: async () => {} })
    managed.agent = runtimeAgent
    managed.isProcessing = true
    managed.processingGeneration = 31
    bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, 31, delivered.id)
    await h.save(managed)

    await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'deferred-child-read', toolName: 'Read',
      toolInput: { file_path: '/fixture/current-child-result.txt' },
    })
    expect(managed.messages.find(message => message.toolUseId === 'deferred-child-read'))
      .toMatchObject({ toolStatus: 'executing' })

    managed.messages.push({
      id: 'new-human-after-handoff', role: 'user', content: 'Use a different target.', timestamp: 5,
    })
    await h.save(managed)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'deferred-child-stale-read', toolName: 'Read',
      toolInput: { file_path: '/fixture/must-not-run.txt' },
    })).rejects.toThrow('exact provider turn')
  })

  it('keeps the provider turn after durable criteria registration and fences a later human turn', async () => {
    const h = harness(); const managed = h.make('criteria-registration-tool-admission')
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(managed.workspace, { async *chat() {}, isProcessing: () => true }), { dispose: async () => {} })
    managed.agent = runtimeAgent
    managed.isProcessing = true
    managed.processingGeneration = 7
    bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, 7)
    await h.save(managed)
    const objectiveBefore = managed.activeObjective!
    const registered = registerObjectiveAcceptanceCriteria(objectiveBefore, [{
      id: 'target-verified', description: 'The requested target is verified',
      toolName: 'mcp__ops__get_target', input: { id: 'target' },
      checks: [{ path: 'verified', equals: true }],
    }], Date.now(), undefined, managed.messages, managed.id)

    const originalFlush = h.manager.flushSession.bind(h.manager)
    const flushEntered = deferred(); const releaseFlush = deferred()
    let heldFlush = false
    h.manager.flushSession = async id => {
      if (id === managed.id && !heldFlush) {
        heldFlush = true
        flushEntered.resolve()
        await releaseFlush.promise
      }
      await originalFlush(id)
    }
    const registration = h.runtime.persistRegisteredObjectiveForCurrentTurn(
      managed, runtimeAgent, objectiveBefore, registered, 7, 0,
    )
    await flushEntered.promise
    let admitted = false
    const readAdmission = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'read-after-criteria-registration', toolName: 'Read',
      toolInput: { file_path: '/fixture/current-target.txt' },
    }).then(() => { admitted = true })
    await tick()
    expect(admitted).toBe(false)
    expect(requiredTestValue(sessionRuntimeStateForTest(h.runtime).runtimeToolAdmissionBindings.get(runtimeAgent)).activeObjective).toBe(objectiveBefore)

    releaseFlush.resolve()
    await registration
    await readAdmission
    h.manager.flushSession = originalFlush
    expect(requiredTestValue(sessionRuntimeStateForTest(h.runtime).runtimeToolAdmissionBindings.get(runtimeAgent)).activeObjective).toBe(registered)
    expect(managed.messages.find(message => message.toolUseId === 'read-after-criteria-registration'))
      .toMatchObject({ toolStatus: 'executing' })

    managed.messages.push({ id: 'later-human-after-criteria', role: 'user', content: 'Use another target.', timestamp: Date.now() })
    await h.save(managed)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'read-after-later-human', toolName: 'Read',
      toolInput: { file_path: '/fixture/must-not-run.txt' },
    })).rejects.toThrow('exact provider turn')
  })

  it('does not rebind a provider turn when criteria registration fails to persist', async () => {
    const h = harness(); const managed = h.make('criteria-registration-flush-failure')
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(managed.workspace, { async *chat() {}, isProcessing: () => true }), { dispose: async () => {} })
    managed.agent = runtimeAgent
    managed.isProcessing = true
    managed.processingGeneration = 7
    bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, 7)
    const objectiveBefore = managed.activeObjective!
    const registered = { ...objectiveBefore, acceptanceRevision: 'new-criteria-revision' }
    const originalFlush = h.manager.flushSession.bind(h.manager)
    h.manager.flushSession = async () => { throw new Error('simulated persistence failure') }

    await expect(h.runtime.persistRegisteredObjectiveForCurrentTurn(
      managed, runtimeAgent, objectiveBefore, registered, 7, 0,
    )).rejects.toThrow('simulated persistence failure')
    expect(requiredTestValue(sessionRuntimeStateForTest(h.runtime).runtimeToolAdmissionBindings.get(runtimeAgent)).activeObjective).toBe(objectiveBefore)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'read-after-failed-registration', toolName: 'Read',
      toolInput: { file_path: '/fixture/must-not-run.txt' },
    })).rejects.toThrow('exact provider turn')
    h.manager.flushSession = originalFlush
  })

  it('admits tools from an explicit Retry across historical recovery prompts and fences a later human turn', async () => {
    const h = harness(); const managed = h.make('retry-admission-after-recovery-history')
    managed.messages.push({
      id: 'historical-recovery', role: 'user', hidden: true, timestamp: 2,
      content: '<automatic_turn_recovery original_user_message_id="retry-admission-after-recovery-history-user" attempt="2">\nContinue.\n</automatic_turn_recovery>',
    }, {
      id: 'historical-final', role: 'assistant', timestamp: 3,
      content: 'The previous automatic pass stopped before completion.',
    })
    const allocatedAt = Date.now() - 2_000
    const startedAt = allocatedAt + 1_000
    const messageBoundary = managed.messages.length
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      lastCause: 'user_retry',
      userRetryFromMessageCount: messageBoundary,
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'explicit-retry-dispatch',
        attempt: 3,
        cause: 'user_retry',
        origin: 'retry',
        allocatedAt,
        phase: 'started',
        startedAt,
        preToolExecutionReceiptVersion: 1,
      },
    }
    await h.save(managed)
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(managed.workspace, { async *chat() {}, isProcessing: () => true }), { dispose: async () => {} })
    managed.agent = runtimeAgent
    managed.isProcessing = true
    managed.processingGeneration = 21
    managed.lastSentOptions = {
      hidden: true,
      automaticRecovery: {
        originalUserMessageId: `${managed.id}-user`,
        cause: 'user_retry',
        dispatchId: 'explicit-retry-dispatch',
        dispatchAttempt: 3,
        dispatchOrigin: 'retry',
        dispatchAllocatedAt: allocatedAt,
      },
    }
    bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, 21, `${managed.id}-user`)

    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId: 'retry-plan', toolName: 'mcp__session__update_plan',
      input: { plan: [{ step: 'Continue verified work', status: 'in_progress' }] },
      intent: 'Keep the verified retry work organized.', displayName: 'Update retry plan',
    }, 21)
    await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'retry-plan', toolName: 'mcp__session__update_plan',
      toolInput: { plan: [{ step: 'Continue verified work', status: 'in_progress' }] },
    })
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId: 'retry-question', toolName: 'mcp__session__request_user_input',
      input: { questions: [{ id: 'scope', question: 'Which scope?', options: [{ id: 'same', label: 'Same' }] }] },
      intent: 'Ask one material scope question.', displayName: 'Confirm scope',
    }, 21)
    await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'retry-question', toolName: 'mcp__session__request_user_input',
      toolInput: { questions: [{ id: 'scope', question: 'Which scope?', options: [{ id: 'same', label: 'Same' }] }] },
    })
    expect(managed.messages.filter(message => (
      message.toolUseId === 'retry-plan' || message.toolUseId === 'retry-question'
    ))).toHaveLength(2)

    managed.messages.push({
      id: 'later-human', role: 'user', content: 'Use a different deployment target.', timestamp: Date.now(),
    })
    await h.save(managed)
    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'retry-after-human', toolName: 'Read', toolInput: { file_path: '/fixture/must-not-run.txt' },
    })).rejects.toThrow('no longer owns')
    expect(managed.messages.some(message => message.toolUseId === 'retry-after-human')).toBe(false)
  })

  it('admits a reconciliation Read from a clean Retry boundary but quarantines an uncertain prior mutation', async () => {
    process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
    const h = harness(); const managed = h.make('clean-context-retry-tool-admission')
    const rootId = `${managed.id}-user`
    const allocatedAt = Date.now() - 2_000
    const startedAt = allocatedAt + 500
    const boundaryId = 'clean-context-retry-boundary'
    managed.messages.push({
      id: 'uncertain-prior-mutation', role: 'tool', content: 'Running Edit...',
      timestamp: startedAt - 100, toolName: 'Edit', toolUseId: 'uncertain-prior-edit',
      toolInput: { file_path: '/fixture/state.json', old_string: 'before', new_string: 'after' },
      toolStatus: 'executing',
    }, {
      id: boundaryId, role: 'user', hidden: true, timestamp: startedAt + 1,
      content: '<host_clean_recovery_continuation schema_version="1">\nReconcile and verify.\n</host_clean_recovery_continuation>',
    })
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!, lastCause: 'user_retry',
      userRetryFromMessageCount: 2,
      cleanContextBoundaryMessageId: boundaryId,
      recoveryDispatch: {
        schemaVersion: 1, id: boundaryId, attempt: 3, cause: 'user_retry', origin: 'retry',
        allocatedAt, phase: 'started', startedAt, preToolExecutionReceiptVersion: 1,
        cleanContinuationId: 'clean-context-handoff',
      },
    }
    managed.providerContextBoundaryMessageId = boundaryId
    managed.lastSentOptions = {
      hidden: true,
      automaticRecovery: {
        originalUserMessageId: rootId, cause: 'user_retry', dispatchId: boundaryId,
        dispatchAttempt: 3, dispatchOrigin: 'retry', dispatchAllocatedAt: allocatedAt,
        cleanContinuationId: 'clean-context-handoff',
      },
    }
    await h.save(managed)
    const runtimeAgent = Object.assign(new ScriptedSessionAgent(managed.workspace, { async *chat() {}, isProcessing: () => true }), { dispose: async () => {} })
    managed.agent = runtimeAgent
    managed.isProcessing = true
    managed.processingGeneration = 28
    bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, 28, boundaryId)

    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, {
        toolUseId: 'clean-retry-repeated-edit', toolName: 'Edit',
        toolInput: { file_path: '/fixture/other.json', old_string: 'a', new_string: 'b' },
      },
    )).rejects.toThrow('still executing without a result')
    expect(managed.messages.some(message => message.toolUseId === 'clean-retry-repeated-edit')).toBe(false)

    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
      managed, runtimeAgent, {
        toolUseId: 'clean-retry-reconciliation-read', toolName: 'Read',
        toolInput: { file_path: '/fixture/state.json' },
      },
    )).resolves.toBeUndefined()
    const receipt = managed.messages.find(message => message.toolUseId === 'clean-retry-reconciliation-read')
    expect(receipt).toMatchObject({ role: 'tool', toolStatus: 'executing',
      toolInput: { file_path: '/fixture/state.json' } })
    const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
      .trim().split('\n').map(parseRecoveryJournalObservation)
    const boundaryIndex = stored.findIndex(message => message.id === boundaryId)
    const receiptIndex = stored.findIndex(message => message.toolUseId === 'clean-retry-reconciliation-read')
    expect(boundaryIndex).toBe(3)
    expect(receiptIndex).toBeGreaterThan(boundaryIndex)
  })

  it('does not quarantine a recovery behind unresolved observational receipts', async () => {
    const h = harness()
    const { managed, runtimeAgent, dispatchId } = await prepareStartedRecoveryAdmission(
      h, 'recovery-after-unresolved-observations', 29,
    )
    const dispatchIndex = managed.messages.findIndex(message => message.id === dispatchId)
    managed.messages.splice(dispatchIndex, 0, {
      id: 'old-oss-list', role: 'tool', content: 'Listing...', timestamp: Date.now() - 2_000,
      toolName: 'mcp__rbw-agents-oss__oss_list_files', toolUseId: 'old-oss-list',
      toolInput: { path: '/srv/rbw-agents-oss/config', maxDepth: 1 }, toolStatus: 'executing',
    }, {
      id: 'old-child-wait', role: 'tool', content: 'Waiting...', timestamp: Date.now() - 1_500,
      toolName: 'mcp__session__wait_sessions', toolUseId: 'old-child-wait',
      toolInput: { sessionIds: ['child'], timeoutMs: 60_000, mode: 'all' }, toolStatus: 'executing',
    })
    await h.save(managed)

    await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, {
      toolUseId: 'new-recovery-edit', toolName: 'Edit',
      toolInput: { file_path: '/fixture/other.json', old_string: 'a', new_string: 'b' },
    })).resolves.toBeUndefined()
    expect(managed.messages.find(message => message.toolUseId === 'new-recovery-edit'))
      .toMatchObject({ role: 'tool', toolStatus: 'executing' })
  })
});
