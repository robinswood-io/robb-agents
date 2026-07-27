import {
  ALL_ROUTING_CAPABILITIES,
  ALL_ROUTING_DIFFICULTIES,
  type RoutingCapability,
  type RoutingDifficulty,
} from './routing-policy.ts'

export type RoutingOutcomeStatus = 'success' | 'partial' | 'failure' | 'cancelled'

/**
 * Privacy-minimal observation emitted after a routed turn or evaluation case.
 * Prompt and response bodies are intentionally excluded.
 */
export interface RoutingOutcome {
  id: string
  connectionSlug: string
  difficulty: RoutingDifficulty
  status: RoutingOutcomeStatus
  durationMs: number
  timestamp?: string
  qualityScore?: number
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  retryCount?: number
  requiredCapabilities?: RoutingCapability[]
}

export interface RoutingOutcomeSummary {
  connectionSlug: string
  difficulty: RoutingDifficulty
  sampleCount: number
  successCount: number
  partialCount: number
  failureCount: number
  cancelledCount: number
  successRate: number
  successRateLowerBound: number
  effectiveCompletionRate: number
  averageQuality: number
  p95DurationMs: number
  averageCostUsd?: number
  averageTokens?: number
  averageRetries: number
}

export interface RoutingOutcomeWeights {
  quality: number
  reliability: number
  latency: number
  cost: number
}

export interface RoutingOutcomeAnalysisOptions {
  minSamples?: number
  weights?: Partial<RoutingOutcomeWeights>
}

export interface RoutingRecommendation {
  connectionSlug: string
  difficulty: RoutingDifficulty
  sampleCount: number
  eligible: boolean
  score: number
  confidenceFactor: number
  paretoDominated: boolean
  recommendedPriority?: number
  reason: string
}

export interface RoutingOutcomeAnalysis {
  summaries: RoutingOutcomeSummary[]
  recommendations: RoutingRecommendation[]
}

export interface RoutingOutcomeValidation {
  valid: boolean
  errors: string[]
}

const DEFAULT_WEIGHTS: RoutingOutcomeWeights = {
  quality: 0.4,
  reliability: 0.35,
  latency: 0.15,
  cost: 0.1,
}

const ROUTING_OUTCOME_STATUSES = new Set<RoutingOutcomeStatus>([
  'success',
  'partial',
  'failure',
  'cancelled',
])

function finiteNonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0)
}

export function validateRoutingOutcome(outcome: RoutingOutcome): RoutingOutcomeValidation {
  const errors: string[] = []
  if (!outcome.id.trim()) errors.push('id must be non-empty')
  if (!outcome.connectionSlug.trim()) errors.push('connectionSlug must be non-empty')
  if (!ALL_ROUTING_DIFFICULTIES.includes(outcome.difficulty)) {
    errors.push('difficulty must be simple, standard or complex')
  }
  if (!ROUTING_OUTCOME_STATUSES.has(outcome.status)) {
    errors.push('status must be success, partial, failure or cancelled')
  }
  if (
    outcome.requiredCapabilities
    && outcome.requiredCapabilities.some(
      (capability) => !ALL_ROUTING_CAPABILITIES.includes(capability),
    )
  ) {
    errors.push('requiredCapabilities contains an unsupported capability')
  }
  if (!Number.isFinite(outcome.durationMs) || outcome.durationMs < 0) {
    errors.push('durationMs must be a finite non-negative number')
  }
  if (
    outcome.qualityScore !== undefined
    && (!Number.isFinite(outcome.qualityScore) || outcome.qualityScore < 0 || outcome.qualityScore > 1)
  ) {
    errors.push('qualityScore must be between 0 and 1')
  }
  if (!finiteNonNegative(outcome.costUsd)) errors.push('costUsd must be a finite non-negative number')
  if (!finiteNonNegative(outcome.inputTokens)) errors.push('inputTokens must be a finite non-negative number')
  if (!finiteNonNegative(outcome.outputTokens)) errors.push('outputTokens must be a finite non-negative number')
  if (!finiteNonNegative(outcome.retryCount)) errors.push('retryCount must be a finite non-negative number')
  return { valid: errors.length === 0, errors }
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1)
  return sorted[index] ?? 0
}

