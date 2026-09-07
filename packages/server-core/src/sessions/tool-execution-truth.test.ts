import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { AgentEvent, Message } from '@craft-agent/core/types'
import {
  beginObjectiveEvidenceGate,
  clearObjectiveEvidenceGate,
  getObjectiveEvidenceCompletionGap,
} from '@craft-agent/shared/agent'
import type { RobbExecutionTelemetryEvent } from '@craft-agent/shared/telemetry'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('tool execution truth', () => {
  let manager: SessionManager
  let sentEvents: unknown[]
  let telemetry: RobbExecutionTelemetryEvent[]

  beforeEach(() => {
    manager = new SessionManager()
    sentEvents = []
    telemetry = []
    ;(manager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(manager as unknown as { sendEvent: (event: unknown) => void }).sendEvent = event => {
      sentEvents.push(event)
    }
    ;(manager as unknown as {
      emitExecutionTelemetry: (_managed: unknown, event: RobbExecutionTelemetryEvent) => void
    }).emitExecutionTelemetry = (_managed, event) => {
      telemetry.push(event)
    }
  })

  afterEach(() => clearObjectiveEvidenceGate('checkpoint-session'))

  it('persists a pre-execution checkpoint without recording success or failure', async () => {
    const managed = createManagedSession({
      id: 'checkpoint-session',
      name: 'Checkpoint session',
    }, {
      id: 'checkpoint-workspace',
      name: 'Checkpoint workspace',
      rootPath: '/tmp/tool-execution-truth-test',
      createdAt: Date.now(),
    } as never, { messagesLoaded: true })
    managed.pendingTurnRecovery = {
      userMessageId: 'user-1',
      startedAt: Date.now(),
      attempts: 0,
    }
    managed.messages.push({
      id: 'user-1',
      role: 'user',
      content: 'Apply the change.',
      timestamp: 1,
    }, {
      id: 'tool-1',
      role: 'tool',
      content: 'Running web_fetch...',
      timestamp: 2,
      toolName: 'web_fetch',
      toolUseId: 'fetch-1',
      toolStatus: 'executing',
    })
    beginObjectiveEvidenceGate(
      managed.id,
      'user-1',
      'Corrige ce contrat juridique après vérification des sources.',
    )
    const checkpoint = {
      schemaVersion: 1 as const,
      kind: 'tool-call-budget' as const,
      reason: 'Error: https://legifrance.gouv.fr was not fetched before the safety lease expired.',
    }
    const event: AgentEvent = {
      type: 'tool_result',
      toolUseId: 'fetch-1',
      toolName: 'web_fetch',
      result: checkpoint.reason,
      isError: false,
      executed: false,
      checkpoint,
      continuationRequired: true,
    }

    await (manager as unknown as {
      processEvent: (session: unknown, agentEvent: AgentEvent) => Promise<void>
    }).processEvent(managed, event)

    const storedTool = managed.messages.find(message => message.toolUseId === 'fetch-1') as Message
    expect(storedTool).toMatchObject({
      toolStatus: 'completed',
      isError: false,
      toolExecuted: false,
      toolCheckpoint: checkpoint,
    })
    expect(managed.pendingTurnRecovery?.continuationRequired).toBe(true)
    expect(getObjectiveEvidenceCompletionGap(managed.id)).toContain('has not been inspected')
    expect(managed.autonomyEvents?.some(item => item.phase === 'verified') ?? false).toBe(false)
    expect(telemetry.some(item => item.name === 'tool.completed' || item.name === 'tool.failed')).toBe(false)
    expect(sentEvents).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      toolUseId: 'fetch-1',
      isError: false,
      executed: false,
      checkpoint,
    }))
  })
})
