import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MissionEvaluationCorpusSchema,
  MissionSpecSchema,
  type MissionAttemptTelemetry,
  type MissionEvaluationCorpus,
  type MissionEvaluationFault,
  type MissionEvaluationPromotionPolicy,
  type MissionEvaluationScenario,
  type MissionExecutionBinding,
  type MissionSpec,
  type StructuredMissionVerdict,
  type WorkSubmission,
} from '@craft-agent/shared/missions';
import { MissionController } from '../MissionController.ts';
import {
  MissionRuntime,
  type MissionExecutionInput,
  type MissionExecutionResult,
  type MissionWorkExecutor,
} from '../MissionRuntime.ts';
import {
  evaluateMissionJournal,
  type MissionEvaluationCheck,
  type MissionJournalEvaluation,
} from './MissionEvaluation.ts';

export interface MissionScenarioEvaluation {
  id: string;
  title: string;
  category: MissionEvaluationScenario['category'];
  passed: boolean;
  expectedStatus: MissionEvaluationScenario['expectedStatus'];
  observedStatus: MissionJournalEvaluation['status'];
  checks: MissionEvaluationCheck[];
  audit: MissionJournalEvaluation;
}

export interface MissionPromotionGate {
  id: string;
  passed: boolean;
  observed: number;
  operator: '>=' | '<=';
  threshold: number;
}

export interface MissionEvaluationCampaignReport {
  schemaVersion: 1;
  mode: 'deterministic-corpus';
  corpusVersion: 1;
  generatedAt: string;
  scenarios: MissionScenarioEvaluation[];
  kpis: {
    scenarioPassRate: number;
    expectedCompletionRate: number;
    correctionConvergenceRate: number;
    recoveryFidelityRate: number;
    telemetryCoverageRate: number;
    guardrailFailures: number;
    falseCompletions: number;
    duplicateDispatches: number;
    p95AttemptsPerScenario: number;
    p95DurationMsPerScenario: number;
    totalTokens: number;
    totalCostUsd: number;
  };
  promotion: {
    eligible: boolean;
    gates: MissionPromotionGate[];
  };
}

interface ScriptedExecution {
  itemId: string;
  kind: MissionExecutionInput['item']['kind'];
  dispatchId: string;
  role: MissionExecutionInput['profile']['role'];
}

function campaignTelemetry(input: MissionExecutionInput): MissionAttemptTelemetry {
  const review = input.item.kind === 'objective-review' || input.item.kind === 'final-review';
  const inputTokens = review ? 180 : 120;
  const outputTokens = review ? 70 : 50;
  return {
    durationMs: review ? 240 : 180,
    tokenUsage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      contextTokens: inputTokens,
      costUsd: review ? 0.0025 : 0.0015,
    },
  };
}

function submissionFor(input: MissionExecutionInput): WorkSubmission {
  return {
    summary: `${input.item.title} terminé`,
    outputRefs: [`artifact://${input.item.id}`],
    evidence: input.item.requiredEvidence.map((requirement) => ({
      requirementId: requirement.id,
      uri: `evidence://${input.item.id}/${requirement.id}`,
      kind: requirement.kind ?? 'other',
      description: requirement.description,
    })),
  };
}

function verdictFor(input: MissionExecutionInput, result: 'pass' | 'fail'): StructuredMissionVerdict {
  const targetType = input.item.kind === 'final-review' ? 'mission' : 'objective';
  const targetId = input.item.reviewTargetId!;
  const affected = result === 'fail'
    ? [input.upstream.find((candidate) => candidate.submission)?.workItemId].filter((id): id is string => Boolean(id))
    : [];
  if (result === 'fail' && affected.length === 0) {
    throw new Error(`Evaluation review ${input.item.id} has no executable work to reject`);
  }
  return {
    targetType,
    targetId,
    result,
    summary: result === 'pass' ? 'Tous les critères sont démontrés.' : 'Une correction vérifiable est nécessaire.',
    criteria: input.item.acceptanceCriteria.map((criterion, index) => ({
      criterionId: criterion.id,
      result: result === 'fail' && index === 0 ? 'fail' : 'pass',
      evidenceRefs: [`evidence://review/${input.item.id}/${criterion.id}`],
      explanation: result === 'pass' || index > 0 ? 'Preuve suffisante.' : 'Preuve volontairement rejetée par le scénario.',
    })),
    affectedWorkItemIds: affected,
    corrections: [],
  };
}

