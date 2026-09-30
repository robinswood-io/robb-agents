import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearObjectiveEvidenceGate } from '@craft-agent/shared/agent'
import { USER_INPUT_ANSWER_MESSAGE_PREFIX } from '@craft-agent/core'
import * as backend from '@craft-agent/shared/agent/backend'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer, RequestContext } from '../transport'
import { registerSessionsHandlers } from '../handlers/rpc/sessions'
import { getDefaultStatusConfig, saveStatusConfig } from '@craft-agent/shared/statuses'
import { createManagedSession, SessionManager, setSessionPlatform } from './SessionManager'

type Managed = ReturnType<typeof createManagedSession>
const roots: string[] = []
const ids: string[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function harness() {
  const rootPath = mkdtempSync(join(tmpdir(), 'retry-turn-'))
  roots.push(rootPath)
  const statuses = getDefaultStatusConfig()
  statuses.statuses.push(
    { id: 'in-progress', label: 'En cours', category: 'open', isFixed: false, isDefault: false, order: 10 },
    { id: 'blocked', label: 'Bloqué', category: 'open', isFixed: false, isDefault: false, order: 11 },
  )
  saveStatusConfig(rootPath, statuses)
  const id = `retry-${roots.length}`
  ids.push(id)
  const managed = createManagedSession({ id, name: 'Retry test', sessionStatus: 'done' }, {
    id: `ws-${id}`, rootPath, name: 'Retry test', createdAt: 1,
  } as never, { messagesLoaded: true })
  managed.messages = [
    { id: 'root-user', role: 'user', content: 'Correct the deliverable and verify its state.', timestamp: 1 },
    { id: 'evidence', role: 'tool', content: 'Already saved.', toolName: 'Write', toolUseId: 'write-1', toolStatus: 'completed', timestamp: 2 },
    { id: 'latest-user', role: 'user', content: 'Keep the existing destination and finish the verification.', timestamp: 3 },
    { id: 'old-final', role: 'assistant', content: 'Done.', timestamp: 4 },
    { id: 'old-error', role: 'error', content: 'Connection ended.', timestamp: 5 },
  ]
  managed.activeObjective = {
    schemaVersion: 1, objectiveId: 'root-user', userMessageId: 'root-user', lastUserMessageId: 'latest-user',
    originalText: managed.messages[0]!.content, startedAt: 1, budgetBaselineUsd: 2, tokenBaseline: 100,
    continuationCount: 3, orchestrationMode: 'mission', risk: 'standard', requiresExecutionEvidence: true,
    requiresAcceptanceCriteria: true, acceptanceRegisteredAt: 2,
    acceptanceCriteria: [{ id: 'verified', description: 'Stored target verified', toolName: 'Read', input: { path: 'target' }, checks: [{ path: '$.ok', equals: true }] }],
    completionCriteria: ['requested-outcome-delivered', 'relevant-checks-passed'], terminalState: 'complete_verified', completedAt: 4,
  }
  managed.pendingTurnRecovery = {
    userMessageId: 'root-user', startedAt: 1, attempts: 5, stagnantAttempts: 2, exhaustedAt: 5,
    leaseExpiresAt: 50, validationGaps: ['relevant-checks-passed'],
  }
  const manager = new SessionManager()
  const events: Array<Record<string, unknown>> = []
  const stopRuntime = deferred()
  const internals = manager as unknown as {
    sessions: Map<string, Managed>
    enqueuePersist: () => boolean
    flushSession: () => Promise<void>
    sendEvent: (event: Record<string, unknown>) => void
    getOrCreateAgent: () => Promise<unknown>
    disposeManagedAgentRuntime: () => Promise<void>
    processNextQueuedMessage: () => void
    startGenerationTelemetry: () => void
    finishGenerationTelemetry: () => void
    pendingPermissionRequests: Map<string, { sessionId: string }>
    resumePendingTurnAfterRestart: (sessionId: string) => Promise<void>
    ensureMessagesLoaded: (session: Managed) => Promise<void>
    onProcessingStopped: (sessionId: string, reason: 'timeout', generation: number) => Promise<void>
  }
  internals.sessions.set(id, managed)
  internals.enqueuePersist = () => true
  internals.flushSession = async () => {}
  internals.sendEvent = event => events.push(event)
  internals.getOrCreateAgent = async () => { await stopRuntime.promise; throw new Error('Fixture runtime stopped before API work') }
  internals.disposeManagedAgentRuntime = async () => { managed.agent = null }
  internals.processNextQueuedMessage = () => {}
  internals.startGenerationTelemetry = () => {}
  internals.finishGenerationTelemetry = () => {}
  let dispatch: Promise<void> | undefined
  const send = manager.sendMessage.bind(manager)
  manager.sendMessage = (...args) => { dispatch = send(...args); return dispatch }
  const finish = async () => { stopRuntime.resolve(); await dispatch }
  return { manager, managed, internals, events, finish, rootPath }
}

afterEach(() => {
  ids.splice(0).forEach(clearObjectiveEvidenceGate)
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

describe('explicit retry of an existing turn', () => {
  it('reopens an expired permission block without treating Retry as approval', async () => {
    const h = harness()
    h.managed.sessionStatus = 'blocked'
    h.managed.activeObjective!.terminalState = 'blocked_human'
    h.managed.activeObjective!.completedAt = 6
    h.managed.pendingTurnRecovery = {
      ...h.managed.pendingTurnRecovery!,
      userMessageId: 'latest-user',
      waitingForPermission: {
        requestId: 'expired-permission',
        requestedAt: 5,
        toolName: 'gmail_send',
        toolUseId: 'gmail-call',
        recoveryRequired: true,
      },
    }
    const entered = deferred(); const release = deferred(); let permissionResponses = 0
    const agent = {
      getModel: () => 'test/permission-retry', getSessionId: () => null, setAllSources: () => {},
      isProcessing: () => true,
      respondToPermission: () => { permissionResponses++ },
      async *chat() {
        entered.resolve()
        await release.promise
        yield { type: 'complete' as const }
      },
    }
    h.internals.getOrCreateAgent = async () => { h.managed.agent = agent as never; return agent }

    try {
      expect(await h.manager.retryTurn(h.managed.id, 'latest-user')).toEqual({ status: 'started' })
      await entered.promise
      expect(h.managed.activeObjective?.terminalState as string).toBe('active')
      expect(h.managed.pendingTurnRecovery?.waitingForPermission).toBeUndefined()
      expect(h.internals.pendingPermissionRequests.size).toBe(0)
      expect(permissionResponses).toBe(0)
      expect(h.managed.sessionStatus).toBe('in-progress')
    } finally {
      release.resolve()
      await h.finish()
    }
  })

  it('does not start a stale provider chat after Stop timed out during runtime preparation, and permits the next retry', async () => {
    const h = harness()
    const preparing = deferred()
    const releasePreparation = deferred()
    const finishProvider = deferred()
    let providerStarted = false
    let backendBusy = false
    let preparations = 0
    h.internals.getOrCreateAgent = async () => {
      if (++preparations > 1) throw new Error('Fixture next attempt stopped before provider work')
      preparing.resolve()
      await releasePreparation.promise
      const agent = {
        getModel: () => 'test/stale-runtime', getSessionId: () => null, setAllSources: () => {},
        isProcessing: () => backendBusy,
        forceAbort: () => { backendBusy = false; finishProvider.resolve() },
        async *chat() {
          providerStarted = true; backendBusy = true
          try { await finishProvider.promise; yield { type: 'complete' as const } }
          finally { backendBusy = false }
        },
      }
      h.managed.agent = agent as never
      return agent
    }
    let initialSettled = false
    const initial = h.manager.sendMessage(h.managed.id, 'Nouvel objectif : explique le résultat.').finally(() => { initialSettled = true })
    await preparing.promise
    const anchor = h.managed.messages.findLast(message => message.role === 'user' && !message.hidden)!.id
    await h.manager.cancelProcessing(h.managed.id)
    // Exercise the real handler called by the five-second Stop timeout, without
    // sleeping or starting a provider. The delayed setup belongs to this turn.
    await h.internals.onProcessingStopped(h.managed.id, 'timeout', h.managed.processingGeneration)
    expect(h.managed.isProcessing).toBe(false)
    releasePreparation.resolve()
    for (let count = 0; count < 40 && !initialSettled && !providerStarted; count++) await new Promise<void>(resolve => setImmediate(resolve))
    try {
      const retry = await h.manager.retryTurn(h.managed.id, anchor)
      expect(providerStarted).toBe(false)
      expect(retry).toEqual({ status: 'started' })
    } finally {
      finishProvider.resolve()
      await initial
      await h.finish()
    }
  })

  it.each(['ready', 'failed'])('leaves a newer active turn intact when stopped runtime preparation later becomes %s', async outcome => {
    const h = harness()
    const preparing = deferred()
    const releasePreparation = deferred()
    const providerStarted = deferred()
    const finishProvider = deferred()
    let preparations = 0
    let chats = 0
    const currentAgent = {
      getModel: () => 'test/current-runtime', getSessionId: () => null, setAllSources: () => {},
      isProcessing: () => true,
      async *chat() {
        chats++
        providerStarted.resolve()
        await finishProvider.promise
        yield { type: 'complete' as const }
      },
    }
    h.internals.getOrCreateAgent = async () => {
      if (++preparations === 1) {
        preparing.resolve()
        await releasePreparation.promise
        if (outcome === 'failed') throw new Error('Old runtime setup failed after its replacement started')
        return h.managed.agent
      }
      h.managed.agent = currentAgent as never
      return currentAgent
    }
    const initial = h.manager.sendMessage(h.managed.id, 'Explique le premier résultat.')
    await preparing.promise
    await h.manager.cancelProcessing(h.managed.id)
    await h.internals.onProcessingStopped(h.managed.id, 'timeout', h.managed.processingGeneration)
    const replacement = h.manager.sendMessage(h.managed.id, 'Nouvel objectif : explique le second résultat.')
    await providerStarted.promise
    const generation = h.managed.processingGeneration
    const eventsBefore = h.events.slice()
    const objectiveBefore = structuredClone(h.managed.activeObjective)
    const recoveryBefore = structuredClone(h.managed.pendingTurnRecovery)
    releasePreparation.resolve()
    try {
      await initial
      expect(chats).toBe(1)
      expect(h.managed.isProcessing).toBe(true)
      expect(h.managed.processingGeneration).toBe(generation)
      expect(h.managed.agent).toBe(currentAgent as never)
      expect(h.managed.activeObjective).toEqual(objectiveBefore)
      expect(h.managed.pendingTurnRecovery).toEqual(recoveryBefore)
      expect(h.events).toEqual(eventsBefore)
    } finally {
      finishProvider.resolve()
      await replacement
      await h.finish()
    }
  })

  it.each(['construction', 'postInit', 'stopped-construction'])('guards real cold-runtime %s ownership and cleanup', async seam => {
    const h = harness()
    setSessionPlatform({
      appRootPath: h.rootPath, resourcesPath: h.rootPath, isPackaged: false,
      appVersion: 'test', isDebugMode: false,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: { async getMetadata() { return null }, async process() { return Buffer.alloc(0) } },
    })
    const preparing = deferred()
    const releasePreparation = deferred()
    const lateAgent = {
      forceAbort: () => {},
      postInit: async () => {
        preparing.resolve()
        await releasePreparation.promise
        return {}
      },
    }
    const factory = spyOn(backend, 'createBackendFromResolvedContext').mockReturnValue(lateAgent as never)
    const context = spyOn(backend, 'resolveBackendContext').mockReturnValue({
      provider: 'anthropic', authType: 'api_key', resolvedModel: 'test/preparation',
      capabilities: { needsHttpPoolServer: false }, connection: null,
    } as never)
    const preparation = h.manager as unknown as {
      loadAgentContextWindowPreference: () => Promise<boolean>
      applyRoutingPolicyForNextTurn: () => Promise<void>
      tryRefreshAgentRuntime: () => Promise<void>
    }
    preparation.applyRoutingPolicyForNextTurn = async () => {}
    preparation.tryRefreshAgentRuntime = async () => {}
    preparation.loadAgentContextWindowPreference = async () => {
      if (seam !== 'postInit') {
        preparing.resolve()
        await releasePreparation.promise
      }
      return false
    }
    h.internals.getOrCreateAgent = Object.getPrototypeOf(h.manager).getOrCreateAgent.bind(h.manager)
    const initial = h.manager.sendMessage(h.managed.id, 'Explique le premier résultat.')
    try {
      await preparing.promise
      await h.manager.cancelProcessing(h.managed.id)
      if (seam === 'stopped-construction') {
        expect(h.managed.agent).toBeNull()
        expect(h.managed.mcpPool).toBeDefined()
        let disposals = 0
        h.internals.disposeManagedAgentRuntime = async () => {
          disposals++
          h.managed.agent = null
          h.managed.mcpPool = undefined
          h.managed.poolServer = undefined
        }
        releasePreparation.resolve()
        await initial
        expect(factory).not.toHaveBeenCalled()
        expect(disposals).toBe(1)
        expect(h.managed.mcpPool).toBeUndefined()
        expect(h.managed.isProcessing).toBe(false)
        return
      }
      await h.internals.onProcessingStopped(h.managed.id, 'timeout', h.managed.processingGeneration)
      // The real getOrCreateAgent is suspended before its factory assignment
      // or callback wiring. A replacement now owns all shared runtime slots.
      const currentAgent = { isProcessing: () => true }
      const currentPool = { current: true }
      const currentEnv = { TEST_CURRENT_RUNTIME: 'current' }
      h.managed.processingGeneration++
      h.managed.isProcessing = true
      h.managed.agent = currentAgent as never
      h.managed.mcpPool = currentPool as never
      h.managed.envOverrides = currentEnv
      h.managed.backendRuntimeSignature = 'current-signature'
      h.managed.sdkSessionId = 'current-sdk'
      h.managed.branchFromSdkSessionId = 'current-parent'
      h.managed.transferredSessionSummary = 'current-summary'
      h.managed.transferredSessionSummaryApplied = false
      const eventsBefore = h.events.slice()
      if (seam === 'postInit') {
        const callbacks = factory.mock.calls[0]![0].coreConfig
        callbacks.onSdkSessionIdUpdate?.('stale-sdk')
        callbacks.onSdkSessionIdCleared?.()
        callbacks.onBranchForkInvalidated?.()
        callbacks.markTransferredSessionSummaryApplied?.()
      }
      releasePreparation.resolve()
      await initial
      expect(factory).toHaveBeenCalledTimes(seam === 'construction' ? 0 : 1)
      expect(h.managed.agent).toBe(currentAgent as never)
      expect(h.managed.mcpPool).toBe(currentPool as never)
      expect(h.managed.envOverrides).toBe(currentEnv)
      expect(h.managed.backendRuntimeSignature).toBe('current-signature')
      expect(h.managed.sdkSessionId).toBe('current-sdk')
      expect(h.managed.branchFromSdkSessionId).toBe('current-parent')
      expect(h.managed.transferredSessionSummaryApplied).toBe(false)
      expect(h.managed.isProcessing).toBe(true)
      expect(h.events).toEqual(eventsBefore)
    } finally {
      releasePreparation.resolve()
      await initial
      factory.mockRestore()
      context.mockRestore()
      await h.finish()
    }
  })

  it.each(['message-flush', 'status-flush', 'message-marker-failure', 'retry-marker', 'retry-marker-failure'])('does not adopt a newer generation after the old %s finishes', async seam => {
    const h = harness()
    const flushing = deferred()
    const releaseFlush = deferred()
    const providerStarted = deferred()
    const finishProvider = deferred()
    const isRetry = seam.startsWith('retry-')
    const holdFlush = seam === 'message-flush' ? 1 : seam === 'message-marker-failure' ? 3 : 2
    let flushes = 0
    h.internals.flushSession = async () => {
      if (++flushes === holdFlush) {
        flushing.resolve()
        await releaseFlush.promise
        if (seam.endsWith('-failure')) throw new Error('Old durable marker failed')
      }
    }
    const currentAgent = {
      getModel: () => 'test/current', getSessionId: () => null, setAllSources: () => {},
      isProcessing: () => true,
      async *chat() {
        providerStarted.resolve()
        await finishProvider.promise
        yield { type: 'complete' as const }
      },
    }
    h.internals.getOrCreateAgent = async () => { h.managed.agent = currentAgent as never; return currentAgent }
    if (!isRetry) h.managed.sessionStatus = 'todo'
    const handlers = new Map<string, HandlerFn>()
    const rpcEvents: unknown[] = []
    const server = {
      handle: (channel: string, handler: HandlerFn) => handlers.set(channel, handler),
      push: (...args: unknown[]) => { rpcEvents.push(args) },
    } as unknown as RpcServer
    registerSessionsHandlers(server, {
      sessionManager: h.manager,
      platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    } as never)
    const context: RequestContext = {
      clientId: 'test-client', workspaceId: h.managed.workspace.id, webContentsId: null,
      actorId: 'human', roles: ['user'], authorizationGeneration: 1, allowedWorkspaceIds: '*',
    }
    const send = h.manager.sendMessage.bind(h.manager)
    let initialDispatch: Promise<void> | undefined
    h.manager.sendMessage = (...args) => {
      const dispatch = send(...args)
      initialDispatch ??= dispatch
      return dispatch
    }
    const initial = (isRetry
      ? h.manager.retryTurn(h.managed.id, 'latest-user')
      : Promise.resolve(handlers.get(RPC_CHANNELS.sessions.SEND_MESSAGE)!(context, h.managed.id, 'Explique le premier résultat.'))
    ).catch(error => error)
    let replacement: Promise<void> | undefined
    try {
      await flushing.promise
      await h.manager.cancelProcessing(h.managed.id)
      await h.internals.onProcessingStopped(h.managed.id, 'timeout', h.managed.processingGeneration)
      replacement = h.manager.sendMessage(h.managed.id, 'Nouvel objectif : explique le second résultat.')
      await providerStarted.promise
      const eventsBefore = h.events.slice()
      const objectiveBefore = structuredClone(h.managed.activeObjective)
      const recoveryBefore = structuredClone(h.managed.pendingTurnRecovery)
      const messageBefore = h.managed.lastSentMessage
      const statusBefore = h.managed.turnLifecycleManagedStatus
      releaseFlush.resolve()
      const result = await initial
      await initialDispatch?.catch(() => {})
      // Let the actual RPC post-ACK .catch run if the stale send rejected.
      await new Promise<void>(resolve => setImmediate(resolve))
      if (isRetry || seam === 'message-flush') expect(result).toBeInstanceOf(Error)
      else expect(result).toMatchObject({ accepted: true, messageId: expect.any(String) })
      expect(h.managed.processingGeneration).toBe(2)
      expect(h.managed.isProcessing).toBe(true)
      expect(h.managed.agent).toBe(currentAgent as never)
      expect(h.managed.activeObjective).toEqual(objectiveBefore)
      expect(h.managed.pendingTurnRecovery).toEqual(recoveryBefore)
      expect(h.managed.lastSentMessage).toBe(messageBefore)
      expect(h.managed.turnLifecycleManagedStatus).toBe(statusBefore)
      expect(h.events).toEqual(eventsBefore)
      expect(rpcEvents).toEqual([])
    } finally {
      releaseFlush.resolve()
      finishProvider.resolve()
      await initial
      await replacement
      await h.finish()
    }
  })

  it('upgrades legacy validation exhaustion before retry and retains it if runtime setup fails', async () => {
    const h = harness()
    h.managed.activeObjective!.terminalState = 'exhausted'
    h.managed.pendingTurnRecovery!.lastCause = 'objective_incomplete'
    const before = structuredClone(h.managed.pendingTurnRecovery!)
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
    expect(h.managed.pendingTurnRecovery?.validationExhausted).toBe(true)
    await h.finish()
    expect(h.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(h.managed.pendingTurnRecovery?.attempts).toBe(before.attempts)
    expect(h.managed.pendingTurnRecovery?.stagnantAttempts).toBe(before.stagnantAttempts)
    expect(h.managed.pendingTurnRecovery?.validationGaps).toEqual(before.validationGaps)
    const stopped = structuredClone(h.managed.pendingTurnRecovery)
    h.manager.retryTurn = async () => { throw new Error('Stopped retry must not resume on restart') }
    await h.internals.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.managed.pendingTurnRecovery).toEqual(stopped)
  })

  it('preserves the prior validation stop and diagnostics when the user stops a retry, without authorizing startup recovery', async () => {
    const h = harness()
    h.managed.activeObjective!.terminalState = 'exhausted'
    h.managed.pendingTurnRecovery!.lastCause = 'objective_incomplete'
    const before = structuredClone(h.managed.pendingTurnRecovery!)
    await h.manager.retryTurn(h.managed.id, 'latest-user')
    await h.manager.cancelProcessing(h.managed.id)
    expect(h.managed.activeObjective?.terminalState).toBe('exhausted')
    expect(h.managed.pendingTurnRecovery?.validationExhausted).toBe(true)
    await h.finish()
    expect(h.managed.pendingTurnRecovery?.attempts).toBe(before.attempts)
    expect(h.managed.pendingTurnRecovery?.validationGaps).toEqual(before.validationGaps)
    expect(h.managed.isProcessing).toBe(false)
    const stopped = structuredClone(h.managed.pendingTurnRecovery)
    await h.manager.cancelProcessing(h.managed.id)
    h.manager.retryTurn = async () => { throw new Error('User stop must never authorize startup recovery') }
    await h.internals.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.managed.pendingTurnRecovery).toEqual(stopped)
    expect(h.managed.messageQueue).toEqual([])
    expect(h.managed.messages.filter(message => message.role === 'user')).toHaveLength(2)
  })

  it('acknowledges without awaiting the model, preserves the root contract, evidence, attachment and retry budget, and reopens status', async () => {
    const h = harness()
    const originalMessages = structuredClone(h.managed.messages)
    const previousObjective = structuredClone(h.managed.activeObjective!)
    const attachmentPath = join(h.rootPath, 'original.txt')
    writeFileSync(attachmentPath, 'The preserved attachment content.')
    h.managed.messages[2]!.attachments = [{ id: 'a', type: 'text', name: 'brief.txt', mimeType: 'text/plain', size: 33, storedPath: attachmentPath }]
    originalMessages[2]!.attachments = structuredClone(h.managed.messages[2]!.attachments)
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.isProcessing).toBe(true)
      expect(h.managed.sessionStatus).toBe('in-progress')
      expect(h.managed.messages).toEqual(originalMessages.map(message => message.id === 'latest-user' ? { ...message, isQueued: false } : message))
      expect(h.managed.activeObjective).toEqual({ ...previousObjective, terminalState: 'active', completedAt: undefined })
      expect(h.managed.pendingTurnRecovery).toMatchObject({ userMessageId: 'latest-user', attempts: 5, stagnantAttempts: 2, exhaustedAt: 5, leaseExpiresAt: 50, userRetryFromMessageCount: 5 })
      expect(h.managed.lastSentMessage).toContain('Do not repeat an external mutation')
      expect(h.managed.lastSentMessage).toContain('original_user_message_id="latest-user"')
      expect(h.managed.lastSentMessage).toContain(h.managed.messages[2]!.content)
      expect(h.managed.lastSentAttachments?.[0]).toMatchObject({ name: 'brief.txt', text: 'The preserved attachment content.', storedPath: attachmentPath })
      expect(h.events.filter(event => event.type === 'user_message')).toEqual([{ type: 'user_message', sessionId: h.managed.id, message: h.managed.messages[2], status: 'processing' }])
    } finally { await h.finish() }
    expect(h.managed.isProcessing).toBe(false)
    expect(h.managed.sessionStatus).toBe('blocked')
  })

  it('serializes duplicate clicks through durable acceptance and starts exactly one existing turn', async () => {
    const h = harness()
    const flush = deferred()
    h.internals.flushSession = () => flush.promise
    let accepted = 0
    const first = h.manager.retryTurn(h.managed.id, 'latest-user').then(result => { accepted++; return result })
    const second = h.manager.retryTurn(h.managed.id, 'latest-user').then(result => { accepted++; return result })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(accepted).toBe(0)
    flush.resolve()
    try {
      expect(await first).toEqual({ status: 'started' })
      expect(await second).toEqual({ status: 'already_running' })
      expect(h.managed.processingGeneration).toBe(1)
      expect(h.managed.messages.filter(message => message.role === 'user')).toHaveLength(2)
    } finally { await h.finish() }
  })

  it('delivers read-only proof recovery on retry while retaining the completed write, corrupt read, and exhausted budget', async () => {
    const h = harness()
    h.managed.messages.splice(2, 0, {
      id: 'corrupt-read', role: 'tool', content: 'Stored observation', timestamp: 2,
      toolName: 'Read', toolUseId: 'read-1', toolStatus: 'completed', toolExecuted: true,
      toolResult: '{"ok":tru',
    })
    h.managed.activeObjective!.terminalState = 'exhausted'
    h.managed.pendingTurnRecovery!.lastCause = 'objective_incomplete'
    h.managed.pendingTurnRecovery!.validationGaps = ['The target Read receipt is corrupt and cannot prove $.ok equals true.']
    const originalEvidence = structuredClone(h.managed.messages.filter(message => message.role === 'tool'))
    const budget = structuredClone(h.managed.pendingTurnRecovery!)
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.lastSentMessage).toContain('strictly read-only observation')
      expect(h.managed.lastSentMessage).toContain('fresh tool receipt faithfully')
      expect(h.managed.lastSentMessage).toContain('Do not repeat an external mutation')
      expect(h.managed.lastSentMessage).toContain(budget.validationGaps![0]!)
      expect(h.managed.messages.filter(message => message.role === 'tool')).toEqual(originalEvidence)
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        attempts: budget.attempts, stagnantAttempts: budget.stagnantAttempts,
        exhaustedAt: budget.exhaustedAt, leaseExpiresAt: budget.leaseExpiresAt,
      })
    } finally { await h.finish() }
  })

  it('rejects stale, hidden, queued and internal anchors without changing the objective', async () => {
    const h = harness()
    for (const options of [{ id: 'root-user' }, { id: 'hidden', hidden: true }, { id: 'queued', isQueued: true }, { id: 'internal', internalOrigin: { kind: 'agent-message' as const } }]) {
      if (options.id !== 'root-user') h.managed.messages.push({ role: 'user', content: 'Not a new human request', timestamp: 6, ...options })
      await expect(h.manager.retryTurn(h.managed.id, options.id)).rejects.toThrow('latest accepted user message')
    }
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(h.managed.isProcessing).toBe(false)
  })

  it('retries an authenticated initial delegation on its existing ID while preserving answers, evidence and exhausted budgets', async () => {
    const h = harness()
    h.managed.parentSessionId = 'delegating-parent'
    h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
    h.managed.messages[0]!.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
    h.managed.messages.push(
      { id: 'answer', role: 'user', content: 'The saved clarification.', timestamp: 6, hidden: true,
        internalOrigin: { kind: 'user-input' } },
      { id: 'stop', role: 'info', content: 'Response interrupted', timestamp: 7 },
    )
    h.managed.activeObjective!.lastUserMessageId = 'root-user'
    h.managed.pendingTurnRecovery!.validationExhausted = true
    h.managed.pendingTurnRecovery!.lastCause = 'objective_incomplete'
    const before = structuredClone(h.managed.messages)
    const objective = structuredClone(h.managed.activeObjective!)
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.messages).toEqual(before.map(message => message.id === 'root-user' ? { ...message, isQueued: false } : message))
      expect(h.managed.activeObjective).toEqual({ ...objective, terminalState: 'active', completedAt: undefined })
      expect(h.managed.pendingTurnRecovery).toMatchObject({ userMessageId: 'root-user', attempts: 5,
        stagnantAttempts: 2, exhaustedAt: 5, validationExhausted: true, validationGaps: ['relevant-checks-passed'] })
      expect(h.managed.lastSentMessage).toContain('original_user_message_id="root-user"')
      expect(h.managed.lastSentMessage).toContain('Do not repeat an external mutation')
      expect(h.events.filter(event => event.type === 'user_message')).toMatchObject([
        { message: { id: 'root-user', internalOrigin: { kind: 'spawned-session', senderSessionId: 'delegating-parent' } }, status: 'processing' },
      ])
    } finally { await h.finish() }
  })

  it('retries an exhausted automation snapshot only through its authenticated root', async () => {
    const h = harness()
    h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
    h.managed.messages[0]!.internalOrigin = { kind: 'automation' }
    h.managed.triggeredBy = { automationName: 'Daily verification', timestamp: 1 }
    h.managed.activeObjective!.lastUserMessageId = 'root-user'
    const recovery = {
      ...h.managed.pendingTurnRecovery!,
      userMessageId: 'root-user',
      continuationOrigin: 'objective_continue' as const,
      continuationWork: ['Verify the saved automation result'],
    }
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'exhausted'
    h.managed.activeObjective!.interruptedTurnRecovery = {
      objectiveId: 'root-user', userMessageId: 'root-user', recovery,
    }
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        userMessageId: 'root-user',
        attempts: recovery.attempts,
        continuationOrigin: 'objective_continue',
        continuationWork: ['Verify the saved automation result'],
      })
      expect(h.managed.lastSentMessage).toContain('Verify the saved automation result')
    } finally { await h.finish() }
  })

  it('refuses automation retry anchors without the complete host-owned root provenance', async () => {
    for (const variant of [
      'missing-trigger', 'has-parent', 'wrong-objective', 'wrong-root', 'hidden', 'queued', 'pending',
      'agent-delivery', 'wrong-origin', 'duplicate-root',
    ]) {
      const h = harness()
      h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
      const root = h.managed.messages[0]!
      root.internalOrigin = { kind: 'automation' }
      h.managed.triggeredBy = { automationName: 'Daily verification', timestamp: 1 }
      h.managed.activeObjective!.lastUserMessageId = 'root-user'
      if (variant === 'missing-trigger') h.managed.triggeredBy = undefined
      if (variant === 'has-parent') h.managed.parentSessionId = 'unexpected-parent'
      if (variant === 'wrong-objective') h.managed.activeObjective!.objectiveId = 'another-objective'
      if (variant === 'wrong-root') h.managed.activeObjective!.userMessageId = 'another-root'
      if (variant === 'hidden') root.hidden = true
      if (variant === 'queued') root.isQueued = true
      if (variant === 'pending') root.isPending = true
      if (variant === 'agent-delivery') root.agentDelivery = { id: 'delivery', status: 'queued', attempts: 0 }
      if (variant === 'wrong-origin') root.internalOrigin = { kind: 'agent-message' }
      if (variant === 'duplicate-root') h.managed.messages.push({ ...root })
      const before = structuredClone({
        messages: h.managed.messages,
        objective: h.managed.activeObjective,
        recovery: h.managed.pendingTurnRecovery,
      })
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).rejects.toThrow('latest accepted user message')
      expect({
        messages: h.managed.messages,
        objective: h.managed.activeObjective,
        recovery: h.managed.pendingTurnRecovery,
      }).toEqual(before)
      expect(h.managed.isProcessing).toBe(false)
    }
  })

  it('authenticates a stopped snapshot by its visible anchor while preserving a hidden answer recovery', async () => {
    const h = harness()
    const questions = [{ id: 'scope', question: 'Which scope?' }]
    const answers = [{ questionId: 'scope', optionIds: [], text: 'The durable user-input answer.' }]
    const hiddenAnswer = {
      id: 'saved-answer', role: 'user' as const,
      content: USER_INPUT_ANSWER_MESSAGE_PREFIX + JSON.stringify({ requestId: 'saved-question', questions, answers }),
      timestamp: 6,
      hidden: true, internalOrigin: { kind: 'user-input' as const },
    }
    h.managed.messages.push(hiddenAnswer)
    h.managed.userInputRequests = [{
      id: 'saved-question', sessionId: h.managed.id, originWorkspaceId: h.managed.workspace.id,
      questions, status: 'answered', createdAt: 5, answeredAt: 6,
      objectiveUserMessageId: 'root-user', responseMessageId: hiddenAnswer.id,
      answers,
    }]
    const recovery = {
      ...h.managed.pendingTurnRecovery!,
      userMessageId: hiddenAnswer.id,
      attempts: 3,
      stagnantAttempts: 1,
      continuationWork: ['Apply the saved answer and verify the target'],
      continuationOrigin: 'objective_continue' as const,
    }
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'blocked_policy'
    h.managed.activeObjective!.interruptedTurnRecovery = {
      objectiveId: 'root-user',
      userMessageId: 'latest-user',
      recovery: structuredClone(recovery),
    }
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.messages).toContainEqual(hiddenAnswer)
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        userMessageId: 'latest-user',
        attempts: recovery.attempts,
        stagnantAttempts: recovery.stagnantAttempts,
        continuationWork: recovery.continuationWork,
        continuationOrigin: recovery.continuationOrigin,
      })
      expect(h.managed.lastSentMessage).toContain('Apply the saved answer and verify the target')
    } finally { await h.finish() }
  })

  it('rejects a structurally bound snapshot whose inner recovery belongs to an older objective', async () => {
    const h = harness()
    h.managed.pendingTurnRecovery = undefined
    h.managed.activeObjective!.terminalState = 'blocked_policy'
    h.managed.activeObjective!.interruptedTurnRecovery = {
      objectiveId: 'root-user',
      userMessageId: 'latest-user',
      recovery: {
        userMessageId: 'old-objective-A', startedAt: 1, attempts: 9, stagnantAttempts: 2,
        lastCause: 'objective_continue', continuationRequired: true,
        continuationOrigin: 'objective_continue', continuationWork: ['Old objective A work'],
      },
    }
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.pendingTurnRecovery).toMatchObject({
        userMessageId: 'latest-user', attempts: 0, budgetHistoryUnavailable: true,
        lastCause: 'user_retry',
      })
      const pending = h.managed.pendingTurnRecovery as Managed['pendingTurnRecovery']
      expect(pending?.continuationWork).toBeUndefined()
      expect(pending?.continuationOrigin).toBeUndefined()
    } finally { await h.finish() }
  })

  it('refuses delegated anchors with wrong parent, objective, origin, visibility or admission state', async () => {
    for (const variant of ['no-parent', 'wrong-parent', 'self-parent', 'wrong-objective', 'wrong-root', 'missing-objective',
      'hidden', 'queued', 'pending', 'agent-message', 'user-input', 'not-initial']) {
      const h = harness()
      h.managed.parentSessionId = 'delegating-parent'
      h.managed.messages = h.managed.messages.filter(message => message.id !== 'latest-user')
      const anchor = h.managed.messages[0]!
      anchor.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
      if (variant === 'no-parent') h.managed.parentSessionId = undefined
      if (variant === 'wrong-parent') anchor.internalOrigin.senderSessionId = 'another-parent'
      if (variant === 'self-parent') { h.managed.parentSessionId = h.managed.id; anchor.internalOrigin.senderSessionId = h.managed.id }
      if (variant === 'wrong-objective') h.managed.activeObjective!.objectiveId = 'another-objective'
      if (variant === 'wrong-root') h.managed.activeObjective!.userMessageId = 'another-root'
      if (variant === 'missing-objective') h.managed.activeObjective = undefined
      if (variant === 'hidden') anchor.hidden = true
      if (variant === 'queued') anchor.isQueued = true
      if (variant === 'pending') anchor.isPending = true
      if (variant === 'agent-message' || variant === 'user-input') anchor.internalOrigin = { kind: variant }
      if (variant === 'not-initial') h.managed.messages.unshift({ id: 'older-internal-root', role: 'user', content: 'Earlier delegation',
        timestamp: 0, hidden: true, internalOrigin: { kind: 'spawned-session', senderSessionId: 'delegating-parent' } })
      const before = structuredClone({ messages: h.managed.messages, objective: h.managed.activeObjective, recovery: h.managed.pendingTurnRecovery })
      await expect(h.manager.retryTurn(h.managed.id, 'root-user')).rejects.toThrow('latest accepted user message')
      expect({ messages: h.managed.messages, objective: h.managed.activeObjective, recovery: h.managed.pendingTurnRecovery }).toEqual(before)
      expect(h.managed.isProcessing).toBe(false)
    }
  })

  it('prefers the latest accepted human request over the initial delegation and still refuses outstanding decisions', async () => {
    const h = harness()
    h.managed.parentSessionId = 'delegating-parent'
    h.managed.messages[0]!.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
    await expect(h.manager.retryTurn(h.managed.id, 'root-user')).rejects.toThrow('latest accepted user message')
    try {
      await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
      expect(h.managed.pendingTurnRecovery?.userMessageId).toBe('latest-user')
    } finally { await h.finish() }
    for (const kind of ['question', 'auth', 'approval', 'queue']) {
      const child = harness()
      child.managed.parentSessionId = 'delegating-parent'
      child.managed.messages = child.managed.messages.filter(message => message.id !== 'latest-user')
      child.managed.messages[0]!.internalOrigin = { kind: 'spawned-session', senderSessionId: 'delegating-parent' }
      if (kind === 'question') child.managed.userInputRequests = [{ id: 'q', sessionId: child.managed.id,
        originWorkspaceId: child.managed.workspace.id, status: 'pending', createdAt: 1 }] as never
      if (kind === 'auth') child.managed.pendingAuthRequestId = 'auth'
      if (kind === 'approval') child.internals.pendingPermissionRequests.set('permission', { sessionId: child.managed.id })
      if (kind === 'queue') child.managed.messageQueue.push({ message: 'waiting' })
      await expect(child.manager.retryTurn(child.managed.id, 'root-user')).rejects.toThrow()
      expect(child.managed.isProcessing).toBe(false)
      expect(child.events).toHaveLength(0)
    }
  })

  it.each(['question', 'auth', 'approval', 'queue'])('does not bypass a pending %s', async kind => {
    const h = harness()
    if (kind === 'question') h.managed.userInputRequests = [{ id: 'q', sessionId: h.managed.id, originWorkspaceId: h.managed.workspace.id, status: 'pending', createdAt: 1 }] as never
    if (kind === 'auth') h.managed.pendingAuthRequestId = 'auth'
    if (kind === 'approval') h.internals.pendingPermissionRequests.set('permission', { sessionId: h.managed.id })
    if (kind === 'queue') h.managed.messageQueue.push({ message: 'waiting' })
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow()
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(h.managed.messages).toHaveLength(5)
  })

  it('reports an already active session without queuing or duplicating its user message', async () => {
    const h = harness()
    h.managed.isProcessing = true
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'already_running' })
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.managed.messages).toHaveLength(5)
  })

  it('rejects a missing saved attachment before reopening anything', async () => {
    const h = harness()
    h.managed.messages[2]!.attachments = [{ id: 'missing', type: 'text', name: 'missing.txt', mimeType: 'text/plain', size: 1, storedPath: join(h.rootPath, 'missing.txt') }]
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow('saved attachment is unavailable')
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
    expect(h.managed.isProcessing).toBe(false)
  })

  it('rolls back the reopen and releases the reservation when durable acceptance fails', async () => {
    const h = harness()
    const objective = h.managed.activeObjective
    const recovery = h.managed.pendingTurnRecovery
    let flushes = 0
    h.internals.flushSession = async () => { if (++flushes > 1) throw new Error('durable write failed') }
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow('durable write failed')
    expect(h.managed.activeObjective).toBe(objective)
    expect(h.managed.pendingTurnRecovery).toBe(recovery)
    expect(h.managed.sessionStatus).toBe('done')
    expect(h.managed.isProcessing).toBe(false)
    expect(h.events.some(event => event.type === 'user_message')).toBe(false)
    expect(h.events.at(-1)).toMatchObject({ type: 'session_status_changed', sessionStatus: 'done' })
    expect(h.events.filter(event => event.type === 'session_status_changed').map(event => event.sessionStatus)).toEqual(['in-progress', 'done'])
    expect(h.managed.messages[2]!.isQueued).toBeUndefined()
  })

  it('rechecks the user anchor after asynchronous preparation so a newer send cannot queue an old request', async () => {
    const h = harness()
    let calls = 0
    h.internals.ensureMessagesLoaded = async () => {
      if (++calls === 2) h.managed.messages.push({ id: 'new-human', role: 'user', content: 'New request', timestamp: 6 })
    }
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).rejects.toThrow('latest accepted user message')
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.managed.activeObjective?.terminalState).toBe('complete_verified')
  })

  it('does not replay an untracked legacy manual retry after restart when automatic recovery is exhausted', async () => {
    const h = harness()
    h.managed.sessionStatus = 'todo'
    h.managed.activeObjective!.terminalState = 'active'
    h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, userMessageId: 'latest-user', lastCause: 'user_retry', userRetryFromMessageCount: 5 }
    const retries: string[] = []
    h.manager.retryTurn = async () => { throw new Error('Restart must not mint a new explicit Retry allowance') }
    ;(h.internals as any).retryTurnInternal = async (_id: string, anchor: string, _context: unknown, grantNewAllowance = false) => {
      expect(grantNewAllowance).toBe(false)
      retries.push(anchor); return { status: 'started' }
    }
    await h.internals.resumePendingTurnAfterRestart(h.managed.id)
    // The legacy boundary proves which transcript rows belong to the old
    // attempt, but not whether its provider call started before the crash.
    // Without a durable dispatch identity, replaying it directly could repeat
    // external work; the exhausted automatic budget must stop visibly instead.
    expect(retries).toEqual([])
    expect(h.managed.activeObjective!.userMessageId).toBe('root-user')
    expect(h.managed.activeObjective!.terminalState as string).toBe('exhausted')
    expect(h.managed.pendingTurnRecovery!.attempts).toBe(5)
    expect(h.managed.pendingTurnRecovery!.lastCause).toBe('app_restart')
    expect(h.managed.pendingTurnRecovery!.recoveryDispatch).toBeUndefined()
    expect(h.managed.messageQueue).toEqual([])
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'error',
      error: expect.stringContaining('retry limit was reached'),
    }))
  })

  it('does not replay a manual attempt that has already produced a new terminal error', async () => {
    const h = harness()
    h.managed.sessionStatus = 'todo'
    h.managed.activeObjective!.terminalState = 'active'
    h.managed.pendingTurnRecovery = { ...h.managed.pendingTurnRecovery!, userMessageId: 'latest-user', lastCause: 'user_retry', userRetryFromMessageCount: 5 }
    h.managed.messages.push({ id: 'new-error', role: 'error', content: 'New attempt failed', timestamp: 6 })
    h.manager.retryTurn = async () => { throw new Error('Must not replay terminal attempt') }
    await h.internals.resumePendingTurnAfterRestart(h.managed.id)
    expect(h.managed.pendingTurnRecovery).toBeUndefined()
  })

  it('never accepts the previous final when the retry stream ends without a new response', async () => {
    const h = harness()
    h.internals.getOrCreateAgent = async () => ({
      getModel: () => 'test/retry-model', getSessionId: () => null, setAllSources: () => {},
      async *chat() { yield { type: 'complete' } },
    })
    await expect(h.manager.retryTurn(h.managed.id, 'latest-user')).resolves.toEqual({ status: 'started' })
    await h.finish()
    expect(h.managed.activeObjective?.terminalState).not.toBe('complete_verified')
    // The explicit user retry may now own a prospective reserve. An empty
    // stream can consume one bounded pass, but never adopt the old final.
    for (let pass = 0; pass < 8; pass++) {
      const next = h.managed.messageQueue.shift()
      if (!next) break
      expect(next.options?.automaticRecovery?.cause).toBe('stream_ended')
      await h.manager.sendMessage(h.managed.id, next.message, next.attachments, next.storedAttachments, next.options, next.messageId)
    }
    expect(h.managed.activeObjective?.terminalState).not.toBe('complete_verified')
    expect(h.events.some(event => event.type === 'error')).toBe(true)
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.managed.messages.filter(message => message.role === 'user' && !message.hidden)).toHaveLength(2)
  })
})
