import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearObjectiveEvidenceGate } from '@craft-agent/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager'
import { ToolLoopBudget } from '../../../pi-agent-server/src/tool-loop-budget'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function fixture() {
  const rootPath = mkdtempSync(join(tmpdir(), 'explicit-retry-allowance-'))
  const manager = new SessionManager()
  const runtime = manager as any
  const managed = createManagedSession({ id: 'retry-fixture', name: 'Retry fixture' },
    { id: 'retry-workspace', name: 'Retry', rootPath, createdAt: 1 } as never, { messagesLoaded: true })
  managed.messages = [
    { id: 'user', role: 'user', content: 'Continue the existing verification.', timestamp: 1 },
    { id: 'saved-write', role: 'tool', toolName: 'Write', toolUseId: 'already-written', toolInput: { path: '/fixture/result' },
      toolResult: 'Saved the requested result.', content: 'Saved result', toolStatus: 'completed', toolExecuted: true, timestamp: 2 },
    { id: 'old-failure', role: 'error', content: 'Automatic recovery ceiling reached.', timestamp: 3 },
  ]
  managed.activeObjective = {
    schemaVersion: 1, objectiveId: 'user', userMessageId: 'user', lastUserMessageId: 'user',
    originalText: managed.messages[0]!.content, startedAt: 1, budgetBaselineUsd: 2, tokenBaseline: 100,
    continuationCount: 4, orchestrationMode: 'direct', risk: 'standard',
    completionCriteria: ['requested-outcome-delivered'], terminalState: 'exhausted',
  }
  managed.pendingTurnRecovery = { userMessageId: 'user', startedAt: 1, attempts: 2,
    exhaustedAt: 3, validationExhausted: true, stagnantAttempts: 0, leaseExpiresAt: 10, lastCause: 'tool_checkpoint' }
  runtime.sessions.set(managed.id, managed)
  runtime.sendEvent = () => {}
  runtime.enqueuePersist = () => true
  runtime.flushSession = async () => {}
  runtime.startGenerationTelemetry = () => {}
  runtime.finishGenerationTelemetry = () => {}
  runtime.finishAllGenerationTelemetry = () => {}
  runtime.emitExecutionTelemetry = () => {}
  runtime.processNextQueuedMessage = () => {}
  runtime.disposeManagedAgentRuntime = async () => { managed.agent = null }
  let dispatch: Promise<void> | undefined
  const send = manager.sendMessage.bind(manager)
  manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
  cleanups.push(async () => {
    managed.messageQueue = []
    await manager.cleanup()
    clearObjectiveEvidenceGate(managed.id)
    rmSync(rootPath, { recursive: true, force: true })
  })
  return { manager, runtime, managed, done: () => dispatch! }
}

describe('explicit Retry prospective continuation', () => {
  it('continues the genuine checkpoint96 after a new read without replaying the prior write or resetting history', async () => {
    const h = fixture()
    const budget = new ToolLoopBudget()
    let checkpoint = budget.observe('Read', { path: '/fixture/0' })
    for (let i = 1; i < 96; i++) checkpoint = budget.observe('Read', { path: `/fixture/${i}` })
    expect(checkpoint.action).toBe('block')
    expect(checkpoint.message).toContain('tool call #96')
    h.runtime.getOrCreateAgent = async () => ({
      getModel: () => 'fixture', getSessionId: () => null, setAllSources: () => {}, isProcessing: () => false,
      async *chat() {
        yield { type: 'tool_start', toolName: 'Read', toolUseId: 'fresh-read', input: { path: '/fixture/result' } }
        yield { type: 'tool_result', toolName: 'Read', toolUseId: 'fresh-read', result: 'The saved result is present and its hash matches.', executed: true }
        yield { type: 'tool_start', toolName: 'Read', toolUseId: 'checkpoint96', input: { path: '/fixture/remaining' } }
        yield { type: 'tool_result', toolName: 'Read', toolUseId: 'checkpoint96', result: checkpoint.message,
          executed: false, continuationRequired: true,
          checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: checkpoint.message } }
        yield { type: 'complete' }
      },
    })
    const originalWrite = structuredClone(h.managed.messages[1])
    expect(await h.manager.retryTurn(h.managed.id, 'user')).toEqual({ status: 'started' })
    await h.done()
    expect(h.managed.messageQueue.map(item => item.options?.automaticRecovery?.cause)).toEqual(['tool_checkpoint'])
    expect(h.managed.pendingTurnRecovery?.attempts).toBe(3)
    expect(h.managed.pendingTurnRecovery?.exhaustedAt).toBe(3)
    expect(h.managed.pendingTurnRecovery?.leaseExpiresAt).toBe(10)
    expect(h.managed.messages.find(message => message.id === 'saved-write')).toEqual(originalWrite)
    expect(h.managed.messages.filter(message => message.toolName === 'Write')).toHaveLength(1)
    expect(h.managed.activeObjective?.budgetBaselineUsd).toBe(2)
    expect(h.managed.activeObjective?.tokenBaseline).toBe(100)
    expect(h.managed.activeObjective?.continuationCount).toBe(4)
    expect(h.managed.activeObjective?.terminalState).toBe('active')
    expect(h.managed.messages.find(message => message.toolUseId === 'checkpoint96')?.toolExecuted).toBe(false)
    const queued = h.managed.messageQueue.shift()!
    await h.manager.sendMessage(h.managed.id, queued.message, queued.attachments, queued.storedAttachments, queued.options, queued.messageId)
    // The second pass sees the same Read evidence, so it cannot keep spending
    // the new reserve merely by repeating the previous observation.
    expect(h.managed.pendingTurnRecovery?.attempts).toBe(3)
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(h.managed.messages.filter(message => message.toolName === 'Write')).toHaveLength(1)
    expect(h.managed.messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(1)
  })
})
