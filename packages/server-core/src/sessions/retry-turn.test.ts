import { sessionRuntimeStateForTest } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearObjectiveEvidenceGate } from "@craft-agent/shared/agent";
import * as backend from "@craft-agent/shared/agent/backend";
import { RPC_CHANNELS } from "@craft-agent/shared/protocol";
import type { HandlerFn, RpcServer, RequestContext } from "../transport";
import { registerSessionsHandlers } from "../handlers/rpc/sessions";
import { setSessionPlatform } from "./SessionManager";
import { deferred, harness, ids, roots } from "./testing/retry-turn-fixture.ts";

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
      expect(sessionRuntimeStateForTest(h.internals).pendingPermissionRequests.size).toBe(0)
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
    const handlers = new Map<string, HandlerFn<unknown[]>>()
    const rpcEvents: unknown[] = []
    const server = {
      handle: (channel: string, handler: HandlerFn) => handlers.set(channel, (ctx, ...args): unknown => Reflect.apply(handler, undefined, [ctx, ...args])),
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
});
