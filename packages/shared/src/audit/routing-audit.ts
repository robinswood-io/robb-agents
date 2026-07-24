import type { Message, RoutingMeta, TokenUsage } from '@craft-agent/core/types'

export interface RoutingExchangeRate {
  from: 'USD'
  to: 'EUR'
  rate: number
  asOf: string
  source: string
}

export interface RoutingCostOptions {
  exchangeRate?: RoutingExchangeRate
  pricingCatalogVersion?: string
}

type RoutingCostMeta = Pick<
  RoutingMeta,
  | 'estimatedCostUsd'
  | 'actualCostUsd'
  | 'estimatedCostEur'
  | 'actualCostEur'
  | 'costProvenance'
  | 'tokenUsageSource'
>

export interface SessionRoutingAuditSummary {
  totalEstimatedCostUsd?: number
  totalActualCostUsd?: number
  totalEstimatedCostEur?: number
  totalActualCostEur?: number
  byConnectionSlug: Record<string, {
    turns: number
    estimatedCostUsd?: number
    actualCostUsd?: number
    estimatedCostEur?: number
    actualCostEur?: number
  }>
  bySensitivity: Record<string, { turns: number }>
  policyRuleHits: Record<string, number>
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isValidExchangeRate(rate: RoutingExchangeRate | undefined): rate is RoutingExchangeRate {
  return Boolean(
    rate
    && Number.isFinite(rate.rate)
    && rate.rate > 0
    && isIsoDate(rate.asOf)
    && rate.source.trim().length > 0,
  )
}

/**
 * Resolve optional cost conversion from a process-like environment.
 *
 * EUR conversion is fail-closed: all rate metadata must be present and valid.
 * The source USD value remains available when conversion is not configured.
 */
export function resolveRoutingCostOptions(
  environment: Readonly<Record<string, string | undefined>>,
): RoutingCostOptions {
  const rawRate = environment.ROBB_COST_USD_TO_EUR_RATE?.trim()
  const asOf = environment.ROBB_COST_USD_TO_EUR_DATE?.trim()
  const source = environment.ROBB_COST_USD_TO_EUR_SOURCE?.trim()
  const pricingCatalogVersion = environment.ROBB_PRICING_CATALOG_VERSION?.trim()
  const rate = rawRate ? Number(rawRate) : Number.NaN

  const exchangeRate: RoutingExchangeRate | undefined =
    Number.isFinite(rate) && rate > 0 && asOf && isIsoDate(asOf) && source
      ? { from: 'USD', to: 'EUR', rate, asOf, source }
      : undefined

  return {
    ...(exchangeRate ? { exchangeRate } : {}),
    ...(pricingCatalogVersion ? { pricingCatalogVersion } : {}),
  }
}

export function buildRoutingCostMeta(
  usage: Partial<TokenUsage> | undefined,
  options: RoutingCostOptions = {},
): RoutingCostMeta {
  if (!usage) {
    return {
      tokenUsageSource: 'unavailable',
      costProvenance: { schemaVersion: 1, source: 'unavailable' },
    }
  }

  const costUsd = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)
    ? usage.costUsd
    : undefined

  if (costUsd !== undefined && costUsd > 0) {
    const exchangeRate = isValidExchangeRate(options.exchangeRate)
      ? options.exchangeRate
      : undefined

    return {
      estimatedCostUsd: roundCurrency(costUsd),
      ...(exchangeRate
        ? { estimatedCostEur: roundCurrency(costUsd * exchangeRate.rate) }
        : {}),
      tokenUsageSource: 'sdk',
      costProvenance: {
        schemaVersion: 1,
        source: 'sdk',
        sourceCurrency: 'USD',
        ...(options.pricingCatalogVersion
          ? { pricingCatalogVersion: options.pricingCatalogVersion }
          : {}),
        ...(exchangeRate
          ? {
              displayCurrency: 'EUR',
              exchangeRate: exchangeRate.rate,
              exchangeRateAsOf: exchangeRate.asOf,
              exchangeRateSource: exchangeRate.source,
            }
          : {}),
      },
    }
  }

  return {
    tokenUsageSource: 'unavailable',
    costProvenance: { schemaVersion: 1, source: 'unavailable' },
  }
}

export function applyRoutingCostMetaToLatestAssistantMessage(
  messages: Message[],
  costMeta: RoutingCostMeta,
): Message | undefined {
  const message = [...messages].reverse().find(candidate =>
    candidate.role === 'assistant' && !candidate.isIntermediate
  )
  if (!message) return undefined

  message.routingMeta = {
    ...(message.routingMeta ?? {}),
    ...costMeta,
  }
  return message
}

export function buildSessionRoutingAuditSummary(messages: Message[]): SessionRoutingAuditSummary {
  const summary: SessionRoutingAuditSummary = {
    byConnectionSlug: {},
    bySensitivity: {},
    policyRuleHits: {},
  }

  let totalEstimatedUsd = 0
  let hasEstimatedUsd = false
  let totalActualUsd = 0
  let hasActualUsd = false
  let totalEstimatedEur = 0
  let hasEstimatedEur = false
  let totalActualEur = 0
  let hasActualEur = false

  for (const message of messages) {
    if (message.role !== 'assistant' || message.isIntermediate || !message.routingMeta) continue
    const meta = message.routingMeta
    const connectionSlug = meta.connectionSlug ?? 'unknown'
    const byConnection = summary.byConnectionSlug[connectionSlug] ?? { turns: 0 }
    byConnection.turns += 1

    if (typeof meta.estimatedCostUsd === 'number') {
      byConnection.estimatedCostUsd = roundCurrency((byConnection.estimatedCostUsd ?? 0) + meta.estimatedCostUsd)
      totalEstimatedUsd += meta.estimatedCostUsd
      hasEstimatedUsd = true
    }
    if (typeof meta.actualCostUsd === 'number') {
      byConnection.actualCostUsd = roundCurrency((byConnection.actualCostUsd ?? 0) + meta.actualCostUsd)
      totalActualUsd += meta.actualCostUsd
      hasActualUsd = true
    }
    if (typeof meta.estimatedCostEur === 'number') {
      byConnection.estimatedCostEur = roundCurrency((byConnection.estimatedCostEur ?? 0) + meta.estimatedCostEur)
      totalEstimatedEur += meta.estimatedCostEur
      hasEstimatedEur = true
    }
    if (typeof meta.actualCostEur === 'number') {
      byConnection.actualCostEur = roundCurrency((byConnection.actualCostEur ?? 0) + meta.actualCostEur)
      totalActualEur += meta.actualCostEur
      hasActualEur = true
    }
    summary.byConnectionSlug[connectionSlug] = byConnection

    if (meta.sensitivity) {
      const bySensitivity = summary.bySensitivity[meta.sensitivity] ?? { turns: 0 }
      bySensitivity.turns += 1
      summary.bySensitivity[meta.sensitivity] = bySensitivity
    }

    for (const ruleId of meta.policyRuleIds ?? []) {
      summary.policyRuleHits[ruleId] = (summary.policyRuleHits[ruleId] ?? 0) + 1
    }
  }

  if (hasEstimatedUsd) summary.totalEstimatedCostUsd = roundCurrency(totalEstimatedUsd)
  if (hasActualUsd) summary.totalActualCostUsd = roundCurrency(totalActualUsd)
  if (hasEstimatedEur) summary.totalEstimatedCostEur = roundCurrency(totalEstimatedEur)
  if (hasActualEur) summary.totalActualCostEur = roundCurrency(totalActualEur)

  return summary
}