function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total === 0) return 0
  const proportion = successes / total
  const zSquared = z * z
  const denominator = 1 + zSquared / total
  const centre = proportion + zSquared / (2 * total)
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * total)) / total,
  )
  return Math.max(0, (centre - margin) / denominator)
}

function observedQuality(outcome: RoutingOutcome): number {
  if (typeof outcome.qualityScore === 'number') return outcome.qualityScore
  if (outcome.status === 'success') return 1
  if (outcome.status === 'partial') return 0.5
  return 0
}

function groupKey(outcome: RoutingOutcome): string {
  return `${outcome.difficulty}\u0000${outcome.connectionSlug}`
}

export function summarizeRoutingOutcomes(outcomes: RoutingOutcome[]): RoutingOutcomeSummary[] {
  const groups = new Map<string, RoutingOutcome[]>()
  for (const outcome of outcomes) {
    const validation = validateRoutingOutcome(outcome)
    if (!validation.valid) {
      throw new Error(`Invalid routing outcome '${outcome.id}': ${validation.errors.join(', ')}`)
    }
    groups.set(groupKey(outcome), [...(groups.get(groupKey(outcome)) ?? []), outcome])
  }

  return [...groups.values()]
    .map((group): RoutingOutcomeSummary => {
      const first = group[0]
      if (!first) throw new Error('Routing outcome group cannot be empty')
      const successCount = group.filter((outcome) => outcome.status === 'success').length
      const partialCount = group.filter((outcome) => outcome.status === 'partial').length
      const failureCount = group.filter((outcome) => outcome.status === 'failure').length
      const cancelledCount = group.filter((outcome) => outcome.status === 'cancelled').length
      const costs = group.flatMap((outcome) => (
        typeof outcome.costUsd === 'number' ? [outcome.costUsd] : []
      ))
      const tokens = group.flatMap((outcome) => (
        typeof outcome.inputTokens === 'number' || typeof outcome.outputTokens === 'number'
          ? [(outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0)]
          : []
      ))
      return {
        connectionSlug: first.connectionSlug,
        difficulty: first.difficulty,
        sampleCount: group.length,
        successCount,
        partialCount,
        failureCount,
        cancelledCount,
        successRate: successCount / group.length,
        successRateLowerBound: wilsonLowerBound(successCount, group.length),
        effectiveCompletionRate: (successCount + partialCount * 0.5) / group.length,
        averageQuality: mean(group.map(observedQuality)),
        p95DurationMs: percentile(group.map((outcome) => outcome.durationMs), 0.95),
        ...(costs.length > 0 ? { averageCostUsd: mean(costs) } : {}),
        ...(tokens.length > 0 ? { averageTokens: mean(tokens) } : {}),
        averageRetries: mean(group.map((outcome) => outcome.retryCount ?? 0)),
      }
    })
    .sort((left, right) => (
      left.difficulty.localeCompare(right.difficulty)
      || left.connectionSlug.localeCompare(right.connectionSlug)
    ))
}

