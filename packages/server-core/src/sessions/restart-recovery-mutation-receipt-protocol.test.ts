import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { TERMINAL_RECONCILIATION_CAPABILITY_FIELD } from "@craft-agent/shared/agent";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, bindToolAdmissionTurn, configureSpentDispatchBudget, harness, prepareStartedRecoveryAdmission } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  for (const legacyContract of [true, false]) {
    it(legacyContract
      ? 'blocks every mutation after an unresolved restart effect in the strict legacy contract'
      : 'continues native recovery after a read without a global legacy mutation quarantine', async () => {
      if (legacyContract) process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
      else delete process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"]
      const h = harness(); const managed = h.make('ambiguous-effect-exactly-once')
      const allocatedAt = Date.now() - 3_000
      const startedAt = allocatedAt + 1_000
      const dispatchId = 'ambiguous-effect-dispatch-2'
      const attemptOneInput = {
        file_path: '/fixture/production-target.json',
        new_string: 'possibly applied',
        _displayName: 'Attempt one',
        [TERMINAL_RECONCILIATION_CAPABILITY_FIELD]: 'stale-attempt-one-capability',
      }
      managed.messages.push({
        id: 'attempt-1-receipt',
        role: 'tool',
        content: 'Running Edit...',
        timestamp: allocatedAt - 1_000,
        toolName: 'Edit',
        toolUseId: 'attempt-1-id-a',
        toolInput: attemptOneInput,
        toolStatus: 'executing',
      })
      managed.messages.push({
        id: 'same-objective-amendment',
        role: 'user',
        content: 'Keep the same objective, but report the reconciled result concisely.',
        timestamp: allocatedAt - 500,
      })
      managed.activeObjective = {
        ...managed.activeObjective!,
        lastUserMessageId: 'same-objective-amendment',
        amendments: [{
          messageId: 'same-objective-amendment',
          text: 'Keep the same objective, but report the reconciled result concisely.',
          timestamp: allocatedAt - 500,
        }],
      }
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        userMessageId: 'same-objective-amendment',
        attempts: 2,
        stagnantAttempts: 0,
        leaseExpiresAt: Date.now() + 60_000,
        lastCause: 'objective_incomplete',
        validationGaps: ['reconcile the ambiguous prior tool effect'],
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

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      await cold.runtime.ensureMessagesLoaded(restored)
      cold.runtime.emitExecutionTelemetry = () => {}
      const runtimeAgent = {} as never
      const generation = 12
      restored.agent = runtimeAgent
      restored.isProcessing = true
      restored.processingGeneration = generation
      restored.lastSentOptions = {
        hidden: true,
        automaticRecovery: {
          originalUserMessageId: requiredTestValue(restored.pendingTurnRecovery).userMessageId,
          cause: 'objective_incomplete',
          dispatchId,
          dispatchAttempt: 2,
          dispatchOrigin: 'automatic',
          dispatchAllocatedAt: allocatedAt,
        },
      }
      bindToolAdmissionTurn(cold.runtime, restored, runtimeAgent, generation)

      if (!legacyContract) {
        await cold.runtime.durablyRecordAutomaticRecoveryToolAdmission(restored, runtimeAgent, {
          toolUseId: 'native-reconciliation-read', toolName: 'Read',
          toolInput: { file_path: '/fixture/production-target.json' },
        })
        await cold.runtime.durablyRecordAutomaticRecoveryToolAdmission(restored, runtimeAgent, {
          toolUseId: 'native-continuation-write', toolName: 'Write',
          toolInput: { file_path: '/fixture/continuation.json', content: '{"verified":true}' },
        })
        expect(restored.messages.find((message) => message.toolUseId === 'native-continuation-write'))
          .toMatchObject({ toolName: 'Write', toolStatus: 'executing' })
        expect(readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8'))
          .toContain('native-continuation-write')
        restored.agent = null
        restored.isProcessing = false
        return
      }

      await expect(cold.runtime.durablyRecordAutomaticRecoveryToolAdmission(
        restored,
        runtimeAgent,
        {
          toolUseId: 'attempt-2-id-b',
          toolName: 'Write',
          toolInput: {
            file_path: attemptOneInput.file_path,
            new_string: attemptOneInput.new_string,
            _intent: 'Retry the same operation under a new provider ID.',
          },
        },
      )).rejects.toThrow('Automatic recovery exactly-once fence')

      await expect(cold.runtime.durablyRecordAutomaticRecoveryToolAdmission(
        restored,
        runtimeAgent,
        {
          toolUseId: 'attempt-2-disjoint-mutation',
          toolName: 'Bash',
          toolInput: { file_path: attemptOneInput.file_path, new_string: 'different operation' },
        },
      )).rejects.toThrow('no new mutation')
      expect(restored.messages.some((message) => (
        message.toolUseId === 'attempt-2-disjoint-mutation'
      ))).toBe(false)
      expect(restored.messages.some((message) => message.toolUseId === 'attempt-2-id-b')).toBe(false)

      await cold.runtime.durablyRecordAutomaticRecoveryToolAdmission(
        restored,
        runtimeAgent,
        {
          toolUseId: 'attempt-2-reconciliation-read',
          toolName: 'Read',
          toolInput: { file_path: '/fixture/production-target.json' },
        },
      )
      expect(restored.messages.find((message) => (
        message.toolUseId === 'attempt-2-reconciliation-read'
      ))).toMatchObject({
        role: 'tool',
        toolName: 'Read',
        toolStatus: 'executing',
        toolInput: { file_path: '/fixture/production-target.json' },
      })
      const persisted = readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8')
      expect(persisted).toContain('attempt-1-id-a')
      expect(persisted).not.toContain('attempt-2-disjoint-mutation')
      expect(persisted).toContain('attempt-2-reconciliation-read')
      expect(persisted).not.toContain('attempt-2-id-b')
      restored.agent = null
      restored.isProcessing = false
    })
  }

  it.each([
    ['download', '❌ Download error: ENOENT: no such file or directory', false],
    ['upload', '❌ Upload error: remote write failed', false],
    ['typed-error', 'transport returned a structured failure', true],
  ] as const)(
    'does not treat a completed %s error receipt as proof that its mutation succeeded',
    async (label, toolResult, isError) => {
      const h = harness()
      const { managed, runtimeAgent, dispatchId } = await prepareStartedRecoveryAdmission(
        h,
        `failed-completed-${label}`,
        14,
      )
      const input = { command: `touch /fixture/retry-${label}` }
      const dispatchIndex = managed.messages.findIndex(message => message.id === dispatchId)
      managed.messages.splice(dispatchIndex, 0, {
        id: `failed-completed-${label}-receipt`,
        role: 'tool', content: `Running failed ${label}...`, timestamp: Date.now() - 10_000,
        toolName: 'Bash', toolUseId: `failed-completed-${label}-a`, toolInput: input,
        toolStatus: 'completed', toolExecuted: true, toolResult, isError,
      })
      await h.save(managed)

      await expect(h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
        managed,
        runtimeAgent,
        {
          toolUseId: `failed-completed-${label}-b`,
          toolName: 'Bash',
          toolInput: input,
        },
      )).resolves.toBeUndefined()
      expect(managed.messages.find(message => (
        message.toolUseId === `failed-completed-${label}-b`
      ))).toMatchObject({ toolStatus: 'executing', toolInput: input })
      managed.agent = null
      managed.isProcessing = false
    },
  )

  it.each([
    ['prior-builtin-read', 'Read', { file_path: '/fixture/production-target.json' }, 'Edit', { file_path: '/fixture/production-target.json', new_string: 'validated mutation' }, true],
    ['prior-read', 'Bash', { command: 'pwd' }, 'Bash', { command: 'touch /fixture/new-target' }, true],
    ['prior-unknown-exact', 'OpaqueRuntimeAction', { target: 'same' }, 'OpaqueRuntimeAction', { target: 'same' }, false],
    ['prior-unknown-opaque', 'OpaqueRuntimeAction', undefined, 'OpaqueRuntimeAction', { target: 'unprovable' }, false],
  ] as const)(
    'classifies %s before admitting a later operation',
    async (label, priorToolName, priorToolInput, nextToolName, nextToolInput, operationAdmitted) => {
      process.env["ROBB_LEGACY_HOST_OBJECTIVE_CONTRACT"] = '1'
      const h = harness(); const managed = h.make(`${label}-effect`)
      const allocatedAt = Date.now() - 3_000
      const startedAt = allocatedAt + 1_000
      const dispatchId = `${label}-dispatch-2`
      managed.messages.push({
        id: `${label}-receipt`,
        role: 'tool',
        content: `Running ${priorToolName}...`,
        timestamp: allocatedAt - 1_000,
        toolName: priorToolName,
        toolUseId: `${label}-id-a`,
        ...(priorToolInput === undefined ? {} : { toolInput: structuredClone(priorToolInput) }),
        toolStatus: 'executing',
      })
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        attempts: 2,
        stagnantAttempts: 0,
        leaseExpiresAt: Date.now() + 60_000,
        lastCause: 'objective_incomplete',
        validationGaps: ['reconcile the prior tool receipt'],
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

      const runtimeAgent = {} as never
      const generation = 13
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
      const admission = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
        managed,
        runtimeAgent,
        {
          toolUseId: `${label}-id-b`,
          toolName: nextToolName,
          toolInput: structuredClone(nextToolInput),
        },
      )
      if (operationAdmitted) {
        expect(await admission).toBeUndefined()
        expect(managed.messages.find(message => (
          message.toolUseId === `${label}-id-b`
        ))).toMatchObject({ toolName: nextToolName, toolStatus: 'executing' })
      } else {
        await expect(admission).rejects.toThrow('Automatic recovery exactly-once fence')
        expect(managed.messages.some(message => (
          message.toolUseId === `${label}-id-b`
        ))).toBe(false)
      }
      managed.agent = null
      managed.isProcessing = false
    },
  )

  it.each(['assistant', 'tool', 'event'] as const)(
    'does not reclaim a started dispatch after persisted %s activity', async activity => {
      const h = harness(); const managed = h.make(`started-after-${activity}`)
      configureSpentDispatchBudget(h)
      const allocatedAt = Date.now() - 3_000
      const startedAt = allocatedAt + 1_000
      const promptTimestamp = allocatedAt + 2_000
      managed.pendingTurnRecovery = {
        ...managed.pendingTurnRecovery!,
        attempts: 2,
        stagnantAttempts: 0,
        leaseExpiresAt: Date.now() + 60_000,
        lastCause: 'objective_incomplete',
        validationGaps: ['missing structured objective outcome receipt'],
        recoveryDispatch: {
          schemaVersion: 1,
          id: `started-after-${activity}-dispatch-2`,
          attempt: 2,
          cause: 'objective_incomplete',
          origin: 'automatic',
          allocatedAt,
          phase: 'started',
          startedAt,
          preToolExecutionReceiptVersion: 1,
        },
      }
      const prompt = buildAutomaticTurnRecoveryPrompt(
        managed.pendingTurnRecovery,
        'objective_incomplete',
        undefined,
        2,
        managed.activeObjective,
      )
      managed.messages.push({
        id: `started-after-${activity}-dispatch-2`, role: 'user', content: prompt,
        timestamp: promptTimestamp, hidden: true,
      })
      if (activity === 'assistant') {
        managed.messages.push({
          id: 'post-recovery-assistant', role: 'assistant', content: 'Work is still running.',
          timestamp: startedAt + 1, isIntermediate: true,
        })
      } else if (activity === 'tool') {
        managed.messages.push({
          id: 'post-recovery-tool', role: 'tool', content: '', timestamp: startedAt + 1,
          toolName: 'Edit', toolUseId: 'post-recovery-edit', toolStatus: 'completed',
          toolExecuted: true, toolResult: 'Mutation receipt.',
        })
      } else {
        managed.autonomyEvents = [{
          id: 'post-recovery-event', timestamp: startedAt + 1, phase: 'attempt',
          message: 'Attempting a post-recovery operation.', toolName: 'Edit',
        }]
      }
      await h.save(managed)

      const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
      let scheduled = 0
      cold.runtime.processNextQueuedMessage = () => { scheduled++ }
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)

      expect(scheduled).toBe(0)
      expect(restored.messageQueue).toEqual([])
      expect<unknown>(restored.pendingTurnRecovery).toMatchObject({
        attempts: 2,
        exhaustedAt: (expect.any(Number) as unknown),
        recoveryDispatch: {
          id: `started-after-${activity}-dispatch-2`, attempt: 2, phase: 'started',
        },
      })
      expect(restored.messages.some((message) => (
        message.id === `started-after-${activity}-dispatch-2`
      ))).toBe(true)
      expect(restored.activeObjective?.terminalState).toBe('exhausted')
    },
  )
});
