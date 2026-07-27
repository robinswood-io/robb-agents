import { describe, expect, it } from 'bun:test'
import {
  analyzeRoutingOutcomes,
  summarizeRoutingOutcomes,
  validateRoutingOutcome,
  type RoutingOutcome,
} from './routing-outcomes.ts'

function samples(input: {
  slug: string
  count: number
  successes: number
  quality: number
  durationMs: number
  costUsd: number
}): RoutingOutcome[] {
  return Array.from({ length: input.count }, (_, index) => ({
    id: `${input.slug}-${index}`,
    connectionSlug: input.slug,
    difficulty: 'standard',
    status: index < input.successes ? 'success' : 'failure',
    durationMs: input.durationMs + index,
    qualityScore: input.quality,
    costUsd: input.costUsd,
    retryCount: index < input.successes ? 0 : 1,
  }))
}

describe('routing outcome analysis', () => {
  it('summarizes strict reliability, quality, cost and tail latency', () => {
    const summary = summarizeRoutingOutcomes([
      {
        id: 'one',
        connectionSlug: 'local',
        difficulty: 'simple',
        status: 'success',
        durationMs: 100,
        qualityScore: 0.9,
        inputTokens: 10,
        outputTokens: 20,
      },
      {
        id: 'two',
        connectionSlug: 'local',
        difficulty: 'simple',
        status: 'partial',
        durationMs: 500,
        qualityScore: 0.5,
        inputTokens: 20,
        outputTokens: 30,
        retryCount: 1,
      },
    ])[0]

    expect(summary).toMatchObject({
      sampleCount: 2,
      successCount: 1,
      partialCount: 1,
      successRate: 0.5,
      effectiveCompletionRate: 0.75,
      averageQuality: 0.7,
      p95DurationMs: 500,
      averageTokens: 40,
      averageRetries: 0.5,
    })
  })

  it('recommends a sufficiently sampled high-quality reliable route', () => {
    const analysis = analyzeRoutingOutcomes([
      ...samples({
        slug: 'quality',
        count: 20,
        successes: 19,
        quality: 0.95,
        durationMs: 300,
        costUsd: 0.04,
      }),
      ...samples({
        slug: 'cheap',
        count: 20,
        successes: 14,
        quality: 0.7,
        durationMs: 200,
        costUsd: 0.01,
      }),
    ], { minSamples: 10 })

    expect(analysis.recommendations.find((item) => item.connectionSlug === 'quality'))
      .toMatchObject({
        eligible: true,
        recommendedPriority: 1,
        paretoDominated: false,
      })
  })

  it('does not promote a small-sample apparent winner', () => {
    const analysis = analyzeRoutingOutcomes([
      ...samples({
        slug: 'unproven',
        count: 2,
        successes: 2,
        quality: 1,
        durationMs: 50,
        costUsd: 0.001,
      }),
      ...samples({
        slug: 'proven',
        count: 12,
        successes: 10,
        quality: 0.85,
        durationMs: 200,
        costUsd: 0.02,
      }),
    ], { minSamples: 10 })

    const unproven = analysis.recommendations.find((item) => item.connectionSlug === 'unproven')
    expect(unproven).toMatchObject({
      eligible: false,
      reason: 'insufficient evidence: 2/10 samples',
    })
    expect(unproven?.recommendedPriority).toBeUndefined()
    expect(analysis.recommendations.find((item) => item.connectionSlug === 'proven')?.recommendedPriority)
      .toBe(1)
  })

  it('rejects invalid evidence instead of silently skewing recommendations', () => {
    const invalid = {
      id: 'bad',
      connectionSlug: 'cloud',
      difficulty: 'complex',
      status: 'success',
      durationMs: -1,
      qualityScore: 2,
    } satisfies RoutingOutcome
    expect(validateRoutingOutcome(invalid)).toEqual({
      valid: false,
      errors: [
        'durationMs must be a finite non-negative number',
        'qualityScore must be between 0 and 1',
      ],
    })
    expect(() => analyzeRoutingOutcomes([invalid])).toThrow('Invalid routing outcome')
  })

  it('rejects unsupported enum values and capabilities at the runtime boundary', () => {
    const invalid = {
      id: 'invalid-enums',
      connectionSlug: 'cloud',
      difficulty: 'impossible',
      status: 'unknown',
      durationMs: 10,
      requiredCapabilities: ['telepathy'],
    } as unknown as RoutingOutcome

    expect(validateRoutingOutcome(invalid)).toEqual({
      valid: false,
      errors: [
        'difficulty must be simple, standard or complex',
        'status must be success, partial, failure or cancelled',
        'requiredCapabilities contains an unsupported capability',
      ],
    })
    expect(() => summarizeRoutingOutcomes([invalid])).toThrow(
      "Invalid routing outcome 'invalid-enums'",
    )
  })
})
