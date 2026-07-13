import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core/types'
import {
  applyRoutingCostMetaToLatestAssistantMessage,
  buildRoutingCostMeta,
  buildSessionRoutingAuditSummary,
} from './routing-audit'

describe('buildRoutingCostMeta', () => {
  it('produces an estimated EUR cost from SDK token usage costUsd', () => {
    expect(buildRoutingCostMeta({ costUsd: 0.5 } as never, { usdToEur: 0.9 })).toEqual({
      estimatedCostEur: 0.45,
      tokenUsageSource: 'sdk',
    })
  })

  it('marks unavailable when no sourced cost exists', () => {
    expect(buildRoutingCostMeta({ inputTokens: 10, outputTokens: 5, totalTokens: 15, contextTokens: 10, costUsd: 0 })).toEqual({
      tokenUsageSource: 'unavailable',
    })
    expect(buildRoutingCostMeta(undefined)).toEqual({ tokenUsageSource: 'unavailable' })
  })
})

describe('applyRoutingCostMetaToLatestAssistantMessage', () => {
  it('updates the latest final assistant message without touching intermediates', () => {
    const messages: Message[] = [
      { id: 'a1', role: 'assistant', content: 'draft', timestamp: 1, isIntermediate: true, routingMeta: { connectionSlug: 'draft' } },
      { id: 'a2', role: 'assistant', content: 'final', timestamp: 2, routingMeta: { connectionSlug: 'gemini' } },
    ]

    const updated = applyRoutingCostMetaToLatestAssistantMessage(messages, { estimatedCostEur: 0.12, tokenUsageSource: 'sdk' })

    expect(updated?.id).toBe('a2')
    expect(messages[1]!.routingMeta).toMatchObject({ connectionSlug: 'gemini', estimatedCostEur: 0.12, tokenUsageSource: 'sdk' })
    expect(messages[0]!.routingMeta).toEqual({ connectionSlug: 'draft' })
  })
})

describe('buildSessionRoutingAuditSummary', () => {
  it('aggregates turns and estimated costs by connection, sensitivity and policy rules', () => {
    const messages: Message[] = [
      {
        id: 'm1', role: 'assistant', content: 'one', timestamp: 1,
        routingMeta: {
          connectionSlug: 'souverain-standard', sensitivity: 'confidential', policyRuleIds: ['confidential'],
          estimatedCostEur: 0.31, tokenUsageSource: 'sdk',
        },
      },
      {
        id: 'm2', role: 'assistant', content: 'two', timestamp: 2,
        routingMeta: {
          connectionSlug: 'local-rapide', sensitivity: 'confidential', policyRuleIds: ['confidential'],
          tokenUsageSource: 'unavailable',
        },
      },
      {
        id: 'm3', role: 'assistant', content: 'three', timestamp: 3,
        routingMeta: {
          connectionSlug: 'souverain-standard', sensitivity: 'internal', policyRuleIds: ['internal'],
          estimatedCostEur: 0.11, tokenUsageSource: 'sdk',
        },
      },
    ]

    expect(buildSessionRoutingAuditSummary(messages)).toEqual({
      totalEstimatedCostEur: 0.42,
      byConnectionSlug: {
        'souverain-standard': { turns: 2, estimatedCostEur: 0.42 },
        'local-rapide': { turns: 1 },
      },
      bySensitivity: {
        confidential: { turns: 2 },
        internal: { turns: 1 },
      },
      policyRuleHits: {
        confidential: 2,
        internal: 1,
      },
    })
  })

  it('does not confuse estimated and actual costs in export summaries', () => {
    const summary = buildSessionRoutingAuditSummary([
      {
        id: 'm1', role: 'assistant', content: 'one', timestamp: 1,
        routingMeta: { connectionSlug: 'provider', estimatedCostEur: 0.2, tokenUsageSource: 'sdk' },
      },
      {
        id: 'm2', role: 'assistant', content: 'two', timestamp: 2,
        routingMeta: { connectionSlug: 'provider', actualCostEur: 0.15, tokenUsageSource: 'provider' },
      },
    ])

    expect(summary.totalEstimatedCostEur).toBe(0.2)
    expect(summary.totalActualCostEur).toBe(0.15)
    expect(summary.byConnectionSlug.provider!.estimatedCostEur).toBe(0.2)
    expect(summary.byConnectionSlug.provider!.actualCostEur).toBe(0.15)
  })
})