function normalizedWeights(input: Partial<RoutingOutcomeWeights> | undefined): RoutingOutcomeWeights {
  const weights = { ...DEFAULT_WEIGHTS, ...input }
  const entries = Object.entries(weights)
  if (entries.some(([, value]) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Routing outcome weights must be finite non-negative numbers')
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0)
  if (total <= 0) throw new Error('At least one routing outcome weight must be positive')
  return {
    quality: weights.quality / total,
    reliability: weights.reliability / total,
    latency: weights.latency / total,
    cost: weights.cost / total,
  }
}

function benefit(value: number, minimum: number, maximum: number): number {
  if (maximum === minimum) return 1
  return (value - minimum) / (maximum - minimum)
}

function inverseBenefit(value: number, minimum: number, maximum: number): number {
  return 1 - benefit(value, minimum, maximum)
}

function dominates(left: RoutingOutcomeSummary, right: RoutingOutcomeSummary): boolean {
  const leftCost = left.averageCostUsd ?? Number.POSITIVE_INFINITY
  const rightCost = right.averageCostUsd ?? Number.POSITIVE_INFINITY
  const atLeastAsGood = (
    left.averageQuality >= right.averageQuality
    && left.successRateLowerBound >= right.successRateLowerBound
    && left.p95DurationMs <= right.p95DurationMs
    && leftCost <= rightCost
  )
  const strictlyBetter = (
    left.averageQuality > right.averageQuality
    || left.successRateLowerBound > right.successRateLowerBound
    || left.p95DurationMs < right.p95DurationMs
    || leftCost < rightCost
  )
  return atLeastAsGood && strictlyBetter
}

export function analyzeRoutingOutcomes(
  outcomes: RoutingOutcome[],
  options: RoutingOutcomeAnalysisOptions = {},
): RoutingOutcomeAnalysis {
  const summaries = summarizeRoutingOutcomes(outcomes)
  const minSamples = options.minSamples ?? 10
  if (!Number.isInteger(minSamples) || minSamples <= 0) {
    throw new Error('minSamples must be a positive integer')
  }
  const weights = normalizedWeights(options.weights)
  const recommendations: RoutingRecommendation[] = []

  for (const difficulty of ['simple', 'standard', 'complex'] satisfies RoutingDifficulty[]) {
    const candidates = summaries.filter((summary) => summary.difficulty === difficulty)
    if (candidates.length === 0) continue
    const qualities = candidates.map((candidate) => candidate.averageQuality)
    const reliabilities = candidates.map((candidate) => candidate.successRateLowerBound)
    const latencies = candidates.map((candidate) => candidate.p95DurationMs)
    const finiteCosts = candidates
      .map((candidate) => candidate.averageCostUsd)
      .filter((value): value is number => typeof value === 'number')
    const minQuality = Math.min(...qualities)
    const maxQuality = Math.max(...qualities)
    const minReliability = Math.min(...reliabilities)
    const maxReliability = Math.max(...reliabilities)
    const minLatency = Math.min(...latencies)
    const maxLatency = Math.max(...latencies)
    const minCost = finiteCosts.length > 0 ? Math.min(...finiteCosts) : 0
    const maxCost = finiteCosts.length > 0 ? Math.max(...finiteCosts) : 0

    const scored = candidates.map((candidate) => {
      const confidenceFactor = Math.min(1, Math.sqrt(candidate.sampleCount / minSamples))
      const costScore = candidate.averageCostUsd === undefined
        ? 0
        : inverseBenefit(candidate.averageCostUsd, minCost, maxCost)
      const rawScore = (
        weights.quality * benefit(candidate.averageQuality, minQuality, maxQuality)
        + weights.reliability * benefit(candidate.successRateLowerBound, minReliability, maxReliability)
        + weights.latency * inverseBenefit(candidate.p95DurationMs, minLatency, maxLatency)
        + weights.cost * costScore
      )
      return {
        candidate,
        confidenceFactor,
        score: rawScore * confidenceFactor,
        eligible: candidate.sampleCount >= minSamples,
        paretoDominated: candidates.some((other) => other !== candidate && dominates(other, candidate)),
      }
    }).sort((left, right) => (
      Number(right.eligible) - Number(left.eligible)
      || Number(left.paretoDominated) - Number(right.paretoDominated)
      || right.score - left.score
      || left.candidate.connectionSlug.localeCompare(right.candidate.connectionSlug)
    ))

    let nextPriority = 1
    for (const item of scored) {
      const recommendedPriority = item.eligible && !item.paretoDominated
        ? nextPriority++
        : undefined
      recommendations.push({
        connectionSlug: item.candidate.connectionSlug,
        difficulty,
        sampleCount: item.candidate.sampleCount,
        eligible: item.eligible,
        score: item.score,
        confidenceFactor: item.confidenceFactor,
        paretoDominated: item.paretoDominated,
        ...(recommendedPriority ? { recommendedPriority } : {}),
        reason: !item.eligible
          ? `insufficient evidence: ${item.candidate.sampleCount}/${minSamples} samples`
          : item.paretoDominated
            ? 'dominated on quality, reliability, latency and observed cost'
            : `evidence-backed priority ${recommendedPriority}`,
      })
    }
  }

  return { summaries, recommendations }
}
