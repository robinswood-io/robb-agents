import type { Message, RoutingMeta, TokenUsage } from '@craft-agent/core/types'

const DEFAULT_USD_TO_EUR = 0.92

export interface SessionRoutingAuditSummary {
  totalEstimatedCostEur?: number
  totalActualCostEur?: number
  byConnectionSlug: Record<string, {
    turns: number
    estimatedCostEur?: number
    actualCostEur?: number
  }>
  bySensitivity: Record<string, { turns: number }>
  policyRuleHits: Record<string, number>
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

export function buildRoutingCostMeta(
  usage: Partial<TokenUsage> | undefined,
  options: { usdToEur?: number } = {},
): Pick<RoutingMeta, 'estimatedCostEur' | 'actualCostEur' | 'tokenUsageSource'> {
  if (!usage) return { tokenUsageSource: 'unavailable' }

  const costUsd = typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)
    ? usage.costUsd
    : undefined

  if (costUsd !== undefined && costUsd > 0) {
    return {
      estimatedCostEur: roundCurrency(costUsd * (options.usdToEur ?? DEFAULT_USD_TO_EUR)),
      tokenUsageSource: 'sdk',
    }
  }

  return { tokenUsageSource: 'unavailable' }
}

export function applyRoutingCostMetaToLatestAssistantMessage(
  messages: Message[],
  costMeta: Pick<RoutingMeta, 'estimatedCostEur' | 'actualCostEur' | 'tokenUsageSource'>,
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

  let totalEstimated = 0
  let hasEstimated = false
  let totalActual = 0
  let hasActual = false

  for (const message of messages) {
    if (message.role !== 'assistant' || message.isIntermediate || !message.routingMeta) continue
    const meta = message.routingMeta
    const connectionSlug = meta.connectionSlug ?? 'unknown'
    const byConnection = summary.byConnectionSlug[connectionSlug] ?? { turns: 0 }
    byConnection.turns += 1

    if (typeof meta.estimatedCostEur === 'number') {
      byConnection.estimatedCostEur = roundCurrency((byConnection.estimatedCostEur ?? 0) + meta.estimatedCostEur)
      totalEstimated += meta.estimatedCostEur
      hasEstimated = true
    }
    if (typeof meta.actualCostEur === 'number') {
      byConnection.actualCostEur = roundCurrency((byConnection.actualCostEur ?? 0) + meta.actualCostEur)
      totalActual += meta.actualCostEur
      hasActual = true
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

  if (hasEstimated) summary.totalEstimatedCostEur = roundCurrency(totalEstimated)
  if (hasActual) summary.totalActualCostEur = roundCurrency(totalActual)

  return summary
}
