import { createHash } from 'node:crypto';
import {
  MissionSpecSchema,
  type MissionSpec,
  type MissionWorkItem,
} from './schema.ts';
import type { MissionSnapshot } from './events.ts';

export type MissionPreflightGateStatus = 'pass' | 'fail' | 'unknown';

export interface MissionRoutePreflight {
  policyAllowed: boolean;
  connectionSlug?: string;
  estimatedCostUsd?: number;
  explanation?: string;
}

export interface MissionConnectorPreflight {
  installed: boolean;
  contractTestsPassed: boolean;
  supportsIdempotency: boolean;
  supportsReconciliation: boolean;
  supportsCompensation: boolean;
  structuredEgressPolicyReady: boolean;
  approvalPathReady: boolean;
}

export interface MissionDigitalTwinInput {
  spec: MissionSpec;
  routeByProfileId?: Record<string, MissionRoutePreflight>;
  connectorByWorkItemId?: Record<string, MissionConnectorPreflight>;
  /** Remaining enforceable budget supplied by the host, never inferred by the model. */
  availableBudgetUsd?: number;
  /** Host estimate by executing work item. Missing estimates remain explicit unknowns. */
  estimatedCostUsdByWorkItemId?: Record<string, number>;
  pathPolicyAllowedByWorkItemId?: Record<string, boolean>;
  generatedAt?: string;
}

export interface MissionPreflightGate {
  id: string;
  category: 'graph' | 'route' | 'budget' | 'policy' | 'connector' | 'egress' | 'approval';
  status: MissionPreflightGateStatus;
  workItemId?: string;
  profileId?: string;
  detail: string;
}

export interface MissionDigitalTwinReport {
  schemaVersion: 1;
  mode: 'dry-run';
  mutationMode: 'forbidden';
  missionId: string;
  generatedAt: string;
  planFingerprint: string;
  readyToStart: boolean;
  projectedExternalMutations: number;
  projectedCostUsd?: number;
  budgetVarianceKnown: boolean;
  gates: MissionPreflightGate[];
}

/**
 * Pure Mission preflight. It accepts observations and returns data only: no
 * executor, connector, credential, transport or persistence callback exists in
 * its contract, so dry-run cannot perform a mutation.
 */
