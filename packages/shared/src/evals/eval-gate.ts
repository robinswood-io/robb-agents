import { createHash } from 'node:crypto';

export type EvalCategory =
  | 'tool-use'
  | 'policy'
  | 'factuality'
  | 'confidentiality'
  | 'destructive-action'
  | 'provider-error';

export type EvalJsonValue =
  | string
  | number
  | boolean
  | null
  | EvalJsonValue[]
  | { [key: string]: EvalJsonValue };

export interface EvalTrajectoryExpectation {
  requiredTools?: string[];
  forbiddenTools?: string[];
  maxSteps?: number;
  requireSuccessfulTools?: boolean;
}

export interface EvalGradingSpec {
  requiredTerms?: string[];
  forbiddenTerms?: string[];
  expectedState?: Record<string, EvalJsonValue>;
  trajectory?: EvalTrajectoryExpectation;
}

export interface EvalCase {
  id: string;
  language: 'fr';
  category: EvalCategory;
  prompt: string;
  expectedBehavior: string;
  requiredTool?: string;
  grading?: EvalGradingSpec;
}

export type EvalGraderKind =
  | 'llm'
  | 'deterministic'
  | 'state'
  | 'trajectory'
  | 'custom';

export interface EvalGraderResult {
  graderId: string;
  kind: EvalGraderKind;
  passed: boolean;
  score: number;
  required: boolean;
  evidenceSummary: string;
}

export interface EvalCaseResult {
  caseId: string;
  category: EvalCategory;
  passed: boolean;
  policyCompliant: boolean;
  factualityScore: number;
  latencyMs: number;
  targetLatencyMs?: number;
  judgeLatencyMs?: number;
  costUsd: number | null;
  humanInterventionRequired: boolean;
  toolSucceeded?: boolean;
  destructiveActionSafe?: boolean;
  providerErrorRecovered?: boolean;
  repetition?: number;
  deterministicCriteriaPassed?: boolean;
  stateMatched?: boolean;
  trajectorySucceeded?: boolean;
  graderResults?: EvalGraderResult[];
  evidence: string[];
}

export interface EvalRuntimeVersions {
  model: string;
  prompt: string;
  router: string;
  connectors: Record<string, string>;
}

export interface EvalThresholds {
  schemaVersion: 1;
  version: string;
  minCases: number;
  minPassRate: number;
  minToolSuccessRate: number;
  minPolicyComplianceRate: number;
  minFactualityScore: number;
  maxP95LatencyMs: number;
  maxAverageCostUsd: number;
  maxHumanInterventionRate: number;
  minDestructiveActionSafetyRate: number;
  minProviderErrorRecoveryRate: number;
  maxPassRateRegression: number;
}

export interface EvalSummary {
  total: number;
  uniqueCases: number;
  averageRunsPerCase: number;
  passRate: number;
  passRateConfidence95: EvalConfidenceInterval;
  toolSuccessRate: number;
  policyComplianceRate: number;
  factualityScore: number;
  factualityConfidence95: EvalConfidenceInterval;
  p95LatencyMs: number;
  averageCostUsd: number;
  humanInterventionRate: number;
  destructiveActionSafetyRate: number;
  providerErrorRecoveryRate: number;
}

export interface EvalConfidenceInterval {
  lower: number;
  upper: number;
  confidence: 0.95;
  method: 'wilson' | 'normal-mean';
}

export interface EvalCaseAggregate {
  caseId: string;
  runs: number;
  passRate: number;
  passRateConfidence95: EvalConfidenceInterval;
  factualityScore: number;
  factualityConfidence95: EvalConfidenceInterval;
  p95LatencyMs: number;
  averageCostUsd: number;
}

export interface EvalReport {
  schemaVersion: 1;
  corpusId: string;
  corpusVersion: string;
  runId: string;
  createdAt: string;
  versions: EvalRuntimeVersions;
  fingerprint: string;
  results: EvalCaseResult[];
  summary: EvalSummary;
  aggregates: EvalCaseAggregate[];
}

export interface EvalGateResult {
  passed: boolean;
  failures: string[];
  report: EvalReport;
  baselineRunId?: string;
}

function rate(values: boolean[]): number {
  return values.length === 0 ? 1 : values.filter(Boolean).length / values.length;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function wilsonConfidenceInterval(
  successes: number,
  total: number,
): EvalConfidenceInterval {
  if (total <= 0) {
    return {
      lower: 0,
      upper: 1,
      confidence: 0.95,
      method: 'wilson',
    };
  }
  const boundedSuccesses = Math.min(total, Math.max(0, successes));
  const proportion = boundedSuccesses / total;
  const z = 1.959963984540054;
  const denominator = 1 + ((z * z) / total);
  const center = (proportion + ((z * z) / (2 * total))) / denominator;
  const margin = (
    z
    * Math.sqrt(
      (proportion * (1 - proportion) / total)
      + ((z * z) / (4 * total * total)),
    )
  ) / denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    confidence: 0.95,
    method: 'wilson',
  };
}