function faultKey(fault: MissionEvaluationFault): string {
  return 'itemId' in fault ? `${fault.kind}:${fault.itemId}` : fault.kind;
}

class CorpusExecutor implements MissionWorkExecutor {
  readonly prepared: string[] = [];
  readonly executed: ScriptedExecution[] = [];
  private readonly remaining = new Map<string, number>();

  constructor(private readonly scenario: MissionEvaluationScenario) {
    for (const fault of scenario.faults) {
      this.remaining.set(faultKey(fault), 'times' in fault ? fault.times : Number.POSITIVE_INFINITY);
    }
  }

  async prepare(input: MissionExecutionInput): Promise<MissionExecutionBinding> {
    this.prepared.push(input.item.id);
    return { executorKind: 'mission-eval', executionId: `execution-${input.dispatchId}` };
  }

  async execute(input: MissionExecutionInput): Promise<MissionExecutionResult> {
    this.executed.push({ itemId: input.item.id, kind: input.item.kind, dispatchId: input.dispatchId, role: input.profile.role });
    const telemetry = campaignTelemetry(input);
    const transientKey = `transient-failure:${input.item.id}`;
    if (this.consume(transientKey)) {
      return { status: 'failed', reason: 'Injected transient provider failure', retryable: true, telemetry };
    }
    if (this.remaining.has(`ambiguous-mutation:${input.item.id}`)) {
      return {
        status: 'failed',
        reason: 'Injected ambiguous mutation outcome',
        retryable: true,
        ambiguousMutation: true,
        telemetry,
      };
    }
    if (this.remaining.has(`missing-evidence:${input.item.id}`)) {
      return { status: 'failed', reason: 'Required evidence was not produced', retryable: true, telemetry };
    }
    if (input.item.kind === 'objective-review') {
      return { status: 'verdict', verdict: verdictFor(input, this.consume('reject-objective') ? 'fail' : 'pass'), telemetry };
    }
    if (input.item.kind === 'final-review') {
      return { status: 'verdict', verdict: verdictFor(input, this.consume('reject-final') ? 'fail' : 'pass'), telemetry };
    }
    return { status: 'submission', submission: submissionFor(input), telemetry };
  }

  private consume(key: string): boolean {
    const remaining = this.remaining.get(key) ?? 0;
    if (remaining <= 0) return false;
    if (Number.isFinite(remaining)) this.remaining.set(key, remaining - 1);
    return true;
  }
}

function missionFor(scenario: MissionEvaluationScenario): MissionSpec {
  const externalMutation = scenario.faults.some((fault) =>
    fault.kind === 'ambiguous-mutation' && fault.itemId === 'task-build');
  return MissionSpecSchema.parse({
    schemaVersion: 2,
    id: scenario.id,
    title: scenario.title,
    objective: 'Produire et contrôler un livrable autonome de bout en bout.',
    acceptanceCriteria: [{ id: 'mission-verified', description: 'Le livrable final est complet et vérifié.' }],
    plannerSessionId: `planner-${scenario.id}`,
    originSessionId: `origin-${scenario.id}`,
    plannerProfileId: 'planner',
    defaultWorkerProfileId: 'worker',
    reviewerProfileId: 'reviewer',
    supervisorProfileId: 'supervisor',
    agentProfiles: [
      { id: 'planner', role: 'planner', specialty: 'décomposition', systemPrompt: 'Construire un graphe borné.' },
      { id: 'worker', role: 'worker', specialty: 'réalisation', systemPrompt: 'Produire des preuves concrètes.' },
      { id: 'reviewer', role: 'reviewer', specialty: 'contrôle objectif', systemPrompt: 'Contrôler indépendamment.' },
      { id: 'supervisor', role: 'supervisor', specialty: 'supervision finale', systemPrompt: 'Valider la mission entière.' },
    ],
    policy: {
      maxConcurrentAgents: 2,
      maxCorrectionCycles: scenario.maxCorrectionCycles ?? 2,
      maxWorkItems: 32,
      maxDepth: 4,
      maxTechnicalAttempts: scenario.maxTechnicalAttempts ?? 3,
    },
    workItems: [
      {
        id: 'objective-delivery',
        kind: 'objective',
        title: 'Livrer une solution contrôlée',
        acceptanceCriteria: [{ id: 'objective-verified', description: 'La réalisation et sa validation sont cohérentes.' }],
      },
      {
        id: 'task-build',
        kind: 'task',
        title: 'Produire le livrable',
        prompt: 'Réaliser le livrable et fournir sa preuve.',
        parentId: 'objective-delivery',
        objectiveId: 'objective-delivery',
        acceptanceCriteria: [{ id: 'build-ok', description: 'Le livrable est produit.' }],
        requiredEvidence: [{ id: 'build-proof', description: 'Preuve de production', kind: 'artifact' }],
        effect: externalMutation ? 'external-mutation' : 'read',
      },
      {
        id: 'task-validate',
        kind: 'subtask',
        title: 'Valider le livrable',
        prompt: 'Exécuter les contrôles indépendants du livrable.',
        parentId: 'task-build',
        objectiveId: 'objective-delivery',
        dependsOn: ['task-build'],
        acceptanceCriteria: [{ id: 'validation-ok', description: 'Les contrôles passent.' }],
        requiredEvidence: [{ id: 'test-proof', description: 'Résultat de contrôle', kind: 'test' }],
      },
    ],
  });
}

