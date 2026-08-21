import { describe, expect, it } from 'bun:test';
import { buildRoutingShadowReport } from './routing-shadow.ts';
import type { RoutingOutcome } from './routing-outcomes.ts';

function outcomes(slug: string, count: number, input: {
  durationMs: number; costUsd: number; failures?: number;
}): RoutingOutcome[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${slug}-${index}`,
    connectionSlug: slug,
    difficulty: 'standard',
    evidenceKind: 'eval',
    status: index < (input.failures ?? 0) ? 'failure' : 'success',
    qualityScore: index < (input.failures ?? 0) ? 0 : 1,
    durationMs: input.durationMs,
    costUsd: input.costUsd,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
}

describe('buildRoutingShadowReport', () => {
  it('qualifies a cheaper policy-safe route without mutating policy', () => {
    const report = buildRoutingShadowReport([
      ...outcomes('baseline', 500, { durationMs: 1_000, costUsd: 1 }),
      ...outcomes('candidate', 500, { durationMs: 900, costUsd: 0.70 }),
    ], {
      minSamples: 500,
      baselineByDifficulty: { standard: 'baseline' },
      policyEligibleConnectionSlugs: ['baseline', 'candidate'],
      now: '2026-08-20T10:00:00.000Z',
    });
    expect(report.mode).toBe('shadow');
    expect(report.automaticPolicyMutation).toBe(false);
    expect(report.promotionCandidates).toEqual([
      expect.objectContaining({
        proposedConnectionSlug: 'candidate', eligible: true, policySafe: true,
        costReduction: expect.closeTo(0.3),
      }),
    ]);
  });

  it('fails the promotion gate when hard policy excludes the route', () => {
    const report = buildRoutingShadowReport([
      ...outcomes('baseline', 500, { durationMs: 1_000, costUsd: 1 }),
      ...outcomes('candidate', 500, { durationMs: 700, costUsd: 0.6 }),
    ], {
      baselineByDifficulty: { standard: 'baseline' },
      policyEligibleConnectionSlugs: ['baseline'],
    });
    expect(report.promotionCandidates[0]).toMatchObject({ eligible: false, policySafe: false });
  });

  it('keeps low-sample recommendations ineligible', () => {
    const report = buildRoutingShadowReport([
      ...outcomes('baseline', 20, { durationMs: 1_000, costUsd: 1 }),
      ...outcomes('candidate', 20, { durationMs: 500, costUsd: 0.2 }),
    ], { minSamples: 500, baselineByDifficulty: { standard: 'baseline' } });
    expect(report.promotionCandidates).toEqual([]);
    expect(report.analysis.recommendations.every((item) => !item.eligible)).toBe(true);
  });

  it('never promotes from ungraded runtime completion signals', () => {
    const runtimeOnly = [
      ...outcomes('baseline', 500, { durationMs: 1_000, costUsd: 1 }),
      ...outcomes('candidate', 500, { durationMs: 400, costUsd: 0.2 }),
    ].map((entry) => ({ ...entry, evidenceKind: 'runtime' as const }));
    const report = buildRoutingShadowReport(runtimeOnly, {
      baselineByDifficulty: { standard: 'baseline' },
      policyEligibleConnectionSlugs: ['baseline', 'candidate'],
    });
    expect(report.sampleCount).toBe(1_000);
    expect(report.groundTruthSampleCount).toBe(0);
    expect(report.promotionCandidates).toEqual([]);
    expect(report.analysis.summaries).toEqual([]);
  });
});