export function simulateMissionDigitalTwin(input: MissionDigitalTwinInput): MissionDigitalTwinReport {
  const spec = MissionSpecSchema.parse(input.spec);
  const gates: MissionPreflightGate[] = [{
    id: 'graph.valid', category: 'graph', status: 'pass', detail: 'Mission DAG and role invariants are valid',
  }];
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const deadline = spec.policy.deadline;
  gates.push({
    id: 'policy.deadline',
    category: 'policy',
    status: !deadline || Date.parse(generatedAt) < Date.parse(deadline) ? 'pass' : 'fail',
    detail: !deadline
      ? 'No mission deadline is configured'
      : `Mission deadline ${deadline} checked at ${generatedAt}`,
  });
  const executing = spec.workItems.filter((item) =>
    ['task', 'subtask', 'integration', 'correction'].includes(item.kind));
  const usedProfiles = new Set([
    ...executing.map((item) => item.agentProfileId ?? spec.defaultWorkerProfileId),
    // Objective and final reviews are controller-created after launch, but
    // their routes are still mandatory runtime dependencies of every Mission.
    spec.reviewerProfileId,
    spec.supervisorProfileId,
  ]);

  for (const profileId of [...usedProfiles].sort()) {
    const route = input.routeByProfileId?.[profileId];
    gates.push({
      id: `route.${profileId}`,
      category: 'route',
      profileId,
      status: !route ? 'unknown' : route.policyAllowed && !!route.connectionSlug ? 'pass' : 'fail',
      detail: !route
        ? 'No host routing simulation was supplied'
        : route.policyAllowed && route.connectionSlug
          ? `Hard policy allows ${route.connectionSlug}`
          : route.explanation ?? 'No policy-authorized route is available',
    });
  }

  for (const item of executing) {
    const pathAllowed = input.pathPolicyAllowedByWorkItemId?.[item.id];
    gates.push({
      id: `policy.path.${item.id}`,
      category: 'policy',
      workItemId: item.id,
      status: pathAllowed === undefined ? 'unknown' : pathAllowed ? 'pass' : 'fail',
      detail: pathAllowed === undefined
        ? 'Host path-policy simulation was not supplied'
        : pathAllowed ? 'Execution paths are policy-authorized' : 'An execution path is outside policy',
    });
    if (item.effect !== 'external-mutation') continue;
    const connector = input.connectorByWorkItemId?.[item.id];
    gates.push(...connectorGates(item.id, connector));
  }

  const estimates = executing.map((item) => input.estimatedCostUsdByWorkItemId?.[item.id]);
  const budgetVarianceKnown = estimates.every((value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const projectedCostUsd = budgetVarianceKnown
    ? (estimates as number[]).reduce((sum, value) => sum + value, 0)
    : undefined;
  const budget = input.availableBudgetUsd;
  const budgetInputValid = budget === undefined || (Number.isFinite(budget) && budget >= 0);
  if (!budgetInputValid) throw new Error('availableBudgetUsd must be a finite non-negative number');
  gates.push({
    id: 'budget.projected',
    category: 'budget',
    status: budget === undefined || projectedCostUsd === undefined
      ? 'unknown'
      : projectedCostUsd <= budget ? 'pass' : 'fail',
    detail: budget === undefined
      ? 'No enforceable remaining budget was supplied'
      : projectedCostUsd === undefined
        ? 'At least one work-item cost estimate is unavailable'
        : `Projected $${projectedCostUsd.toFixed(4)} against $${budget.toFixed(4)} remaining`,
  });

  return {
    schemaVersion: 1,
    mode: 'dry-run',
    mutationMode: 'forbidden',
    missionId: spec.id,
    generatedAt,
    planFingerprint: planFingerprint(spec.workItems),
    readyToStart: gates.every((gate) => gate.status === 'pass'),
    projectedExternalMutations: executing.filter((item) => item.effect === 'external-mutation').length,
    ...(projectedCostUsd === undefined ? {} : { projectedCostUsd }),
    budgetVarianceKnown,
    gates,
  };
}

function connectorGates(
  workItemId: string,
  connector: MissionConnectorPreflight | undefined,
): MissionPreflightGate[] {
  const checks: Array<[MissionPreflightGate['category'], string, keyof MissionConnectorPreflight, string]> = [
    ['connector', 'installed', 'installed', 'Connector pack is installed'],
    ['connector', 'contract', 'contractTestsPassed', 'Connector contract tests passed'],
    ['connector', 'idempotency', 'supportsIdempotency', 'Idempotent recovery is supported'],
    ['connector', 'reconciliation', 'supportsReconciliation', 'Post-mutation reconciliation is supported'],
    ['connector', 'compensation', 'supportsCompensation', 'Compensation is supported'],
    ['egress', 'structured-egress', 'structuredEgressPolicyReady', 'Structured egress policy is ready'],
    ['approval', 'approval-path', 'approvalPathReady', 'A host approval path is ready'],
  ];
  return checks.map(([category, suffix, field, detail]) => ({
    id: `${category}.${suffix}.${workItemId}`,
    category,
    workItemId,
    status: !connector ? 'unknown' : connector[field] ? 'pass' : 'fail',
    detail: !connector ? 'No host connector preflight was supplied' : connector[field] ? detail : `${detail}: unavailable`,
  }));
}

export interface MissionReplanPreviewInput {
  snapshot: MissionSnapshot;
  expectedRevision: number;
  currentPlanVersion: number;
  proposedWorkItems: MissionWorkItem[];
}

export interface MissionReplanPreview {
  schemaVersion: 1;
  missionId: string;
  baseRevision: number;
  previousPlanVersion: number;
  nextPlanVersion: number;
  previousFingerprint: string;
  proposedFingerprint: string;
  addedWorkItemIds: string[];
  removedWorkItemIds: string[];
  changedWorkItemIds: string[];
  invalidatedWorkItemIds: string[];
  preservedAcceptedWorkItemIds: string[];
}

/** Versioned, side-effect-free graph diff used before a journaled replan is accepted. */
export function previewMissionReplan(input: MissionReplanPreviewInput): MissionReplanPreview {
  if (input.snapshot.revision !== input.expectedRevision) {
    throw new Error(`Mission revision conflict: expected ${input.expectedRevision}, found ${input.snapshot.revision}`);
  }
  if (!Number.isInteger(input.currentPlanVersion) || input.currentPlanVersion < 1) {
    throw new Error('currentPlanVersion must be a positive integer');
  }
  const proposedSpec = MissionSpecSchema.parse({
    ...input.snapshot.spec,
    workItems: input.proposedWorkItems,
  });
  const previous = new Map(input.snapshot.spec.workItems.map((item) => [item.id, item]));
  const proposed = new Map(proposedSpec.workItems.map((item) => [item.id, item]));
  const added = [...proposed.keys()].filter((id) => !previous.has(id));
  const removed = [...previous.keys()].filter((id) => !proposed.has(id));
  const changed = [...proposed.entries()]
    .filter(([id, item]) => previous.has(id) && itemFingerprint(previous.get(id)!) !== itemFingerprint(item))
    .map(([id]) => id);
  const impacted = new Set([...removed, ...changed]);
  const combined = new Map([
    ...Object.values(input.snapshot.workItems).map((runtime) => [runtime.definition.id, runtime.definition] as const),
    ...proposed,
  ]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, item] of combined) {
      if (impacted.has(id)) continue;
      const references = [
        ...item.dependsOn,
        item.parentId,
        item.correctsWorkItemId,
        item.reviewTargetId,
      ].filter((value): value is string => !!value);
      if (references.some((reference) => impacted.has(reference))) {
        impacted.add(id);
        grew = true;
      }
    }
  }
  // An objective aggregate and its controller-owned reviews cease to be valid
  // when one of their executing inputs changes. Do not feed that aggregate
  // invalidation back into independent siblings: their accepted output remains
  // reusable unless their own dependency/containment lineage was affected.
  const invalidated = new Set(impacted);
  for (const id of impacted) {
    const objectiveId = combined.get(id)?.objectiveId;
    if (objectiveId) invalidated.add(objectiveId);
  }
  let invalidatedReviewsGrew = true;
  while (invalidatedReviewsGrew) {
    invalidatedReviewsGrew = false;
    for (const [id, item] of combined) {
      if (invalidated.has(id)) continue;
      const isDerivedReview = item.kind === 'objective-review' || item.kind === 'final-review';
      if (!isDerivedReview) continue;
      if (
        item.dependsOn.some((dependency) => invalidated.has(dependency))
        || (item.reviewTargetId ? invalidated.has(item.reviewTargetId) : false)
      ) {
        invalidated.add(id);
        invalidatedReviewsGrew = true;
      }
    }
  }
  const preservedAcceptedWorkItemIds = Object.values(input.snapshot.workItems)
    .filter((runtime) =>
      runtime.status === 'accepted'
      && proposed.has(runtime.definition.id)
      && !invalidated.has(runtime.definition.id)
      && itemFingerprint(runtime.definition) === itemFingerprint(proposed.get(runtime.definition.id)!))
    .map((runtime) => runtime.definition.id)
    .sort();
  const invalidatedWorkItemIds = Object.values(input.snapshot.workItems)
    .filter((runtime) => invalidated.has(runtime.definition.id))
    .map((runtime) => runtime.definition.id)
    .sort();

  return {
    schemaVersion: 1,
    missionId: input.snapshot.spec.id,
    baseRevision: input.snapshot.revision,
    previousPlanVersion: input.currentPlanVersion,
    nextPlanVersion: input.currentPlanVersion + 1,
    previousFingerprint: planFingerprint(input.snapshot.spec.workItems),
    proposedFingerprint: planFingerprint(proposedSpec.workItems),
    addedWorkItemIds: added.sort(),
    removedWorkItemIds: removed.sort(),
    changedWorkItemIds: changed.sort(),
    invalidatedWorkItemIds,
    preservedAcceptedWorkItemIds,
  };
}

export function planFingerprint(items: MissionWorkItem[]): string {
  return createHash('sha256')
    .update(canonicalJson([...items].sort((left, right) => left.id.localeCompare(right.id))))
    .digest('hex');
}

function itemFingerprint(item: MissionWorkItem): string {
  return createHash('sha256').update(canonicalJson(item)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}
