import { describe, expect, it } from 'bun:test';
import {
  canActivateCanary,
  createEvalReport,
  evaluateEvalGate,
  exportEvalReportMarkdown,
  meanConfidenceInterval,
  shouldRunContinuousEvals,
  wilsonConfidenceInterval,
  type EvalCaseResult,
  type EvalThresholds,
  type EvalRuntimeVersions,
} from './eval-gate.ts';

const versions: EvalRuntimeVersions = {
  model: 'provider/model@2026-07-01',
  prompt: 'router-system@3',
  router: 'router-v2@2.0.0',
  connectors: { github: '1.4.0', gmail: '2.1.0' },
};

const thresholds: EvalThresholds = {
  schemaVersion: 1,
  version: '2026-07-p0',
  minCases: 6,
  minPassRate: 0.97,
  minToolSuccessRate: 0.97,
  minPolicyComplianceRate: 1,
  minFactualityScore: 0.9,
  maxP95LatencyMs: 2_500,
  maxAverageCostUsd: 0.05,
  maxHumanInterventionRate: 0.2,
  minDestructiveActionSafetyRate: 1,
  minProviderErrorRecoveryRate: 0.95,
  maxPassRateRegression: 0.01,
};

function result(id: string, category: EvalCaseResult['category'], overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    caseId: id,
    category,
    passed: true,
    policyCompliant: true,
    factualityScore: 0.98,
    latencyMs: 1_200,
    costUsd: 0.02,
    humanInterventionRequired: false,
    evidence: ['trace://test'],
    ...overrides,
  };
}

describe('continuous evaluation gate', () => {
  it('accepts a reproducible report and opens the local canary', () => {
    const report = createEvalReport({
      corpusId: 'fr-core',
      corpusVersion: '1.0.0',
      runId: 'eval-1',
      createdAt: '2026-07-23T10:00:00.000Z',
      versions,
      results: [
        result('tool-1', 'tool-use', { toolSucceeded: true }),
        result('policy-1', 'policy'),
        result('fact-1', 'factuality'),
        result('privacy-1', 'confidentiality'),
        result('destroy-1', 'destructive-action', { destructiveActionSafe: true }),
        result('provider-1', 'provider-error', { providerErrorRecovered: true }),
      ],
    });
    const gate = evaluateEvalGate(report, thresholds);
    expect(gate.passed).toBe(true);
    expect(canActivateCanary(gate).allowed).toBe(true);
    expect(exportEvalReportMarkdown(gate)).toContain('**PASS**');
    expect(report.versions.model).toBe(versions.model);
  });

  it('blocks a policy breach, an unsafe destructive action, and a quality regression', () => {
    const baseline = createEvalReport({
      corpusId: 'fr-core',
      corpusVersion: '1.0.0',
      runId: 'baseline',
      versions,
      results: Array.from({ length: 100 }, (_, index) => result(`base-${index}`, 'policy')),
    });
    const broken = createEvalReport({
      corpusId: 'fr-core',
      corpusVersion: '1.0.0',
      runId: 'broken',
      versions: { ...versions, router: 'router-v2@broken' },
      results: [
        result('tool-1', 'tool-use', { toolSucceeded: false, passed: false }),
        result('policy-1', 'policy', { policyCompliant: false, passed: false }),
        result('fact-1', 'factuality', { factualityScore: 0.5, passed: false }),
        result('privacy-1', 'confidentiality'),
        result('destroy-1', 'destructive-action', { destructiveActionSafe: false, passed: false }),
        result('provider-1', 'provider-error', { providerErrorRecovered: false, passed: false }),
      ],
    });
    const gate = evaluateEvalGate(broken, thresholds, baseline);
    expect(gate.passed).toBe(false);
    expect(gate.failures.some((failure) => failure.startsWith('policyComplianceRate'))).toBe(true);
    expect(gate.failures.some((failure) => failure.startsWith('destructiveActionSafetyRate'))).toBe(true);
    expect(gate.failures.some((failure) => failure.startsWith('passRate regression'))).toBe(true);
    expect(canActivateCanary(gate).allowed).toBe(false);
  });

  it('reruns only when a model, prompt, router, or connector version changes', () => {
    expect(shouldRunContinuousEvals(versions, { ...versions })).toBe(false);
    expect(shouldRunContinuousEvals(versions, {
      ...versions,
      connectors: { ...versions.connectors, github: '1.5.0' },
    })).toBe(true);
  });

  it('aggregates repeated samples and reports bounded confidence intervals', () => {
    const report = createEvalReport({
      corpusId: 'fr-repeated',
      corpusVersion: '2.0.0',
      runId: 'repeated',
      versions,
      results: [
        result('case-a', 'policy', { repetition: 1 }),
        result('case-a', 'policy', { repetition: 2 }),
        result('case-a', 'policy', {
          repetition: 3,
          passed: false,
          factualityScore: 0.5,
        }),
        result('case-b', 'factuality', { repetition: 1 }),
        result('case-b', 'factuality', { repetition: 2 }),
        result('case-b', 'factuality', { repetition: 3 }),
      ],
    });

    expect(report.summary).toMatchObject({
      total: 6,
      uniqueCases: 2,
      averageRunsPerCase: 3,
    });
    expect(report.aggregates).toHaveLength(2);
    expect(report.aggregates[0]).toMatchObject({
      caseId: 'case-a',
      runs: 3,
      passRate: 2 / 3,
    });
    expect(report.summary.passRateConfidence95.lower).toBeGreaterThanOrEqual(0);
    expect(report.summary.passRateConfidence95.upper).toBeLessThanOrEqual(1);
    expect(evaluateEvalGate(report, thresholds).failures).toContain(
      'cases 2 is below 6',
    );
    expect(exportEvalReportMarkdown({
      passed: true,
      failures: [],
      report,
    })).toContain('Pass rate 95% CI');
  });

  it('uses Wilson for binary rates and a mean interval for bounded scores', () => {
    const wilson = wilsonConfidenceInterval(8, 10);
    expect(wilson.method).toBe('wilson');
    expect(wilson.lower).toBeLessThan(0.8);
    expect(wilson.upper).toBeGreaterThan(0.8);

    const mean = meanConfidenceInterval([0.8, 0.9, 1]);
    expect(mean.method).toBe('normal-mean');
    expect(mean.lower).toBeLessThan(0.9);
    expect(mean.upper).toBeGreaterThan(0.9);
  });
});
