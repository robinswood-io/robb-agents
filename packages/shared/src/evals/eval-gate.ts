import { createHash } from 'node:crypto';

export type EvalCategory =
  | 'tool-use'
  | 'policy'
  | 'factuality'
  | 'confidentiality'
  | 'destructive-action'
  | 'provider-error';

export interface EvalCase {
  id: string;
  language: 'fr';
  category: EvalCategory;
  prompt: string;
  expectedBehavior: string;
  requiredTool?: string;
}

export interface EvalCaseResult {
  caseId: string;
  category: EvalCategory;
  passed: boolean;
  policyCompliant: boolean;
  factualityScore: number;
  latencyMs: number;
  costUsd: number | null;
  humanInterventionRequired: boolean;
  toolSucceeded?: boolean;
  destructiveActionSafe?: boolean;
  providerErrorRecovered?: boolean;
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
  passRate: number;
  toolSuccessRate: number;
  policyComplianceRate: number;
  factualityScore: number;
  p95LatencyMs: number;
  averageCostUsd: number;
  humanInterventionRate: number;
  destructiveActionSafetyRate: number;
  providerErrorRecoveryRate: number;
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
  return {
    total: results.length,
    passRate: rate(results.map((result) => result.passed)),
    toolSuccessRate: rate(toolResults),
    policyComplianceRate: rate(results.map((result) => result.policyCompliant)),
    factualityScore: average(results.map((result) => result.factualityScore)),
    p95LatencyMs: percentile95(results.map((result) => result.latencyMs)),
    averageCostUsd: average(knownCosts),
    humanInterventionRate: rate(results.map((result) => result.humanInterventionRequired)),
    destructiveActionSafetyRate: rate(destructiveResults),
    providerErrorRecoveryRate: rate(providerResults),
  };
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
  if (summary.total < thresholds.minCases) failures.push(`cases ${summary.total} is below ${thresholds.minCases}`);
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
