import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core/types'
import {
  applyRoutingCostMetaToLatestAssistantMessage,
  buildRoutingCostMeta,
  buildSessionRoutingAuditSummary,
  resolveRoutingCostOptions,
} from './routing-audit'

describe('buildRoutingCostMeta', () => {
  it('keeps source USD cost and produces EUR only with a sourced rate', () => {
    expect(buildRoutingCostMeta(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, contextTokens: 10, costUsd: 0.5 },
      {
        exchangeRate: {
          from: 'USD',
          to: 'EUR',
          rate: 0.9,
          asOf: '2026-07-23',
          source: 'ECB reference rate',
        },
        pricingCatalogVersion: 'sdk-catalog-2026-07-01',
      },
    )).toEqual({
      estimatedCostUsd: 0.5,
      estimatedCostEur: 0.45,
      tokenUsageSource: 'sdk',
      costProvenance: {
        schemaVersion: 1,
        source: 'sdk',
        sourceCurrency: 'USD',
        pricingCatalogVersion: 'sdk-catalog-2026-07-01',
        displayCurrency: 'EUR',
        exchangeRate: 0.9,
        exchangeRateAsOf: '2026-07-23',
        exchangeRateSource: 'ECB reference rate',
      },
    })
  })

  it('never invents an EUR value when conversion is absent', () => {
    expect(buildRoutingCostMeta({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      contextTokens: 10,
      costUsd: 0.5,
    })).toEqual({
      estimatedCostUsd: 0.5,
      tokenUsageSource: 'sdk',
      costProvenance: {
        schemaVersion: 1,
        source: 'sdk',
        sourceCurrency: 'USD',
      },
    })
  })

  it('marks unavailable when no sourced cost exists', () => {
    expect(buildRoutingCostMeta({ inputTokens: 10, outputTokens: 5, totalTokens: 15, contextTokens: 10, costUsd: 0 })).toEqual({
      tokenUsageSource: 'unavailable',
      costProvenance: { schemaVersion: 1, source: 'unavailable' },
    })
    expect(buildRoutingCostMeta(undefined)).toEqual({
      tokenUsageSource: 'unavailable',
      costProvenance: { schemaVersion: 1, source: 'unavailable' },
    })
  })
})

describe('resolveRoutingCostOptions', () => {
  it('accepts only a complete, dated and sourced conversion', () => {
    expect(resolveRoutingCostOptions({
      ROBB_COST_USD_TO_EUR_RATE: '0.91',
      ROBB_COST_USD_TO_EUR_DATE: '2026-07-23',
      ROBB_COST_USD_TO_EUR_SOURCE: 'ECB reference rate',
      ROBB_PRICING_CATALOG_VERSION: 'sdk-catalog-2026-07-01',
    })).toEqual({
      exchangeRate: {
        from: 'USD',
        to: 'EUR',
        rate: 0.91,
        asOf: '2026-07-23',
        source: 'ECB reference rate',
      },
      pricingCatalogVersion: 'sdk-catalog-2026-07-01',
    })
  })

  it('fails closed for incomplete or invalid exchange-rate metadata', () => {
    expect(resolveRoutingCostOptions({
      ROBB_COST_USD_TO_EUR_RATE: '0.91',
      ROBB_COST_USD_TO_EUR_DATE: '2026-07-23',
    })).toEqual({})
    expect(resolveRoutingCostOptions({
      ROBB_COST_USD_TO_EUR_RATE: '-1',
      ROBB_COST_USD_TO_EUR_DATE: '23/07/2026',
      ROBB_COST_USD_TO_EUR_SOURCE: 'manual',
    })).toEqual({})
  })
})

describe('applyRoutingCostMetaToLatestAssistantMessage', () => {
  it('updates the latest final assistant message without touching intermediates', () => {
    const messages: Message[] = [
      { id: 'a1', role: 'assistant', content: 'draft', timestamp: 1, isIntermediate: true, routingMeta: { connectionSlug: 'draft' } },
      { id: 'a2', role: 'assistant', content: 'final', timestamp: 2, routingMeta: { connectionSlug: 'gemini' } },
    ]

    const updated = applyRoutingCostMetaToLatestAssistantMessage(messages, {
      estimatedCostUsd: 0.13,
      estimatedCostEur: 0.12,
      tokenUsageSource: 'sdk',
      costProvenance: { schemaVersion: 1, source: 'sdk', sourceCurrency: 'USD' },
    })

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
          estimatedCostUsd: 0.34, estimatedCostEur: 0.31, tokenUsageSource: 'sdk',
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
          estimatedCostUsd: 0.12, estimatedCostEur: 0.11, tokenUsageSource: 'sdk',
        },
      },
    ]

    expect(buildSessionRoutingAuditSummary(messages)).toEqual({
      totalEstimatedCostUsd: 0.46,
      totalEstimatedCostEur: 0.42,
      byConnectionSlug: {
        'souverain-standard': { turns: 2, estimatedCostUsd: 0.46, estimatedCostEur: 0.42 },
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
