import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionFilePath } from '@craft-agent/shared/sessions/storage'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import * as recovery from './turn-recovery.ts'

const managers: SessionManager[] = []
const directories: string[] = []
const releases: Array<() => void> = []
const spies: Array<{ mockRestore(): void }> = []
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

// Exercise the real Retry -> sendMessage -> watchdog -> persistence path. Only
// the provider boundary and watchdog duration are replaced; no tool executes.
function harness() {
  const rootPath = mkdtempSync(join(tmpdir(), 'runtime-error-receipts-'))
  directories.push(rootPath)
  const workspace = { id: 'isolated-watchdog', slug: 'isolated-watchdog', rootPath, name: 'Watchdog fixture', createdAt: 1 }
  const manager = new SessionManager()
  managers.push(manager)
  const runtime = manager as any
  const started = deferred()
  const stall = deferred()
  releases.push(stall.resolve)
  runtime.sendEvent = (event: any) => {
    if (event.type === 'tool_start' && event.toolUseId === 'uncertain-call') started.resolve()
  }
  runtime.startGenerationTelemetry = () => {}
  runtime.finishGenerationTelemetry = () => {}
  runtime.finishAllGenerationTelemetry = () => {}
  runtime.emitExecutionTelemetry = () => {}
  const session = createManagedSession(
    { id: 'watchdog-fixture', name: 'Watchdog fixture' }, workspace, { messagesLoaded: true },
  )
  session.messages = [
    { id: 'root-user', role: 'user', content: 'Continue the existing authorized local work.', timestamp: 1 },
    { id: 'old-final', role: 'assistant', content: 'An earlier partial result is preserved.', timestamp: 2, isIntermediate: false },
  ]
  session.lastFinalMessageId = 'old-final'
  session.activeObjective = {
    schemaVersion: 1, objectiveId: 'root-user', userMessageId: 'root-user', lastUserMessageId: 'root-user',
    originalText: session.messages[0]!.content, startedAt: 1, budgetBaselineUsd: 7, tokenBaseline: 1000,
    continuationCount: 3, orchestrationMode: 'direct', risk: 'standard',
    completionCriteria: ['requested-outcome-delivered'], terminalState: 'exhausted',
  }
  session.tokenUsage = {
    costUsd: 9, totalTokens: 2000, inputTokens: 1600, outputTokens: 400, contextTokens: 1800,
  }
  session.pendingTurnRecovery = {
    ...recovery.createPendingTurnRecovery('root-user', 10), attempts: 0,
    budgetHistoryUnavailable: true, exhaustedAt: 11,
  }
  runtime.sessions.set(session.id, session)
  let chats = 0
  let dispatch: Promise<void> | undefined
  const agent = {
    getModel: () => 'fixture-model', getSessionId: () => null, setAllSources: () => {},
    isProcessing: () => false, forceAbort: () => {}, dispose: () => {},
    async *chat() {
      chats++
      yield { type: 'tool_start', toolName: 'Bash', toolUseId: 'uncertain-call', input: { command: 'fixture-observation-only' } }
      await stall.promise
    },
  }
  runtime.getOrCreateAgent = async () => { session.agent = agent as never; return agent }
  const send = manager.sendMessage.bind(manager)
  manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
  const start = async () => {
    const result = await manager.retryTurn(session.id, 'root-user')
    await started.promise
    return result
  }
  return { manager, runtime, session, rootPath, start, getDispatch: () => dispatch!, chatCount: () => chats }
}

afterEach(async () => {
  spies.splice(0).forEach(spy => spy.mockRestore())
  // The shutdown contract drains every already-admitted session operation.
  // Release the fixture's deliberately suspended provider boundaries before
  // asking cleanup to prove that drain; the fake runtime's forceAbort is a
  // no-op and therefore cannot release them on cleanup's behalf.
  releases.splice(0).forEach(release => release())
  for (const manager of managers.splice(0)) await manager.cleanup()
  await tick()
  directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }))
})

