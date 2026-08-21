import {
  analyzeRoutingOutcomes,
  type RoutingOutcome,
  type RoutingOutcomeAnalysis,
  type RoutingOutcomeSummary,
} from './routing-outcomes.ts';
import { ALL_ROUTING_DIFFICULTIES, type RoutingDifficulty } from './routing-policy.ts';

export interface RoutingShadowReportOptions {
  minSamples?: number;
  baselineByDifficulty?: Partial<Record<RoutingDifficulty, string>>;
  /** Connections that already passed hard privacy/capability policy. */
  policyEligibleConnectionSlugs?: string[];
  /** Optional stricter hard-policy eligibility resolved independently per difficulty. */
  policyEligibleByDifficulty?: Partial<Record<RoutingDifficulty, string[]>>;
  now?: string;
}

export interface RoutingShadowPromotionCandidate {
  difficulty: RoutingDifficulty;
  baselineConnectionSlug: string;
  proposedConnectionSlug: string;
  baselineSamples: number;
  proposedSamples: number;
  qualityDelta: number;
  costReduction?: number;
  latencyReduction: number;
  policySafe: boolean;
  eligible: boolean;
  gates: Array<{ id: string; passed: boolean; detail: string }>;
}

export interface RoutingShadowReport {
  schemaVersion: 1;
  mode: 'shadow';
  generatedAt: string;
  sampleCount: number;
  groundTruthSampleCount: number;
  minSamples: number;
  automaticPolicyMutation: false;
  analysis: RoutingOutcomeAnalysis;
  promotionCandidates: RoutingShadowPromotionCandidate[];
  driftWarnings: Array<{
    connectionSlug: string;
    difficulty: RoutingDifficulty;
    detail: string;
  }>;
}

const summaryKey = (difficulty: RoutingDifficulty, slug: string) => `${difficulty}\u0000${slug}`;

function reduction(baseline: number | undefined, proposed: number | undefined): number | undefined {
  if (baseline === undefined || proposed === undefined || baseline <= 0) return undefined;
  return (baseline - proposed) / baseline;
}

function driftWarnings(outcomes: RoutingOutcome[], minWindow = 20): RoutingShadowReport['driftWarnings'] {
  const groups = new Map<string, RoutingOutcome[]>();
  for (const outcome of outcomes) {
    const key = summaryKey(outcome.difficulty, outcome.connectionSlug);
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  const warnings: RoutingShadowReport['driftWarnings'] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    if (ordered.length < minWindow * 2) continue;
    const previous = ordered.slice(-minWindow * 2, -minWindow);
    const recent = ordered.slice(-minWindow);
    const completion = (values: RoutingOutcome[]) => values.reduce((sum, value) =>
      sum + (value.status === 'success' ? 1 : value.status === 'partial' ? 0.5 : 0), 0) / values.length;
    const previousCompletion = completion(previous);
    const recentCompletion = completion(recent);
    if (previousCompletion - recentCompletion >= 0.05) {
      warnings.push({
        connectionSlug: group[0]!.connectionSlug,
        difficulty: group[0]!.difficulty,
        detail: `effective completion fell by ${((previousCompletion - recentCompletion) * 100).toFixed(1)} points`,
      });
    }
  }
  return warnings;
}

/**
 * Produces recommendations only. It has no API capable of changing allow-lists,
 * priorities, connection profiles, or the active routing policy.
 */
export function buildRoutingShadowReport(
  outcomes: RoutingOutcome[],
  options: RoutingShadowReportOptions = {},
): RoutingShadowReport {
  const minSamples = options.minSamples ?? 500;
  // Success inferred from a provider stream is not a business-quality label.
  // Only deterministic/evaluated or Mission-verified outcomes may influence a
  // promotion candidate. Runtime data remains available for drift detection.
  const groundTruth = outcomes.filter((outcome) =>
    outcome.evidenceKind === 'eval' || outcome.evidenceKind === 'mission');
  const analysis = analyzeRoutingOutcomes(groundTruth, { minSamples });
  const summaries = new Map(analysis.summaries.map((summary) => [
    summaryKey(summary.difficulty, summary.connectionSlug), summary,
  ]));
  const promotionCandidates: RoutingShadowPromotionCandidate[] = [];

  for (const difficulty of ALL_ROUTING_DIFFICULTIES) {
    const baselineSlug = options.baselineByDifficulty?.[difficulty];
    if (!baselineSlug) continue;
    const recommendation = analysis.recommendations.find((candidate) =>
      candidate.difficulty === difficulty && candidate.recommendedPriority === 1);
    if (!recommendation || recommendation.connectionSlug === baselineSlug) continue;
    const baseline = summaries.get(summaryKey(difficulty, baselineSlug));
    const proposed = summaries.get(summaryKey(difficulty, recommendation.connectionSlug));
    if (!baseline || !proposed) continue;
    const eligibleForDifficulty = options.policyEligibleByDifficulty?.[difficulty]
      ?? options.policyEligibleConnectionSlugs;
    const policyEligible = eligibleForDifficulty
      ? new Set(eligibleForDifficulty)
      : undefined;
    promotionCandidates.push(candidate(difficulty, baseline, proposed, minSamples, policyEligible));
  }

  return {
    schemaVersion: 1,
    mode: 'shadow',
    generatedAt: options.now ?? new Date().toISOString(),
    sampleCount: outcomes.length,
    groundTruthSampleCount: groundTruth.length,
    minSamples,
    automaticPolicyMutation: false,
    analysis,
    promotionCandidates,
    driftWarnings: driftWarnings(outcomes),
  };
}

function candidate(
  difficulty: RoutingDifficulty,
  baseline: RoutingOutcomeSummary,
  proposed: RoutingOutcomeSummary,
  minSamples: number,
  policyEligible: Set<string> | undefined,
): RoutingShadowPromotionCandidate {
  const qualityDelta = proposed.averageQuality - baseline.averageQuality;
  const costReduction = reduction(baseline.averageCostUsd, proposed.averageCostUsd);
  const latencyReduction = reduction(baseline.p95DurationMs, proposed.p95DurationMs) ?? 0;
  const policySafe = !policyEligible || policyEligible.has(proposed.connectionSlug);
  const gates = [
    {
      id: 'evidence',
      passed: baseline.sampleCount >= minSamples && proposed.sampleCount >= minSamples,
      detail: `${baseline.sampleCount}/${proposed.sampleCount} baseline/proposed samples; ${minSamples} required`,
    },
    {
      id: 'quality',
      passed: qualityDelta >= -0.01,
      detail: `${(qualityDelta * 100).toFixed(2)} quality points`,
    },
    {
      id: 'efficiency',
      passed: (costReduction ?? Number.NEGATIVE_INFINITY) >= 0.25 || latencyReduction >= 0.20,
      detail: `${costReduction === undefined ? 'cost unavailable' : `${(costReduction * 100).toFixed(1)}% cost`}; ${(latencyReduction * 100).toFixed(1)}% latency`,
    },
    {
      id: 'hard-policy',
      passed: policySafe,
      detail: policySafe ? 'already eligible under hard policy' : 'not in the hard-policy eligible set',
    },
  ];
  return {
    difficulty,
    baselineConnectionSlug: baseline.connectionSlug,
    proposedConnectionSlug: proposed.connectionSlug,
    baselineSamples: baseline.sampleCount,
    proposedSamples: proposed.sampleCount,
    qualityDelta,
    ...(costReduction === undefined ? {} : { costReduction }),
    latencyReduction,
    policySafe,
    eligible: gates.every((gate) => gate.passed),
    gates,
  };
}
