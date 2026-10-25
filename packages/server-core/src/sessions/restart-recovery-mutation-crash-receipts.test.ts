import type { StoredMessage } from "@craft-agent/shared/sessions";
import { piAgentForTest, type PiAgentTestView } from "./testing/private-runtime-access.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiAgent, TERMINAL_RECONCILIATION_CAPABILITY_FIELD } from "@craft-agent/shared/agent";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, bindToolAdmissionTurn, configureSpentDispatchBudget, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('persists the exact tool admission before mutation and never reclaims it after a pre-tool_start crash', async () => {
    const h = harness()
    configureSpentDispatchBudget(h); const managed = h.make('started-admission-crash')
    const allocatedAt = Date.now() - 3_000
    const startedAt = allocatedAt + 1_000
    const dispatchId = 'started-admission-crash-dispatch-2'
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 2,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      lastCause: 'objective_incomplete',
      validationGaps: ['missing structured objective outcome receipt'],
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

    const barrierFinished = deferred()
    let runtimeAgent!: PiAgent
    runtimeAgent = new PiAgent({
      provider: 'pi',
      workspace: managed.workspace,
      session: {
        id: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: 1,
        lastUsedAt: 1,
      },
      isHeadless: true,
      beforeToolExecution: async (request: {
        toolUseId?: string; toolName: string; toolInput: Record<string, unknown>
      }) => {
        await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, request)
        barrierFinished.resolve()
      },
    } as never)
    const backend = piAgentForTest(runtimeAgent)
    const runtimeContext = { runtimeId: 'started-admission-crash-runtime', sessionId: managed.id }
    const backendResponses: Array<Parameters<PiAgentTestView['send']>[0]> = []
    backend.subprocessRuntimeContext = runtimeContext
    backend.send = (message) => { backendResponses.push(message); return true }
    const generation = 7
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
    const capability = 'host-capability-must-never-persist'
    const exactInput = {
      file_path: '/fixture/production-target.json',
      old_string: '"enabled": false',
      new_string: '"enabled": true',
      [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: capability,
    }
    const safeInput = {
      file_path: exactInput.file_path,
      old_string: exactInput.old_string,
      new_string: exactInput.new_string,
    }
    backend.sendPreToolUseDecision({
      requestId: 'pretool-mutation-before-tool-start',
      toolName: 'Edit',
      toolCallId: 'mutation-before-tool-start',
      originalInput: exactInput,
      runtimeContext,
      authorizationEpoch: backend.promptPreparationRevision,
    }, {
      type: 'pre_tool_use_response',
      requestId: 'pretool-mutation-before-tool-start',
      action: 'allow',
    })
    expect(backendResponses).toEqual([])
    await barrierFinished.promise
    await tick()
    expect(backendResponses.at(-1)).toMatchObject({
      type: 'pre_tool_use_response',
      requestId: 'pretool-mutation-before-tool-start',
      action: 'allow',
    })
    expect(backend.beginAdmittedToolExecution({
      toolUseId: 'mutation-before-tool-start',
      toolName: 'Edit',
      toolInput: exactInput,
      sessionId: managed.id,
      runtimeId: runtimeContext.runtimeId,
      authorizationEpoch: backend.promptPreparationRevision,
    })).toBe(true)

    const persistedJsonl = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
    const persistedBeforeMutation = persistedJsonl.trim().split('\n').slice(1).map((line): StoredMessage => JSON.parse(line))
    const receipt = persistedBeforeMutation.find((message) => (
      message.toolUseId === 'mutation-before-tool-start'
    ))
    expect(receipt).toMatchObject({
      type: 'tool', toolName: 'Edit', toolStatus: 'executing', toolInput: safeInput,
    })
    expect(persistedJsonl).not.toContain(TERMINAL_RECONCILIATION_CAPABILITY_FIELD)
    expect(persistedJsonl).not.toContain(capability)
    expect(JSON.stringify(h.events)).not.toContain(TERMINAL_RECONCILIATION_CAPABILITY_FIELD)
    expect(JSON.stringify(h.events)).not.toContain(capability)
    expect(managed.messages.filter(message => message.toolUseId === 'mutation-before-tool-start')).toHaveLength(1)
    expect(h.events.filter(event => event.type === 'tool_start'
      && event.toolUseId === 'mutation-before-tool-start')).toHaveLength(1)

    // The external effect occurs only after the durable callback returned. No
    // ordinary tool_start/result is delivered before the simulated crash.
    writeFileSync(join(h.rootPath, 'external-mutation.txt'), 'mutated')
    runtimeAgent.destroy()
    managed.isProcessing = false
    managed.agent = null

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let scheduled = 0
    cold.runtime.processNextQueuedMessage = () => { scheduled++ }
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(readFileSync(join(h.rootPath, 'external-mutation.txt'), 'utf8')).toBe('mutated')
    expect(scheduled).toBe(0)
    expect(restored.messageQueue).toEqual([])
    expect(restored.messages.find((message) => (
      message.toolUseId === 'mutation-before-tool-start'
    ))).toMatchObject({
      role: 'tool', toolName: 'Edit', toolStatus: 'executing', toolInput: safeInput,
    })
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      exhaustedAt: expect.any(Number),
      recoveryDispatch: { id: dispatchId, attempt: 2, phase: 'started' },
    })
  })

  it('blocks a historical tool-use ID collision durably and never reclaims the current dispatch', async () => {
    const h = harness(); const managed = h.make('started-historical-tool-id-collision')
    configureSpentDispatchBudget(h)
    const allocatedAt = Date.now() - 3_000
    const startedAt = allocatedAt + 1_000
    const dispatchId = 'started-historical-collision-dispatch-2'
    const toolUseId = 'provider-reused-tool-id'
    const exactInput = { file_path: '/fixture/reused-target.json', new_string: 'second mutation' }
    managed.messages.push({
      id: 'historical-executing-receipt',
      role: 'tool',
      content: 'Running Edit...',
      timestamp: allocatedAt - 1_000,
      toolName: 'Edit',
      toolUseId,
      toolInput: structuredClone(exactInput),
      toolStatus: 'executing',
    })
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 2,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      lastCause: 'objective_incomplete',
      validationGaps: ['missing structured objective outcome receipt'],
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

    const barrierFinished = deferred()
    let runtimeAgent!: PiAgent
    runtimeAgent = new PiAgent({
      provider: 'pi',
      workspace: managed.workspace,
      session: {
        id: managed.id,
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: 1,
        lastUsedAt: 1,
      },
      isHeadless: true,
      beforeToolExecution: async (request: {
        toolUseId?: string; toolName: string; toolInput: Record<string, unknown>
      }) => {
        try {
          await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(managed, runtimeAgent, request)
        } finally {
          barrierFinished.resolve()
        }
      },
    } as never)
    const backend = piAgentForTest(runtimeAgent)
    const runtimeContext = { runtimeId: 'historical-collision-runtime', sessionId: managed.id }
    const backendResponses: Array<Parameters<PiAgentTestView['send']>[0]> = []
    backend.subprocessRuntimeContext = runtimeContext
    backend.send = (message) => { backendResponses.push(message); return true }
    const generation = 11
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

    // Pi may publish tool_execution_start before the wrapped execute reaches
    // PreToolUse. A reused historical ID must remain a collision even though
    // that live event temporarily owns the current generation.
    await h.runtime.processEvent(managed, {
      type: 'tool_start', toolUseId, toolName: 'Edit', input: exactInput,
    }, generation)

    backend.sendPreToolUseDecision({
      requestId: 'pretool-historical-collision',
      toolName: 'Edit',
      toolCallId: toolUseId,
      originalInput: exactInput,
      runtimeContext,
      authorizationEpoch: backend.promptPreparationRevision,
    }, {
      type: 'pre_tool_use_response',
      requestId: 'pretool-historical-collision',
      action: 'allow',
    })
    await barrierFinished.promise
    await tick()

    expect(backendResponses).toHaveLength(1)
    expect(backendResponses[0]).toMatchObject({
      type: 'pre_tool_use_response',
      requestId: 'pretool-historical-collision',
      action: 'block',
    })
    expect(backend.beginAdmittedToolExecution({
      toolUseId,
      toolName: 'Edit',
      toolInput: exactInput,
      sessionId: managed.id,
      runtimeId: runtimeContext.runtimeId,
      authorizationEpoch: backend.promptPreparationRevision,
    })).toBe(false)
    expect(managed.messages.filter(message => message.toolUseId === toolUseId)).toHaveLength(1)
    const collisionEvent = managed.autonomyEvents?.find(event => (
      event.message === 'Blocked a reused tool execution identity before execution.'
    ))
    expect(collisionEvent).toMatchObject({ phase: 'diagnosis', toolName: 'Edit' })
    expect(collisionEvent!.timestamp).toBeGreaterThanOrEqual(startedAt)
    const persistedJsonl = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
    expect(persistedJsonl).toContain(collisionEvent!.id)

    runtimeAgent.destroy()
    managed.isProcessing = false
    managed.agent = null
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    let scheduled = 0; let preparations = 0
    cold.runtime.processNextQueuedMessage = () => { scheduled++ }
    cold.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Collided dispatch must stay spent') }
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(scheduled).toBe(0)
    expect(preparations).toBe(0)
    expect(restored.messageQueue).toEqual([])
    expect(restored.messages.filter((message) => message.toolUseId === toolUseId)).toHaveLength(1)
    expect(restored.messages.some((message: { id: string }) => message.id === dispatchId)).toBe(true)
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      exhaustedAt: expect.any(Number),
      recoveryDispatch: { id: dispatchId, attempt: 2, phase: 'started' },
    })
  })
});
