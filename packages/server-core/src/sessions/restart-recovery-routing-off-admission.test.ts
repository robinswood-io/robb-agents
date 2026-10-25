import { piAgentForTest, type PiAgentTestView } from "./testing/private-runtime-access.ts";
import { ScriptedSessionAgent } from "./testing/scripted-session-agent.ts";
import { requiredTestValue } from "./testing/runtime-state-access.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { PiAgent } from "@craft-agent/shared/agent";
import { createAutonomyFallbackIntent } from "./autonomy-browser-fallback";
import { cleanupRestartRecovery, bindToolAdmissionTurn, deferred, harness, setAutomaticToolFallback } from './testing/restart-recovery-fixture.ts';

afterEach(cleanupRestartRecovery);

describe('automatic channel-fallback kill switch recovery boundaries', () => {
  it.each([
    [
      'browser',
      'mcp__github__lookup',
      'HTTP 503 service unavailable',
      '<automatic_browser_fallback',
      'mcp__browser__navigate',
    ],
    [
      'structured',
      'mcp__session__browser_tool',
      'UI navigation failed',
      '<automatic_structured_fallback',
      'mcp__ssh__exec',
    ],
  ] as const)(
    'revokes a live %s redirect before its next tool admission when the channel switch turns OFF',
    async (kind, failedToolName, result, marker, nextToolName) => {
      const h = harness(); const managed = h.make(`routing-off-live-redirect-${kind}`)
      setAutomaticToolFallback(h, true)
      const redirected: string[] = []
      const runtimeAgent = Object.assign(new ScriptedSessionAgent(h.workspace), {
        redirect: (redirectPrompt: string) => { redirected.push(redirectPrompt); return true },
        dispose: () => {},
      })
      managed.agent = runtimeAgent
      managed.isProcessing = true
      managed.processingGeneration = 29
      bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, managed.processingGeneration)
      await h.save(managed)

      await h.runtime.processEvent(managed, {
        type: 'tool_start', toolName: failedToolName, toolUseId: 'failed-channel-tool', input: {},
      }, managed.processingGeneration)
      await h.runtime.processEvent(managed, {
        type: 'tool_result', toolName: failedToolName, toolUseId: 'failed-channel-tool',
        result, isError: true, executed: true,
      }, managed.processingGeneration)

      expect(redirected).toHaveLength(1)
      expect(redirected[0]).toContain(marker)
      await h.manager.flushSession(managed.id)

      const originalFlush = h.manager.flushSession.bind(h.manager)
      const admissionFlushEntered = deferred()
      const releaseAdmissionFlush = deferred()
      let heldAdmissionFlush = false
      h.manager.flushSession = async id => {
        if (id === managed.id && !heldAdmissionFlush) {
          heldAdmissionFlush = true
          admissionFlushEntered.resolve()
          await releaseAdmissionFlush.promise
        }
        await originalFlush(id)
      }
      const admission = h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
        managed,
        runtimeAgent,
        { toolUseId: 'redirected-channel-tool', toolName: nextToolName, toolInput: {} },
      )
      await admissionFlushEntered.promise
      setAutomaticToolFallback(h, false)
      releaseAdmissionFlush.resolve()
      await expect(admission).rejects.toThrow('Automatic channel fallback was disabled')
      h.manager.flushSession = originalFlush
    },
  )

  it('blocks a live Pi PreToolUse when routing is switched off after fallback handoff', async () => {
    const h = harness(); const managed = h.make('routing-off-live-pretool')
    setAutomaticToolFallback(h, true)
    const allocatedAt = Date.now() - 2_000
    const startedAt = allocatedAt + 1_000
    const dispatchId = 'routing-off-live-pretool-dispatch'
    const fallbackIntent = createAutonomyFallbackIntent(
      'browser_fallback',
      'mcp__crm__lookup',
    )
    managed.pendingTurnRecovery = {
      ...managed.pendingTurnRecovery!,
      attempts: 1,
      stagnantAttempts: 0,
      leaseExpiresAt: Date.now() + 60_000,
      lastCause: 'runtime_error',
      recoveryDispatch: {
        schemaVersion: 1,
        id: dispatchId,
        attempt: 2,
        cause: 'runtime_error',
        origin: 'automatic',
        allocatedAt,
        phase: 'started',
        startedAt,
        preToolExecutionReceiptVersion: 1,
        fallbackIntent,
      },
    }
    const prompt = h.runtime.buildRecoveryDispatchMessage(
      managed,
      managed.pendingTurnRecovery,
      requiredTestValue(managed.pendingTurnRecovery.recoveryDispatch),
    )
    managed.messages.push({
      id: dispatchId,
      role: 'user',
      content: prompt,
      timestamp: startedAt + 1,
      hidden: true,
      internalOrigin: { kind: 'browser-fallback' },
    })
    await h.save(managed)

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
        await h.runtime.durablyRecordAutomaticRecoveryToolAdmission(
          managed,
          runtimeAgent,
          request,
        )
      },
    } as never)
    const backend = piAgentForTest(runtimeAgent)
    const runtimeContext = { runtimeId: 'routing-off-live-pretool-runtime', sessionId: managed.id }
    const backendResponses: Array<Parameters<PiAgentTestView['send']>[0]> = []
    const backendResponded = deferred()
    backend.subprocessRuntimeContext = runtimeContext
    backend.send = (message) => { backendResponses.push(message); backendResponded.resolve(); return true }
    const generation = 31
    managed.agent = runtimeAgent
    managed.isProcessing = true
    managed.processingGeneration = generation
    managed.lastSentOptions = {
      hidden: true,
      internalOrigin: { kind: 'browser-fallback' },
      automaticRecovery: {
        originalUserMessageId: managed.pendingTurnRecovery.userMessageId,
        cause: 'runtime_error',
        dispatchId,
        dispatchAttempt: 2,
        dispatchOrigin: 'automatic',
        dispatchAllocatedAt: allocatedAt,
      },
    }
    bindToolAdmissionTurn(h.runtime, managed, runtimeAgent, generation, dispatchId)

    // The provider produced an allow decision while the specialized fallback
    // was live. Hold the execution receipt fsync so the workspace switch can
    // change during admission, then require the final pre-ACK revalidation.
    const originalFlush = h.manager.flushSession.bind(h.manager)
    const admissionFlushEntered = deferred()
    const releaseAdmissionFlush = deferred()
    let heldAdmissionFlush = false
    h.manager.flushSession = async id => {
      if (id === managed.id && !heldAdmissionFlush) {
        heldAdmissionFlush = true
        admissionFlushEntered.resolve()
        await releaseAdmissionFlush.promise
      }
      await originalFlush(id)
    }
    backend.sendPreToolUseDecision({
      requestId: 'routing-off-live-pretool-request',
      toolName: 'mcp__browser__navigate',
      toolCallId: 'routing-off-live-pretool-call',
      originalInput: { url: 'https://example.test/' },
      runtimeContext,
      authorizationEpoch: backend.promptPreparationRevision,
    }, {
      type: 'pre_tool_use_response',
      requestId: 'routing-off-live-pretool-request',
      action: 'allow',
    })
    await admissionFlushEntered.promise
    setAutomaticToolFallback(h, false)
    releaseAdmissionFlush.resolve()
    await backendResponded.promise
    h.manager.flushSession = originalFlush

    expect(backendResponses).toEqual([expect.objectContaining({
      type: 'pre_tool_use_response',
      requestId: 'routing-off-live-pretool-request',
      action: 'block',
      reason: expect.stringContaining('Automatic channel fallback was disabled'),
    })])
    expect(backend.beginAdmittedToolExecution({
      toolUseId: 'routing-off-live-pretool-call',
      toolName: 'mcp__browser__navigate',
      toolInput: { url: 'https://example.test/' },
      sessionId: managed.id,
      runtimeId: runtimeContext.runtimeId,
      authorizationEpoch: backend.promptPreparationRevision,
    })).toBe(false)
    // The pre-execution receipt crossed its durability fence before the switch
    // changed, so it remains conservative crash evidence. The Pi execution
    // capability itself was never granted.
    const blockedReceipt = managed.messages.find(message => (
      message.toolUseId === 'routing-off-live-pretool-call'
    ))
    expect(blockedReceipt).toMatchObject({ toolStatus: 'executing' })
    expect(blockedReceipt?.toolExecuted).toBeUndefined()
    runtimeAgent.destroy()
    managed.agent = null
    managed.isProcessing = false
  })
});