export function meanConfidenceInterval(
  values: number[],
): EvalConfidenceInterval {
  if (values.length === 0) {
    return {
      lower: 0,
      upper: 1,
      confidence: 0.95,
      method: 'normal-mean',
    };
  }
  const mean = average(values);
  if (values.length === 1) {
    return {
      lower: Math.max(0, mean),
      upper: Math.min(1, mean),
      confidence: 0.95,
      method: 'normal-mean',
    };
  }
  const variance = values.reduce(
    (sum, value) => sum + ((value - mean) ** 2),
    0,
  ) / (values.length - 1);
  const margin = 1.959963984540054 * Math.sqrt(variance / values.length);
  return {
    lower: Math.max(0, mean - margin),
    upper: Math.min(1, mean + margin),
    confidence: 0.95,
    method: 'normal-mean',
  };
}

export function evaluationFingerprint(versions: EvalRuntimeVersions): string {
  const connectors = Object.entries(versions.connectors)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => `${name}:${version}`)
    .join(',');
  return createHash('sha256')
    .update(`${versions.model}\u001f${versions.prompt}\u001f${versions.router}\u001f${connectors}`, 'utf8')
    .digest('hex');
}

export function summarizeEvalResults(results: EvalCaseResult[]): EvalSummary {
  const toolResults = results.flatMap((result) => result.toolSucceeded === undefined ? [] : [result.toolSucceeded]);
  const destructiveResults = results.flatMap((result) =>
    result.destructiveActionSafe === undefined ? [] : [result.destructiveActionSafe],
  );
  const providerResults = results.flatMap((result) =>
    result.providerErrorRecovered === undefined ? [] : [result.providerErrorRecovered],
  );
  const knownCosts = results.flatMap((result) => result.costUsd === null ? [] : [result.costUsd]);
  const uniqueCases = new Set(results.map((result) => result.caseId)).size;
  const passCount = results.filter((result) => result.passed).length;
  const factualityScores = results.map((result) => result.factualityScore);
  return {
    total: results.length,
    uniqueCases,
    averageRunsPerCase: uniqueCases === 0 ? 0 : results.length / uniqueCases,
    passRate: rate(results.map((result) => result.passed)),
    passRateConfidence95: wilsonConfidenceInterval(passCount, results.length),
    toolSuccessRate: rate(toolResults),
    policyComplianceRate: rate(results.map((result) => result.policyCompliant)),
    factualityScore: average(factualityScores),
    factualityConfidence95: meanConfidenceInterval(factualityScores),
    p95LatencyMs: percentile95(results.map((result) => result.latencyMs)),
    averageCostUsd: average(knownCosts),
    humanInterventionRate: rate(results.map((result) => result.humanInterventionRequired)),
    destructiveActionSafetyRate: rate(destructiveResults),
    providerErrorRecoveryRate: rate(providerResults),
  };
}

export function aggregateEvalResults(results: EvalCaseResult[]): EvalCaseAggregate[] {
  const grouped = new Map<string, EvalCaseResult[]>();
  for (const result of results) {
    const existing = grouped.get(result.caseId) ?? [];
    existing.push(result);
    grouped.set(result.caseId, existing);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseId, caseResults]) => {
      const passCount = caseResults.filter((result) => result.passed).length;
      const factualityScores = caseResults.map((result) => result.factualityScore);
      const knownCosts = caseResults.flatMap((result) =>
        result.costUsd === null ? [] : [result.costUsd],
      );
      return {
        caseId,
        runs: caseResults.length,
        passRate: rate(caseResults.map((result) => result.passed)),
        passRateConfidence95: wilsonConfidenceInterval(
          passCount,
          caseResults.length,
        ),
        factualityScore: average(factualityScores),
        factualityConfidence95: meanConfidenceInterval(factualityScores),
        p95LatencyMs: percentile95(caseResults.map((result) => result.latencyMs)),
        averageCostUsd: average(knownCosts),
      };
    });
}

export function createEvalReport(input: {
  corpusId: string;
  corpusVersion: string;
  runId: string;
  createdAt?: string;
  versions: EvalRuntimeVersions;
  results: EvalCaseResult[];
}): EvalReport {
  return {
    schemaVersion: 1,
    corpusId: input.corpusId,
    corpusVersion: input.corpusVersion,
    runId: input.runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    versions: input.versions,
    fingerprint: evaluationFingerprint(input.versions),
    results: input.results,
    summary: summarizeEvalResults(input.results),
    aggregates: aggregateEvalResults(input.results),
  };
}

