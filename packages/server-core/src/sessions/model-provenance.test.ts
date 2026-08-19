import { beforeEach, describe, expect, it } from 'bun:test'
import { messageToStored } from '@craft-agent/core/types'
import type { AgentEvent } from '@craft-agent/shared/agent'
import { SessionManager, createManagedSession } from './SessionManager.ts'

describe('assistant model provenance persistence', () => {
  let sessionManager: SessionManager

  beforeEach(() => {
    sessionManager = new SessionManager()
    // Keep this unit test focused on the message assembled by processEvent.
    ;(sessionManager as unknown as { persistSession: () => void }).persistSession = () => {}
    ;(sessionManager as unknown as { sendEvent: () => void }).sendEvent = () => {}
    ;(sessionManager as unknown as { emitExecutionTelemetry: () => void }).emitExecutionTelemetry = () => {}
  })

  function createSession(configuredModel: string) {
    const managed = createManagedSession({
      id: `model-provenance-${configuredModel}`,
      name: 'Model provenance test',
      model: configuredModel,
    }, {
      id: 'workspace-model-provenance',
      name: 'Model provenance workspace',
      rootPath: '/tmp/model-provenance-test',
      createdAt: Date.now(),
    } as never, { messagesLoaded: true })

    managed.agent = {
      getModel: () => configuredModel,
    } as never
    return managed
  }

  async function processTextComplete(
    managed: ReturnType<typeof createSession>,
    event: Extract<AgentEvent, { type: 'text_complete' }>,
  ): Promise<void> {
    await (sessionManager as unknown as {
      processEvent: (session: unknown, agentEvent: AgentEvent) => Promise<void>
    }).processEvent(managed, event)
  }

  it('stores the effective Pi model and keeps the requested identity for audit', async () => {
    const managed = createSession('openrouter/auto')

    await processTextComplete(managed, {
      type: 'text_complete',
      text: 'Provider-routed response',
      modelProvenance: {
        model: 'anthropic/claude-sonnet-4.6',
        requestedModel: 'openrouter/auto',
        provider: 'openrouter',
        api: 'openai-completions',
        contextWindow: 1_000_000,
      },
    })

    const stored = messageToStored(managed.messages[0]!)
    expect(stored.routingMeta).toMatchObject({
      model: 'anthropic/claude-sonnet-4.6',
      requestedModel: 'openrouter/auto',
      provider: 'openrouter',
      api: 'openai-completions',
      contextWindow: 1_000_000,
      reason: 'session-connection',
    })
    expect(stored.routingMeta?.model).not.toBe('openrouter/auto')
  })

  it('keeps the configured-model fallback for legacy text_complete events', async () => {
    const managed = createSession('openai-codex/gpt-5.6-sol')

    await processTextComplete(managed, {
      type: 'text_complete',
      text: 'Legacy response without provenance',
    })

    const stored = messageToStored(managed.messages[0]!)
    expect(stored.routingMeta?.model).toBe('openai-codex/gpt-5.6-sol')
    expect(stored.routingMeta?.requestedModel).toBeUndefined()
    expect(stored.routingMeta?.provider).toBeUndefined()
    expect(stored.routingMeta?.api).toBeUndefined()
    expect(stored.routingMeta?.contextWindow).toBeUndefined()
  })
})
