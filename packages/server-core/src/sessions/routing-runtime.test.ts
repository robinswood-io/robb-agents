import { describe, expect, it } from 'bun:test'
import { buildRoutingRuntimeContext } from './routing-runtime.ts'

describe('buildRoutingRuntimeContext', () => {
  it('uses the latest user turn and the highest source sensitivity', () => {
    const result = buildRoutingRuntimeContext({
      requestedConnectionSlug: 'local',
      enabledSourceSlugs: ['crm'],
      sourceSensitivities: ['internal', 'confidential'],
      messages: [
        { role: 'user', content: 'short' },
        { role: 'assistant', content: 'done' },
        {
          role: 'user',
          content: 'Conçois une architecture multi-étapes pour cette migration.',
          attachments: [{ type: 'image' }],
        },
      ],
      labels: ['client:a'],
      tokenUsage: { contextTokens: 120_000, costUsd: 0.6 },
      unavailableConnectionSlugs: ['cloud'],
    })

    expect(result.classification).toEqual({
      difficulty: 'complex',
      requiredCapabilities: ['vision', 'tools', 'large-context'],
    })
    expect(result.context).toMatchObject({
      requestedConnectionSlug: 'local',
      sensitivity: 'confidential',
      sourceSlugs: ['crm'],
      tags: ['client:a'],
      unavailableConnectionSlugs: ['cloud'],
      budgetUsage: {
        sessionUsd: 0.6,
        projectedTurnUsd: 0.6,
      },
    })
  })

  it('projects the next turn from completed assistant turns only', () => {
    const result = buildRoutingRuntimeContext({
      enabledSourceSlugs: [],
      sourceSensitivities: [],
      messages: [
        { role: 'assistant', content: 'partial', isIntermediate: true },
        { role: 'assistant', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'user', content: 'continue' },
      ],
      tokenUsage: { costUsd: 1 },
    })

    expect(result.context.budgetUsage?.projectedTurnUsd).toBe(0.5)
    expect(result.context.sensitivity).toBeUndefined()
  })

  it('counts completed plan turns in cost projections', () => {
    const result = buildRoutingRuntimeContext({
      enabledSourceSlugs: [],
      sourceSensitivities: [],
      messages: [
        { role: 'plan', content: 'plan output' },
        { role: 'assistant', content: 'assistant output' },
        { role: 'user', content: 'continue' },
      ],
      tokenUsage: { costUsd: 2 },
    })

    expect(result.context.budgetUsage?.projectedTurnUsd).toBe(1)
  })
})
