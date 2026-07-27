import { describe, expect, it } from 'bun:test'
import type {
  EvalTelemetryEvent,
  GenerationTelemetryEvent,
} from '../telemetry/execution-telemetry.ts'
import { telemetryToRoutingOutcome } from './routing-outcome-adapter.ts'

describe('telemetryToRoutingOutcome', () => {
  it('maps a completed generation without accepting prompt or response bodies', () => {
    const event: GenerationTelemetryEvent = {
      schemaVersion: 1,
      eventId: 'generation-terminal-1',
      timestamp: 1_753_286_400_000,
      name: 'generation.completed',
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        generationId: 'generation-1',
      },
      providerType: 'openai',
      model: 'gpt-test',
      outcome: 'success',
      durationMs: 120,
      inputTokens: 100,
      outputTokens: 25,
    }

    expect(telemetryToRoutingOutcome(event, {
      connectionSlug: 'openai-primary',
      difficulty: 'complex',
      requiredCapabilities: ['tools'],
      retryCount: 1,
      costUsd: 0.02,
    })).toEqual({
      id: 'generation-terminal-1',
      connectionSlug: 'openai-primary',
      difficulty: 'complex',
      status: 'success',
      durationMs: 120,
      timestamp: '2025-07-23T16:00:00.000Z',
      costUsd: 0.02,
      inputTokens: 100,
      outputTokens: 25,
      retryCount: 1,
      requiredCapabilities: ['tools'],
    })
  })

  it('maps failed, cancelled and partial evaluation outcomes', () => {
    const baseGeneration: GenerationTelemetryEvent = {
      schemaVersion: 1,
      eventId: 'generation-terminal',
      timestamp: 1_000,
      name: 'generation.failed',
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        generationId: 'generation-1',
      },
    }
    const evaluation: EvalTelemetryEvent = {
      schemaVersion: 1,
      eventId: 'eval-1',
      timestamp: 2_000,
      name: 'eval.recorded',
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        evalRunId: 'eval-run-1',
      },
      corpusId: 'fr-core-v1',
      score: 0.75,
    }
    const context = {
      connectionSlug: 'provider-primary',
      difficulty: 'standard' as const,
    }

    expect(telemetryToRoutingOutcome(baseGeneration, context)?.status).toBe('failure')
    expect(telemetryToRoutingOutcome({
      ...baseGeneration,
      name: 'generation.cancelled',
    }, context)?.status).toBe('cancelled')
    expect(telemetryToRoutingOutcome(evaluation, context)).toMatchObject({
      status: 'partial',
      qualityScore: 0.75,
    })
  })

  it('ignores non-terminal events', () => {
    const started: GenerationTelemetryEvent = {
      schemaVersion: 1,
      eventId: 'generation-started',
      timestamp: 1_000,
      name: 'generation.started',
      correlation: {
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        generationId: 'generation-1',
      },
    }

    expect(telemetryToRoutingOutcome(started, {
      connectionSlug: 'provider-primary',
      difficulty: 'simple',
    })).toBeUndefined()
  })
})