describe('durable runtime errors and unknown tool receipts', () => {
  it('persists a fresh error without inventing an execution result when the watchdog cannot recover', async () => {
    spies.push(spyOn(recovery, 'resolveAutomaticRecoveryInactivityTimeoutMs').mockReturnValue(30))
    const h = harness()
    expect(await h.start()).toEqual({ status: 'started' })
    await h.getDispatch()
    const errors = h.session.messages.filter(message => message.role === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.timestamp).toBeGreaterThan(2)
    expect(errors[0]!.content).toContain('operation result is unknown')
    expect(errors[0]!.content).toContain('no recoverable budget history')
    const tool = h.session.messages.find(message => message.toolUseId === 'uncertain-call')!
    expect(tool.toolStatus).toBe('error')
    expect(tool.toolExecuted).toBeUndefined()
    expect(tool.toolResult).toBeUndefined()
    expect(h.session.pendingTurnRecovery).toMatchObject({ userMessageId: 'root-user', attempts: 0, budgetHistoryUnavailable: true })
    expect(h.session.activeObjective).toMatchObject({ budgetBaselineUsd: 7, tokenBaseline: 1000, continuationCount: 3, terminalState: 'exhausted' })
    expect(h.chatCount()).toBe(1)
    await h.manager.flushSession(h.session.id)
    const persisted = readFileSync(getSessionFilePath(h.rootPath, h.session.id), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    expect(persisted.slice(1).filter(message => (message.role ?? message.type) === 'error')).toHaveLength(1)
    const stored = persisted.slice(1).find(message => message.toolUseId === 'uncertain-call')
    expect(stored.toolExecuted).toBeUndefined()
    expect(stored.toolResult).toBeUndefined()
    expect(h.session.messages.filter(message => message.role === 'assistant').map(message => message.id)).toEqual(['old-final'])
    expect(h.session.messages.filter(message => message.role === 'user').map(message => message.id)).toEqual(['root-user'])
  })

  it('keeps a real late tool receipt authoritative instead of replacing it with a synthetic failure', async () => {
    spies.push(spyOn(recovery, 'resolveAutomaticRecoveryInactivityTimeoutMs').mockReturnValue(30))
    const h = harness()
    await h.start()
    await h.getDispatch()
    const tool = h.session.messages.find(message => message.toolUseId === 'uncertain-call')!
    expect(tool.toolExecuted).toBeUndefined()
    expect(tool.toolResult).toBeUndefined()
    await h.runtime.processEvent(h.session, {
      type: 'tool_result', toolUseId: 'uncertain-call', toolName: 'Bash',
      result: 'Original observed receipt.', executed: true, isError: false,
    }, h.session.processingGeneration)
    expect(tool.toolResult).toBe('Original observed receipt.')
    expect(tool.toolExecuted).toBe(true)
    expect(tool.toolStatus).toBe('completed')
  })

  it('does not publish a watchdog error after explicit Stop', async () => {
    spies.push(spyOn(recovery, 'resolveAutomaticRecoveryInactivityTimeoutMs').mockReturnValue(80))
    const h = harness()
    await h.start()
    const old = h.getDispatch()
    await h.manager.cancelProcessing(h.session.id)
    await h.runtime.onProcessingStopped(h.session.id, 'interrupted', h.session.processingGeneration)
    const afterStop = h.session.messages.filter(message => message.role === 'error').length
    await old
    expect(h.session.messages.filter(message => message.role === 'error')).toHaveLength(afterStop)
    expect(h.session.messageQueue).toEqual([])
    expect(h.session.isProcessing).toBe(false)
    expect(h.chatCount()).toBe(1)
  })

  it('cannot attach an old watchdog failure to a newer accepted human objective', async () => {
    spies.push(spyOn(recovery, 'resolveAutomaticRecoveryInactivityTimeoutMs').mockReturnValue(80))
    const h = harness()
    await h.start()
    const old = h.getDispatch()
    await h.manager.cancelProcessing(h.session.id)
    await h.runtime.onProcessingStopped(h.session.id, 'interrupted', h.session.processingGeneration)
    const next = deferred()
    const nextBoundary = deferred()
    releases.push(nextBoundary.resolve)
    h.runtime.getOrCreateAgent = async () => {
      next.resolve()
      await nextBoundary.promise
      throw new Error('Newer isolated provider boundary')
    }
    void h.manager.sendMessage(h.session.id, 'New objective: Explain this second isolated fixture.')
    await next.promise
    const objective = structuredClone(h.session.activeObjective)
    const errors = h.session.messages.filter(message => message.role === 'error').length
    await old
    expect(h.session.activeObjective).toEqual(objective)
    expect(h.session.activeObjective!.terminalState).toBe('active')
    expect(h.session.messages.filter(message => message.role === 'error')).toHaveLength(errors)
  })
})
