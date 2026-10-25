import type { StoredMessage } from "@craft-agent/shared/sessions";
import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { sessionRuntimeStateForTest, requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionFilePath } from "@craft-agent/shared/sessions/storage";
import { buildAutomaticTurnRecoveryPrompt } from "./turn-recovery";
import { cleanupRestartRecovery, type Managed, bindToolAdmissionTurn, configureSpentDispatchBudget, deferred, harness, tick } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('durable restart recovery', () => {
  it('rebuilds an allocated specialized fallback with the same identity and persists started before model preparation', async () => {
    const h = harness(); const managed = h.make('allocated-restart-dispatch')
    writeFileSync(join(h.rootPath, 'config.json'), JSON.stringify({
      schemaVersion: 1, id: h.workspace.id, name: h.workspace.name,
      slug: 'allocated-restart-dispatch', createdAt: 1, updatedAt: 1,
      automaticRoutingEnabled: true,
      automaticToolFallbackEnabled: true,
    }))
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 3,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      lastCause: 'runtime_error',
      recoveryDispatch: {
        schemaVersion: 1,
        id: 'restart-dispatch-4',
        attempt: 4,
        cause: 'runtime_error',
        origin: 'automatic',
        allocatedAt: Date.now() - 1_000,
        phase: 'allocated',
        fallbackIntent: {
          kind: 'structured_fallback',
          failedToolName: 'mcp__session__browser_tool',
        },
      },
    }
    await h.save(managed)
    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const preparing = deferred(); const release = deferred()
    let preparations = 0; let persistedAtPreparation: Managed['pendingTurnRecovery']; let sentPrompt = ''; let dispatch: Promise<void> | undefined
    cold.runtime.getOrCreateAgent = async () => {
      preparations++
      persistedAtPreparation = JSON.parse(
        readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!,
      ).pendingTurnRecovery
      preparing.resolve(); await release.promise
      throw new Error('Synthetic provider preparation boundary')
    }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => {
      sentPrompt = args[1]
      dispatch = send(...args)
      return dispatch
    }

    try {
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      await preparing.promise
      expect(preparations).toBe(1)
      expect(sentPrompt).toContain('attempt="4"')
      expect(sentPrompt).toContain('<automatic_structured_fallback failed_tool="mcp__session__browser_tool">')
      expect(requiredTestValue(restored.pendingTurnRecovery).attempts).toBe(3)
      expect(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).toMatchObject({
        id: 'restart-dispatch-4', attempt: 4, cause: 'runtime_error', origin: 'automatic', phase: 'started',
        fallbackIntent: { kind: 'structured_fallback', failedToolName: 'mcp__session__browser_tool' },
        startedAt: expect.any(Number),
      })
      expect(requiredTestValue(persistedAtPreparation).recoveryDispatch).toEqual(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch)
      expect(restored.messages.filter((message) => message.hidden
        && message.content.includes('attempt="4"'))).toHaveLength(1)
      const persistedRows = readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8')
        .trim().split('\n').slice(1).map((line): StoredMessage => JSON.parse(line))
      expect(persistedRows.filter((message) => message.type === 'user' && message.hidden
        && message.content.includes('attempt="4"'))).toHaveLength(1)
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      expect(preparations).toBe(1)
      expect(requiredTestValue(restored.pendingTurnRecovery).attempts).toBe(3)
    } finally {
      release.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('reclaims the final-budget started dispatch when its durable prompt has no later activity', async () => {
    const h = harness(); const managed = h.make('started-no-output-final-budget')
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
        id: 'started-no-output-dispatch-2',
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
      id: 'started-no-output-dispatch-2', role: 'user', content: prompt,
      timestamp: promptTimestamp, hidden: true,
    })
    await h.save(managed)

    const cold = h.cold(); const restored = requiredTestValue(sessionRuntimeStateForTest(cold.runtime).sessions.get(managed.id))
    const preparing = deferred(); const release = deferred()
    let preparations = 0; let persistedAtPreparation: Managed['pendingTurnRecovery']; let sentPrompt = ''; let dispatch: Promise<void> | undefined
    cold.runtime.getOrCreateAgent = async () => {
      preparations++
      persistedAtPreparation = JSON.parse(
        readFileSync(getSessionFilePath(h.rootPath, restored.id), 'utf8').split('\n')[0]!,
      ).pendingTurnRecovery
      preparing.resolve(); await release.promise
      throw new Error('Synthetic reclaimed provider boundary')
    }
    const send = cold.manager.sendMessage.bind(cold.manager)
    cold.manager.sendMessage = (...args) => {
      sentPrompt = args[1]
      dispatch = send(...args)
      return dispatch
    }

    try {
      await cold.runtime.resumePendingTurnAfterRestart(restored.id)
      await preparing.promise
      expect(preparations).toBe(1)
      expect(sentPrompt).toContain('attempt="2"')
      expect(restored.pendingTurnRecovery).toMatchObject({
        attempts: 2,
        recoveryDispatch: {
          id: 'started-no-output-dispatch-2',
          attempt: 2,
          cause: 'objective_incomplete',
          origin: 'automatic',
          phase: 'started',
          startedAt: expect.any(Number),
        },
      })
      expect(requiredTestValue(restored.pendingTurnRecovery).exhaustedAt).toBeUndefined()
      expect(restored.messages.filter((message) => (
        message.id === 'started-no-output-dispatch-2'
        && message.role === 'user' && message.hidden
      ))).toHaveLength(1)
      expect(persistedAtPreparation).toMatchObject({
        attempts: 2,
        recoveryDispatch: {
          id: 'started-no-output-dispatch-2', attempt: 2, phase: 'started',
        },
      })
    } finally {
      release.resolve()
      await dispatch?.catch(() => {})
    }
  })

  it('never reclaims a historical started dispatch without the pre-tool receipt protocol', async () => {
    const h = harness(); const managed = h.make('legacy-started-no-receipt-protocol')
    configureSpentDispatchBudget(h)
    const allocatedAt = Date.now() - 3_000
    const startedAt = allocatedAt + 1_000
    const dispatchId = 'legacy-started-no-receipt-dispatch-2'
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
        // Deliberately no preToolExecutionReceiptVersion: this is a dispatch
        // persisted by a host predating the durable PreToolUse barrier.
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
    let scheduled = 0; let preparations = 0
    cold.runtime.processNextQueuedMessage = () => { scheduled++ }
    cold.runtime.getOrCreateAgent = async () => { preparations++; throw new Error('Historical dispatch must stay spent') }
    await cold.runtime.resumePendingTurnAfterRestart(restored.id)

    expect(scheduled).toBe(0)
    expect(preparations).toBe(0)
    expect(restored.messageQueue).toEqual([])
    expect(restored.messages.some((message: { id: string }) => message.id === dispatchId)).toBe(true)
    expect(restored.pendingTurnRecovery).toMatchObject({
      attempts: 2,
      exhaustedAt: expect.any(Number),
      recoveryDispatch: { id: dispatchId, attempt: 2, phase: 'started' },
    })
    expect(requiredTestValue(requiredTestValue(restored.pendingTurnRecovery).recoveryDispatch).preToolExecutionReceiptVersion).toBeUndefined()
    expect(restored.activeObjective?.terminalState).toBe('exhausted')
  })

  it.each(['Pi', 'Claude'] as const)(
    'atomically rebinds %s tool admission after an accepted live steer', async provider => {
      const h = harness(); const managed = h.make(`steer-admission-${provider.toLowerCase()}`)
      await h.save(managed)
      const initialText = managed.messages[0]!.content
      const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
        redirect: () => true,
        getCurrentTurnUserMessage: () => initialText,
        isProcessing: () => true,
      })
      managed.agent = runtimeAgent
      managed.isProcessing = true
      managed.processingGeneration = 9
      bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, 9)

      const entered = deferred(); const release = deferred()
      const originalFlush = h.runtime.flushSession.bind(h.manager)
      let held = false
      h.runtime.flushSession = async (sessionId: string) => {
        await originalFlush(sessionId)
        if (!held && managed.messages.some(message => (
          message.role === 'user' && message.content === `Steered ${provider} objective.`
        ))) {
          held = true
          entered.resolve()
          await release.promise
        }
      }

      const steering = h.manager.sendMessage(managed.id, `Steered ${provider} objective.`)
      await entered.promise
      let admissionSettled = false
      const admission = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
        managed,
        runtimeAgent,
        {
          toolUseId: `${provider.toLowerCase()}-post-steer-read`,
          toolName: 'Read',
          toolInput: { file_path: `/fixture/${provider.toLowerCase()}-post-steer.txt` },
        },
      ).finally(() => { admissionSettled = true })
      await tick()
      expect(admissionSettled).toBe(false)

      release.resolve()
      await steering
      await admission
      const steered = managed.messages.findLast(message => message.role === 'user')!
      expect(managed.activeObjective).toMatchObject({
        userMessageId: `${managed.id}-user`,
        objectiveId: `${managed.id}-user`,
        lastUserMessageId: steered.id,
        terminalState: 'active',
      })
      expect(managed.messages.find(message => (
        message.toolUseId === `${provider.toLowerCase()}-post-steer-read`
      ))).toMatchObject({
        role: 'tool',
        toolStatus: 'executing',
        toolInput: { file_path: `/fixture/${provider.toLowerCase()}-post-steer.txt` },
      })
      const stored = readFileSync(getSessionFilePath(h.rootPath, managed.id), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line))
      const steeredIndex = stored.findIndex(message => message.id === steered.id)
      const receiptIndex = stored.findIndex(message => (
        message.toolUseId === `${provider.toLowerCase()}-post-steer-read`
      ))
      expect(receiptIndex).toBeGreaterThan(steeredIndex)
    },
  )
});
