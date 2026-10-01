import {
  listMissionIds,
  loadMissionSnapshot,
  readMissionEvents,
  type MissionEvent,
  type MissionSnapshot,
} from '@craft-agent/shared/missions';

export type MissionEvaluationSeverity = 'gate' | 'diagnostic';

export interface MissionEvaluationCheck {
  id: string;
  passed: boolean;
  severity: MissionEvaluationSeverity;
  detail: string;
  observed?: number | string | boolean;
  expected?: number | string | boolean;
}

export interface MissionOperationalMetrics {
  workItemCount: number;
  attempts: number;
  correctionCycles: number;
  dispatches: number;
  duplicateDispatches: number;
  meteredAttempts: number;
  telemetryCoverageRate: number;
  totalDurationMs: number;
  totalTokens: number;
  totalCostUsd: number;
  requiredEvidence: number;
  suppliedEvidence: number;
}

export interface MissionJournalEvaluation {
  missionId: string;
  status: MissionSnapshot['status'] | 'journal-error';
  passed: boolean;
  checks: MissionEvaluationCheck[];
  metrics: MissionOperationalMetrics;
  error?: string;
}

export interface MissionWorkspaceEvaluation {
  schemaVersion: 1;
  mode: 'shadow-workspace';
  generatedAt: string;
  workspaceRoot: string;
  missions: MissionJournalEvaluation[];
  summary: {
    missionCount: number;
    passingMissions: number;
    guardrailFailures: number;
    telemetryCoverageRate: number;
    totalTokens: number;
    totalCostUsd: number;
  };
}

const EMPTY_METRICS: MissionOperationalMetrics = {
  workItemCount: 0,
  attempts: 0,
  correctionCycles: 0,
  dispatches: 0,
  duplicateDispatches: 0,
  meteredAttempts: 0,
  telemetryCoverageRate: 1,
  totalDurationMs: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  requiredEvidence: 0,
  suppliedEvidence: 0,
};

function check(
  id: string,
  passed: boolean,
  detail: string,
  observed?: MissionEvaluationCheck['observed'],
  expected?: MissionEvaluationCheck['expected'],
  severity: MissionEvaluationSeverity = 'gate',
): MissionEvaluationCheck {
  return { id, passed, severity, detail, ...(observed !== undefined ? { observed } : {}), ...(expected !== undefined ? { expected } : {}) };
}

function terminalAttemptCount(events: readonly MissionEvent[]): number {
  return events.filter((event) =>
    event.kind === 'work-item-submitted' ||
    event.kind === 'verdict-recorded' ||
    event.kind === 'work-item-attempt-failed').length;
}

function independentReviewViolations(snapshot: MissionSnapshot): string[] {
  const violations: string[] = [];
  const all = Object.values(snapshot.workItems);
  for (const review of all.filter((runtime) =>
    runtime.definition.kind === 'objective-review' || runtime.definition.kind === 'final-review')) {
    const reviewIdentities = new Set([...review.executionHistory, ...review.externalSessionHistory]);
    const forbidden = new Set<string>();
    if (snapshot.spec.originSessionId) forbidden.add(snapshot.spec.originSessionId);
    if (snapshot.spec.plannerSessionId) forbidden.add(snapshot.spec.plannerSessionId);
    for (const candidate of all) {
      if (candidate.definition.id === review.definition.id) continue;
      const inScope = review.definition.kind === 'final-review' ||
        (candidate.definition.objectiveId === review.definition.reviewTargetId &&
          ['task', 'subtask', 'integration', 'correction'].includes(candidate.definition.kind));
      if (!inScope) continue;
      candidate.executionHistory.forEach((id) => forbidden.add(id));
      candidate.externalSessionHistory.forEach((id) => forbidden.add(id));
    }
    const reused = [...reviewIdentities].find((id) => forbidden.has(id));
    if (reused) violations.push(`${review.definition.id}:${reused}`);
  }
  return violations;
}

function evidenceCoverage(snapshot: MissionSnapshot): { required: number; supplied: number; missing: string[] } {
  let required = 0;
  let supplied = 0;
  const missing: string[] = [];
  for (const runtime of Object.values(snapshot.workItems)) {
    if (!runtime.submission) continue;
    const suppliedIds = new Set(runtime.submission.evidence.map((evidence) => evidence.requirementId));
    for (const requirement of runtime.definition.requiredEvidence) {
      required += 1;
      if (suppliedIds.has(requirement.id)) supplied += 1;
      else missing.push(`${runtime.definition.id}:${requirement.id}`);
    }
  }
  return { required, supplied, missing };
}

function correctionLineageViolations(snapshot: MissionSnapshot): string[] {
  const violations: string[] = [];
  for (const runtime of Object.values(snapshot.workItems)) {
    if (runtime.definition.kind !== 'correction') continue;
    const parentId = runtime.definition.correctsWorkItemId;
    const parent = parentId ? snapshot.workItems[parentId] : undefined;
    if (!parent || parent.definition.objectiveId !== runtime.definition.objectiveId) {
      violations.push(runtime.definition.id);
    }
  }
  return violations;
}

