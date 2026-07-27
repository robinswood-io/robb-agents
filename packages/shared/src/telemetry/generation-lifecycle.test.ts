import { describe, expect, it } from 'bun:test'
import {
  GenerationTelemetryLifecycle,
  parseCompactionInputTokens,
} from './generation-lifecycle'

describe('GenerationTelemetryLifecycle', () => {
  it('emits one terminal event for one started generation', () => {
    const lifecycle = new GenerationTelemetryLifecycle()
    const started = lifecycle.start({
      eventId: 'event-started',
      timestamp: 1_000,
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        generationId: 'generation-1',
      },
      providerType: 'openai',
      model: 'gpt-test',
      inputTokens: 90,
    })

    const completed = lifecycle.finish('generation-1', {
      eventId: 'event-completed',
      timestamp: 1_125,
      name: 'generation.completed',
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
      cacheWriteTokens: 5,
      cacheHit: true,
    })
    const duplicate = lifecycle.finish('generation-1', {
      eventId: 'event-late-failure',
      timestamp: 1_150,
      name: 'generation.failed',
    })

    expect(started.name).toBe('generation.started')
    expect(completed).toMatchObject({
      name: 'generation.completed',
      outcome: 'success',
      durationMs: 125,
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 40,
      cacheWriteTokens: 5,
    })
    expect(duplicate).toBeUndefined()
    expect(lifecycle.isActive('generation-1')).toBe(false)
  })

  it('rejects duplicate starts for the same generation id', () => {
    const lifecycle = new GenerationTelemetryLifecycle()
    const input = {
      eventId: 'event-started',
      timestamp: 1_000,
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        generationId: 'generation-1',
      },
    }

    lifecycle.start(input)
    expect(() => lifecycle.start(input)).toThrow('already active')
  })

  it('maps cancellation to a non-error terminal outcome', () => {
    const lifecycle = new GenerationTelemetryLifecycle()
    lifecycle.start({
      eventId: 'event-started',
      timestamp: 1_000,
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        generationId: 'generation-1',
      },
    })

    expect(lifecycle.finish('generation-1', {
      eventId: 'event-cancelled',
      timestamp: 1_010,
      name: 'generation.cancelled',
      errorCode: 'user_stop',
    })).toMatchObject({
      name: 'generation.cancelled',
      outcome: 'cancelled',
      errorCode: 'user_stop',
    })
  })
})

describe('parseCompactionInputTokens', () => {
  it('extracts provider-reported input tokens without retaining status text', () => {
    expect(parseCompactionInputTokens(
      'Compacted context to fit within limits (from ~12,345 tokens)',
    )).toBe(12_345)
    expect(parseCompactionInputTokens('Compacted Conversation')).toBeUndefined()
  })
})