export function evaluateEvalGate(
  report: EvalReport,
  thresholds: EvalThresholds,
  baseline?: EvalReport,
): EvalGateResult {
  const failures: string[] = [];
  const { summary } = report;
  const minimum = (name: string, value: number, threshold: number) => {
    if (value < threshold) failures.push(`${name} ${value.toFixed(4)} is below ${threshold.toFixed(4)}`);
  };
  const maximum = (name: string, value: number, threshold: number) => {
    if (value > threshold) failures.push(`${name} ${value.toFixed(4)} exceeds ${threshold.toFixed(4)}`);
  };
  if (summary.uniqueCases < thresholds.minCases) {
    failures.push(`cases ${summary.uniqueCases} is below ${thresholds.minCases}`);
  }
  minimum('passRate', summary.passRate, thresholds.minPassRate);
  minimum('toolSuccessRate', summary.toolSuccessRate, thresholds.minToolSuccessRate);
  minimum('policyComplianceRate', summary.policyComplianceRate, thresholds.minPolicyComplianceRate);
  minimum('factualityScore', summary.factualityScore, thresholds.minFactualityScore);
  maximum('p95LatencyMs', summary.p95LatencyMs, thresholds.maxP95LatencyMs);
  maximum('averageCostUsd', summary.averageCostUsd, thresholds.maxAverageCostUsd);
  maximum('humanInterventionRate', summary.humanInterventionRate, thresholds.maxHumanInterventionRate);
  minimum('destructiveActionSafetyRate', summary.destructiveActionSafetyRate, thresholds.minDestructiveActionSafetyRate);
  minimum('providerErrorRecoveryRate', summary.providerErrorRecoveryRate, thresholds.minProviderErrorRecoveryRate);
  if (baseline && baseline.summary.passRate - summary.passRate > thresholds.maxPassRateRegression) {
    failures.push(
      `passRate regression ${(baseline.summary.passRate - summary.passRate).toFixed(4)} exceeds ${thresholds.maxPassRateRegression.toFixed(4)}`,
    );
  }
  return {
    passed: failures.length === 0,
    failures,
    report,
    ...(baseline ? { baselineRunId: baseline.runId } : {}),
  };
}

export function shouldRunContinuousEvals(
  previous: EvalRuntimeVersions | null,
  next: EvalRuntimeVersions,
): boolean {
  return !previous || evaluationFingerprint(previous) !== evaluationFingerprint(next);
}

export function canActivateCanary(gate: EvalGateResult): {
  allowed: boolean;
  reason: string;
} {
  return gate.passed
    ? { allowed: true, reason: `Evaluation gate passed for ${gate.report.results.length} cases` }
    : { allowed: false, reason: `Evaluation gate failed: ${gate.failures.join('; ')}` };
}

export function exportEvalReportMarkdown(gate: EvalGateResult): string {
  const summary = gate.report.summary;
  return [
    `# Evaluation report — ${gate.report.corpusId}`,
    '',
    `- Run: \`${gate.report.runId}\``,
    `- Corpus: \`${gate.report.corpusVersion}\``,
    `- Fingerprint: \`${gate.report.fingerprint}\``,
    `- Model / prompt / router: \`${gate.report.versions.model}\` / \`${gate.report.versions.prompt}\` / \`${gate.report.versions.router}\``,
    `- Gate: **${gate.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '## Scores',
    '',
    `- Pass rate: ${(summary.passRate * 100).toFixed(1)}%`,
    `- Pass rate 95% CI: ${(summary.passRateConfidence95.lower * 100).toFixed(1)}–${(summary.passRateConfidence95.upper * 100).toFixed(1)}%`,
    `- Cases / runs: ${summary.uniqueCases} / ${summary.total}`,
    `- Tool success: ${(summary.toolSuccessRate * 100).toFixed(1)}%`,
    `- Policy compliance: ${(summary.policyComplianceRate * 100).toFixed(1)}%`,
    `- Factuality: ${(summary.factualityScore * 100).toFixed(1)}%`,
    `- p95 latency: ${summary.p95LatencyMs} ms`,
    `- Average cost: $${summary.averageCostUsd.toFixed(4)}`,
    `- Human intervention: ${(summary.humanInterventionRate * 100).toFixed(1)}%`,
    '',
    '## Blocking failures',
    '',
    ...(gate.failures.length ? gate.failures.map((failure) => `- ${failure}`) : ['- None']),
    '',
  ].join('\n');
}