function completedStateViolations(snapshot: MissionSnapshot): string[] {
  if (snapshot.status !== 'completed') return [];
  const violations: string[] = [];
  const finalReviews = Object.values(snapshot.workItems).filter((runtime) => runtime.definition.kind === 'final-review');
  const acceptedFinal = finalReviews.find((runtime) => runtime.status === 'accepted' && runtime.verdict?.result === 'pass');
  if (!acceptedFinal) violations.push('missing-accepted-final-supervisor-verdict');
  for (const objective of Object.values(snapshot.workItems).filter((runtime) => runtime.definition.kind === 'objective')) {
    if (objective.status !== 'accepted') violations.push(`objective-not-accepted:${objective.definition.id}`);
  }
  return violations;
}

function roleRoutingViolations(snapshot: MissionSnapshot, events: readonly MissionEvent[]): string[] {
  const violations: string[] = [];
  for (const event of events) {
    if (event.kind !== 'work-item-dispatch-reserved') continue;
    const item = snapshot.workItems[event.workItemId]?.definition;
    if (!item) continue;
    const expected = item.kind === 'objective-review'
      ? snapshot.spec.reviewerProfileId
      : item.kind === 'final-review'
        ? snapshot.spec.supervisorProfileId
        : item.agentProfileId ?? snapshot.spec.defaultWorkerProfileId;
    if (event.agentProfileId !== expected) violations.push(`${event.workItemId}:${event.agentProfileId}`);
  }
  return violations;
}

function reportDeliveryViolations(snapshot: MissionSnapshot, events: readonly MissionEvent[]): string[] {
  if (snapshot.status !== 'completed' || !snapshot.spec.originSessionId) return [];
  const violations: string[] = [];
  const reservations = events.filter((event) => event.kind === 'mission-report-dispatch-reserved').length;
  const acceptances = events.filter((event) => event.kind === 'mission-report-turn-accepted').length;
  const deliveries = events.filter((event) => event.kind === 'mission-report-delivered').length;
  if (reservations !== 1) violations.push(`reservations:${reservations}`);
  if (acceptances !== 1) violations.push(`acceptances:${acceptances}`);
  if (deliveries !== 1) violations.push(`deliveries:${deliveries}`);
  if (snapshot.report?.status !== 'delivered') violations.push(`status:${snapshot.report?.status ?? 'missing'}`);
  return violations;
}

function operationalMetrics(snapshot: MissionSnapshot, events: readonly MissionEvent[]): MissionOperationalMetrics {
  const items = Object.values(snapshot.workItems);
  const reservations = events.filter((event) => event.kind === 'work-item-dispatch-reserved');
  const dispatchIds = reservations.map((event) => event.dispatchId);
  const duplicateDispatches = dispatchIds.length - new Set(dispatchIds).size;
  const telemetry = items.flatMap((runtime) => runtime.attemptTelemetry);
  const terminalAttempts = terminalAttemptCount(events);
  const evidence = evidenceCoverage(snapshot);
  return {
    workItemCount: items.length,
    attempts: items.reduce((sum, runtime) => sum + runtime.attempt, 0),
    correctionCycles: Object.values(snapshot.correctionCycles).reduce((sum, cycles) => sum + cycles, 0),
    dispatches: reservations.length,
    duplicateDispatches,
    meteredAttempts: telemetry.length,
    telemetryCoverageRate: terminalAttempts === 0 ? 1 : Math.min(1, telemetry.length / terminalAttempts),
    totalDurationMs: telemetry.reduce((sum, entry) => sum + entry.durationMs, 0),
    totalTokens: telemetry.reduce((sum, entry) => sum + (entry.tokenUsage?.totalTokens ?? 0), 0),
    totalCostUsd: telemetry.reduce((sum, entry) => sum + (entry.tokenUsage?.costUsd ?? 0), 0),
    requiredEvidence: evidence.required,
    suppliedEvidence: evidence.supplied,
  };
}

function activeAttemptsWithinCap(snapshot: MissionSnapshot): string[] {
  return Object.values(snapshot.workItems)
    .filter((runtime) => runtime.attempt > snapshot.spec.policy.maxTechnicalAttempts)
    .map((runtime) => `${runtime.definition.id}:${runtime.attempt}`);
}