function scenarioCheck(
  id: string,
  passed: boolean,
  detail: string,
  observed?: number | string | boolean,
  expected?: number | string | boolean,
): MissionEvaluationCheck {
  return { id, passed, severity: 'gate', detail, ...(observed !== undefined ? { observed } : {}), ...(expected !== undefined ? { expected } : {}) };
}

async function runScenario(scenario: MissionEvaluationScenario): Promise<MissionScenarioEvaluation> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), `mission-eval-${scenario.id}-`));
  try {
    let tick = Date.parse('2026-08-19T08:00:00.000Z');
    const controller = new MissionController({ workspaceRoot, now: () => new Date(tick += 10) });
    controller.createMission(missionFor(scenario));
    const executor = new CorpusExecutor(scenario);
    if (scenario.recoveryPoint === 'reserved-dispatch') {
      controller.startMission(scenario.id);
      const dispatchId = `${scenario.id}-task-build-1`;
      controller.reserveWorkItem(scenario.id, 'task-build', {
        dispatchId,
        binding: { executorKind: 'mission-eval', executionId: `execution-${dispatchId}` },
      });
    }
    const runtime = new MissionRuntime({
      workspaceRoot,
      controller,
      executor,
      genDispatchId: (missionId, workItemId, attempt) => `${missionId}-${workItemId}-${attempt}`,
    });
    let settled = await runtime.runUntilSettled(scenario.id);
    if (settled.status === 'completed') {
      const reportId = `report-${scenario.id}`;
      const originSessionId = settled.spec.originSessionId!;
      controller.reserveMissionReport(scenario.id, reportId, originSessionId);
      controller.recordMissionReportAccepted(scenario.id, reportId, originSessionId, `request-${scenario.id}`);
      settled = controller.recordMissionReportDelivered(scenario.id, reportId, originSessionId, `response-${scenario.id}`);
      controller.recordMissionReportDelivered(scenario.id, reportId, originSessionId, `response-${scenario.id}`);
    }
    const audit = evaluateMissionJournal(workspaceRoot, scenario.id, {
      requireTelemetry: true,
      requireDeliveredReport: true,
    });
    const correctionCycles = Object.values(settled.correctionCycles).reduce((sum, cycles) => sum + cycles, 0);
    const checks: MissionEvaluationCheck[] = [
      ...audit.checks,
      scenarioCheck('expected-terminal-status', settled.status === scenario.expectedStatus, 'Le scénario atteint son état terminal attendu.', settled.status, scenario.expectedStatus),
      scenarioCheck('expected-correction-cycles', correctionCycles === scenario.expectedCorrectionCycles, 'Le nombre de cycles de correction correspond au scénario.', correctionCycles, scenario.expectedCorrectionCycles),
    ];
    for (const [itemId, expected] of Object.entries(scenario.expectedAttempts)) {
      const observed = settled.workItems[itemId]?.attempt ?? 0;
      checks.push(scenarioCheck(`expected-attempts:${itemId}`, observed === expected, `Le nombre de tentatives de ${itemId} est borné et attendu.`, observed, expected));
    }
    if (scenario.recoveryPoint === 'reserved-dispatch') {
      const recoveredWithoutPrepare = !executor.prepared.includes('task-build') &&
        executor.executed.some((execution) => execution.itemId === 'task-build' && execution.dispatchId === `${scenario.id}-task-build-1`);
      checks.push(scenarioCheck('reserved-dispatch-reused', recoveredWithoutPrepare, 'La reprise réutilise la réservation durable sans préparer un doublon.', recoveredWithoutPrepare, true));
    }
    return {
      id: scenario.id,
      title: scenario.title,
      category: scenario.category,
      passed: checks.every((candidate) => candidate.severity !== 'gate' || candidate.passed),
      expectedStatus: scenario.expectedStatus,
      observedStatus: settled.status,
      checks,
      audit,
    };
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function promotionGates(
  policy: MissionEvaluationPromotionPolicy,
  kpis: MissionEvaluationCampaignReport['kpis'],
): MissionPromotionGate[] {
  return [
    { id: 'scenario-pass-rate', observed: kpis.scenarioPassRate, operator: '>=', threshold: policy.minScenarioPassRate, passed: kpis.scenarioPassRate >= policy.minScenarioPassRate },
    { id: 'expected-completion-rate', observed: kpis.expectedCompletionRate, operator: '>=', threshold: policy.minExpectedCompletionRate, passed: kpis.expectedCompletionRate >= policy.minExpectedCompletionRate },
    { id: 'correction-convergence-rate', observed: kpis.correctionConvergenceRate, operator: '>=', threshold: policy.minCorrectionConvergenceRate, passed: kpis.correctionConvergenceRate >= policy.minCorrectionConvergenceRate },
    { id: 'recovery-fidelity-rate', observed: kpis.recoveryFidelityRate, operator: '>=', threshold: policy.minRecoveryFidelityRate, passed: kpis.recoveryFidelityRate >= policy.minRecoveryFidelityRate },
    { id: 'telemetry-coverage-rate', observed: kpis.telemetryCoverageRate, operator: '>=', threshold: policy.minTelemetryCoverageRate, passed: kpis.telemetryCoverageRate >= policy.minTelemetryCoverageRate },
    { id: 'guardrail-failures', observed: kpis.guardrailFailures, operator: '<=', threshold: policy.maxGuardrailFailures, passed: kpis.guardrailFailures <= policy.maxGuardrailFailures },
    { id: 'false-completions', observed: kpis.falseCompletions, operator: '<=', threshold: policy.maxFalseCompletions, passed: kpis.falseCompletions <= policy.maxFalseCompletions },
    { id: 'duplicate-dispatches', observed: kpis.duplicateDispatches, operator: '<=', threshold: policy.maxDuplicateDispatches, passed: kpis.duplicateDispatches <= policy.maxDuplicateDispatches },
  ];
}

export function loadMissionEvaluationCorpus(): MissionEvaluationCorpus {
  const raw: unknown = JSON.parse(readFileSync(new URL('./corpus.v1.json', import.meta.url), 'utf-8'));
  return MissionEvaluationCorpusSchema.parse(raw);
}

export async function runMissionEvaluationCampaign(
  corpus: MissionEvaluationCorpus = loadMissionEvaluationCorpus(),
): Promise<MissionEvaluationCampaignReport> {
  const parsed = MissionEvaluationCorpusSchema.parse(corpus);
  const scenarios = await Promise.all(parsed.scenarios.map(runScenario));
  const expectedCompletion = scenarios.filter((scenario) => scenario.expectedStatus === 'completed');
  const correction = scenarios.filter((scenario) => scenario.category === 'correction');
  const recovery = scenarios.filter((scenario) => scenario.category === 'recovery');
  const attempts = scenarios.map((scenario) => scenario.audit.metrics.attempts);
  const durations = scenarios.map((scenario) => scenario.audit.metrics.totalDurationMs);
  const totalAttempts = scenarios.reduce((sum, scenario) => sum + scenario.audit.metrics.attempts, 0);
  const totalMetered = scenarios.reduce((sum, scenario) => sum + scenario.audit.metrics.meteredAttempts, 0);
  const kpis: MissionEvaluationCampaignReport['kpis'] = {
    scenarioPassRate: ratio(scenarios.filter((scenario) => scenario.passed).length, scenarios.length),
    expectedCompletionRate: ratio(expectedCompletion.filter((scenario) => scenario.observedStatus === 'completed').length, expectedCompletion.length),
    correctionConvergenceRate: ratio(correction.filter((scenario) => scenario.observedStatus === 'completed' && scenario.passed).length, correction.length),
    recoveryFidelityRate: ratio(recovery.filter((scenario) => scenario.observedStatus === scenario.expectedStatus && scenario.passed).length, recovery.length),
    telemetryCoverageRate: ratio(totalMetered, totalAttempts),
    guardrailFailures: scenarios.reduce((sum, scenario) => sum + scenario.audit.checks.filter((candidate) => candidate.severity === 'gate' && !candidate.passed).length, 0),
    falseCompletions: scenarios.filter((scenario) => scenario.observedStatus === 'completed' && scenario.audit.checks.some((candidate) => candidate.id === 'completed-state-consistency' && !candidate.passed)).length,
    duplicateDispatches: scenarios.reduce((sum, scenario) => sum + scenario.audit.metrics.duplicateDispatches, 0),
    p95AttemptsPerScenario: p95(attempts),
    p95DurationMsPerScenario: p95(durations),
    totalTokens: scenarios.reduce((sum, scenario) => sum + scenario.audit.metrics.totalTokens, 0),
    totalCostUsd: scenarios.reduce((sum, scenario) => sum + scenario.audit.metrics.totalCostUsd, 0),
  };
  const gates = promotionGates(parsed.promotionPolicy, kpis);
  return {
    schemaVersion: 1,
    mode: 'deterministic-corpus',
    corpusVersion: 1,
    generatedAt: new Date().toISOString(),
    scenarios,
    kpis,
    promotion: { eligible: gates.every((gate) => gate.passed), gates },
  };
}

export function renderMissionEvaluationMarkdown(report: MissionEvaluationCampaignReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    '# Mission V2 — évaluation shadow-mode',
    '',
    `Décision de promotion: **${report.promotion.eligible ? 'ÉLIGIBLE' : 'REFUSÉE'}**`,
    '',
    `- Scénarios conformes: ${percent(report.kpis.scenarioPassRate)}`,
    `- Missions attendues complètes: ${percent(report.kpis.expectedCompletionRate)}`,
    `- Convergence après correction: ${percent(report.kpis.correctionConvergenceRate)}`,
    `- Fidélité de reprise: ${percent(report.kpis.recoveryFidelityRate)}`,
    `- Couverture télémétrie: ${percent(report.kpis.telemetryCoverageRate)}`,
    `- Violations bloquantes: ${report.kpis.guardrailFailures}`,
    `- Fausses réussites: ${report.kpis.falseCompletions}`,
    `- Dispatches dupliqués: ${report.kpis.duplicateDispatches}`,
    `- P95 tentatives/scénario: ${report.kpis.p95AttemptsPerScenario}`,
    `- P95 durée simulée/scénario: ${report.kpis.p95DurationMsPerScenario} ms`,
    `- Coût simulé total: $${report.kpis.totalCostUsd.toFixed(4)} (${report.kpis.totalTokens} jetons)`,
    '',
    '## Scénarios',
    '',
    ...report.scenarios.map((scenario) =>
      `- ${scenario.passed ? 'PASS' : 'FAIL'} — ${scenario.id}: attendu ${scenario.expectedStatus}, observé ${scenario.observedStatus}`),
    '',
    '## Seuils de promotion',
    '',
    ...report.promotion.gates.map((gate) =>
      `- ${gate.passed ? 'PASS' : 'FAIL'} — ${gate.id}: ${gate.observed} ${gate.operator} ${gate.threshold}`),
    '',
  ];
  return lines.join('\n');
}