export function evaluateMissionSnapshot(
  snapshot: MissionSnapshot,
  events: readonly MissionEvent[],
  options: { requireTelemetry?: boolean; requireDeliveredReport?: boolean } = {},
): MissionJournalEvaluation {
  const metrics = operationalMetrics(snapshot, events);
  const evidence = evidenceCoverage(snapshot);
  const independence = independentReviewViolations(snapshot);
  const lineage = correctionLineageViolations(snapshot);
  const completed = completedStateViolations(snapshot);
  const attemptCap = activeAttemptsWithinCap(snapshot);
  const routing = roleRoutingViolations(snapshot, events);
  const reportDelivery = reportDeliveryViolations(snapshot, events);
  const maxCycle = Math.max(0, ...Object.values(snapshot.correctionCycles));
  const checks = [
    check('unique-dispatch-identities', metrics.duplicateDispatches === 0, 'Chaque tentative doit avoir une identité de dispatch unique.', metrics.duplicateDispatches, 0),
    check('independent-review-sessions', independence.length === 0, independence.length === 0 ? 'Les contrôles sont indépendants des sessions de production.' : `Réutilisations détectées: ${independence.join(', ')}`, independence.length, 0),
    check('required-evidence-coverage', evidence.missing.length === 0, evidence.missing.length === 0 ? 'Toutes les preuves déclarées sont présentes.' : `Preuves manquantes: ${evidence.missing.join(', ')}`, evidence.supplied, evidence.required),
    check('correction-lineage', lineage.length === 0, lineage.length === 0 ? 'Toutes les corrections référencent un travail antérieur du même objectif.' : `Lignées invalides: ${lineage.join(', ')}`, lineage.length, 0),
    check('work-item-cap', metrics.workItemCount <= snapshot.spec.policy.maxWorkItems, 'Le graphe reste dans la borne maxWorkItems.', metrics.workItemCount, snapshot.spec.policy.maxWorkItems),
    check('correction-cap', maxCycle <= snapshot.spec.policy.maxCorrectionCycles, 'Les cycles de correction restent bornés.', maxCycle, snapshot.spec.policy.maxCorrectionCycles),
    check('technical-attempt-cap', attemptCap.length === 0, attemptCap.length === 0 ? 'Les tentatives techniques restent bornées.' : `Dépassements: ${attemptCap.join(', ')}`, attemptCap.length, 0),
    check('completed-state-consistency', completed.length === 0, completed.length === 0 ? 'Aucune réussite sans verdict final et objectifs acceptés.' : `Incohérences: ${completed.join(', ')}`, completed.length, 0),
    check('specialized-role-routing', routing.length === 0, routing.length === 0 ? 'Chaque réservation utilise le profil spécialisé attendu.' : `Routages invalides: ${routing.join(', ')}`, routing.length, 0),
    check(
      'origin-report-exactly-once',
      !options.requireDeliveredReport || reportDelivery.length === 0,
      reportDelivery.length === 0 ? 'Le rapport final est livré exactement une fois lorsque requis.' : `État du rapport: ${reportDelivery.join(', ')}`,
      reportDelivery.length,
      0,
      options.requireDeliveredReport ? 'gate' : 'diagnostic',
    ),
    check(
      'attempt-telemetry-coverage',
      !options.requireTelemetry || metrics.telemetryCoverageRate === 1,
      metrics.telemetryCoverageRate === 1 ? 'Chaque résultat de tentative est métrifié.' : 'Certains résultats de tentative ne sont pas métrifiés.',
      metrics.telemetryCoverageRate,
      1,
      options.requireTelemetry ? 'gate' : 'diagnostic',
    ),
  ];
  return {
    missionId: snapshot.spec.id,
    status: snapshot.status,
    passed: checks.every((candidate) => candidate.severity !== 'gate' || candidate.passed),
    checks,
    metrics,
  };
}

export function evaluateMissionJournal(
  workspaceRoot: string,
  missionId: string,
  options: { requireTelemetry?: boolean; requireDeliveredReport?: boolean } = {},
): MissionJournalEvaluation {
  try {
    const events = readMissionEvents(workspaceRoot, missionId);
    const snapshot = loadMissionSnapshot(workspaceRoot, missionId);
    if (!snapshot) throw new Error('Mission journal is empty');
    return evaluateMissionSnapshot(snapshot, events, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      missionId,
      status: 'journal-error',
      passed: false,
      error: message,
      checks: [check('journal-integrity', false, message, false, true)],
      metrics: { ...EMPTY_METRICS },
    };
  }
}

export function evaluateMissionWorkspace(workspaceRoot: string): MissionWorkspaceEvaluation {
  const missions = listMissionIds(workspaceRoot).map((missionId) =>
    evaluateMissionJournal(workspaceRoot, missionId, { requireTelemetry: false }));
  const totalTerminalAttempts = missions.reduce((sum, mission) => sum + mission.metrics.attempts, 0);
  const totalMeteredAttempts = missions.reduce((sum, mission) => sum + mission.metrics.meteredAttempts, 0);
  return {
    schemaVersion: 1,
    mode: 'shadow-workspace',
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    missions,
    summary: {
      missionCount: missions.length,
      passingMissions: missions.filter((mission) => mission.passed).length,
      guardrailFailures: missions.reduce((sum, mission) => sum + mission.checks.filter((candidate) => candidate.severity === 'gate' && !candidate.passed).length, 0),
      telemetryCoverageRate: totalTerminalAttempts === 0 ? 1 : Math.min(1, totalMeteredAttempts / totalTerminalAttempts),
      totalTokens: missions.reduce((sum, mission) => sum + mission.metrics.totalTokens, 0),
      totalCostUsd: missions.reduce((sum, mission) => sum + mission.metrics.totalCostUsd, 0),
    },
  };
}
