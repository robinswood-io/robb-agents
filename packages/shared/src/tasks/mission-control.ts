import { createHash } from 'node:crypto';
import type { TaskSpec } from './schema.ts';
import type { NodeOutput } from './refs.ts';
import type { RunLogEntry, NodeRunState } from './storage.ts';
import type {
  ExecutionProofVerificationDecision,
  SignedExecutionProof,
  TaskExecutionProofBinding,
} from '../governance/execution-proof.ts';

export type MissionBlockerStatus = 'open' | 'resolved';

export interface MissionBlocker {
  id: string;
  cause: string;
  owner: string;
  resolution: string;
  status: MissionBlockerStatus;
  nodeId?: string;
}

export interface MissionApproval {
  requestId: string;
  nodeId: string;
  reason: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  owner: string;
  status: 'pending' | 'approved' | 'rejected';
  actor?: string;
  comment?: string;
  requestedAt: string;
  resolvedAt?: string;
}

export type MissionEvaluationStatus = 'not-evaluated' | 'pending' | 'passing' | 'failing';

export interface MissionEvaluationReport {
  status: MissionEvaluationStatus;
  acceptance: 'not-evaluated' | 'pass' | 'fail' | 'unparsed';
  evaluatedNodes: number;
  successfulNodes: number;
  failedNodes: number;
  nodeSuccessRate?: number;
  safetyIssueCount: number;
  evidenceCount: number;
  failures: string[];
}

export interface MissionCostReport {
  status: 'untracked' | 'tracking' | 'within-budget' | 'warning' | 'exceeded';
  currency: 'USD' | 'EUR';
  used?: number;
  limit?: number;
  remaining?: number;
  percentUsed?: number;
  warningPercent: number;
}

export interface MissionControlSnapshot {
  schemaVersion: 1;
  missionId: string;
  runId: string;
  title: string;
  objective: string;
  status: 'not-started' | 'running' | 'paused' | 'waiting-approval' | 'verifying' | 'completed' | 'failed' | 'stopped';
  progress: {
    total: number;
    completed: number;
    failed: number;
    running: number;
    pending: number;
    percent: number;
  };
  budget: {
    maxTokens?: number;
    maxCost?: number;
    currency?: 'USD' | 'EUR';
    tokensUsed?: number;
    costUsed?: number;
  };
  evaluation: MissionEvaluationReport;
  cost: MissionCostReport;
  deadline?: string;
  approvals: MissionApproval[];
  blockers: MissionBlocker[];
  nextActions: string[];
  eventCount: number;
  latestEventAt?: string;
}

export interface MissionControlTelemetry {
  tokensUsed?: number;
  costUsed?: number;
  currency?: 'USD' | 'EUR';
  maxTokens?: number;
  maxCost?: number;
  warningPercent?: number;
}

export interface MissionReplayNodePlan {
  nodeId: string;
  action: 'reuse' | 'retry' | 'block';
  reason: string;
  effect: 'read' | 'workspace-write' | 'external-mutation';
}

export interface MissionReplayPlan {
  sourceRunId: string;
  safeByDefault: boolean;
  nodes: MissionReplayNodePlan[];
  requiresApproval: boolean;
  blockedNodeIds: string[];
}

function resolvedRunStatus(log: RunLogEntry[]): MissionControlSnapshot['status'] {
  let status: MissionControlSnapshot['status'] = log.length ? 'running' : 'not-started';
  for (const entry of log) {
    if (entry.kind === 'run-paused') status = 'paused';
    else if (entry.kind === 'run-resumed' || entry.kind === 'run-started') status = 'running';
    else if (entry.kind === 'run-verifying') status = 'verifying';
    else if (entry.kind === 'run-completed') status = 'completed';
    else if (entry.kind === 'run-failed') status = 'failed';
    else if (entry.kind === 'run-stopped' || entry.kind === 'kill-switch') status = 'stopped';
    else if (entry.kind === 'approval-requested') status = 'waiting-approval';
    else if (entry.kind === 'approval-resolved' && status === 'waiting-approval') {
      status = entry.decision === 'approved' ? 'running' : 'failed';
    }
  }
  return status;
}

function foldNodeStates(spec: TaskSpec, log: RunLogEntry[]): Map<string, NodeRunState> {
  const states = new Map<string, NodeRunState>(spec.nodes.map((node) => [node.id, 'pending']));
  for (const entry of log) {
    if (entry.kind === 'node-scheduled' || entry.kind === 'node-spawned') states.set(entry.nodeId, 'running');
    else if (entry.kind === 'node-finished') states.set(entry.nodeId, entry.state);
    else if (entry.kind === 'node-reused') states.set(entry.nodeId, 'done');
  }
  return states;
}

function foldApprovals(spec: TaskSpec, log: RunLogEntry[]): MissionApproval[] {
  const approvals = new Map<string, MissionApproval>();
  for (const entry of log) {
    if (entry.kind === 'approval-requested') {
      approvals.set(entry.requestId, {
        requestId: entry.requestId,
        nodeId: entry.nodeId,
        reason: entry.reason,
        impact: entry.impact,
        owner: entry.owner ?? spec.mission?.policy.validator ?? spec.mission?.policy.owner ?? 'operator',
        status: 'pending',
        requestedAt: entry.t,
      });
    } else if (entry.kind === 'approval-resolved') {
      const approval = approvals.get(entry.requestId);
      if (!approval) continue;
      approval.status = entry.decision;
      approval.actor = entry.actor;
      approval.comment = entry.comment;
      approval.resolvedAt = entry.t;
    }
  }
  return [...approvals.values()];
}

function blockerId(runId: string, nodeId: string, cause: string): string {
  return createHash('sha256').update(`${runId}:${nodeId}:${cause}`).digest('hex').slice(0, 16);
}

function foldBlockers(spec: TaskSpec, runId: string, log: RunLogEntry[], approvals: MissionApproval[]): MissionBlocker[] {
  const blockers: MissionBlocker[] = [];
  const resolvedApprovalIds = new Set(approvals.filter((a) => a.status !== 'pending').map((a) => a.requestId));
  for (const approval of approvals) {
    if (resolvedApprovalIds.has(approval.requestId)) continue;
    blockers.push({
      id: approval.requestId,
      nodeId: approval.nodeId,
      cause: approval.reason,
      owner: approval.owner,
      resolution: 'Approve or reject the pending high-impact action.',
      status: 'open',
    });
  }
  for (const entry of log) {
    if (entry.kind !== 'node-finished' || entry.state !== 'failed') continue;
    const cause = entry.reason ?? 'Node execution failed without a recorded reason.';
    blockers.push({
      id: blockerId(runId, entry.nodeId, cause),
      nodeId: entry.nodeId,
      cause,
      owner: spec.mission?.policy.owner ?? 'operator',
      resolution: 'Inspect the node output and retry from the last confirmed checkpoint.',
      status: 'open',
    });
  }
  const killSwitch = [...log].reverse().find((entry) => entry.kind === 'kill-switch');
  if (killSwitch?.kind === 'kill-switch') {
    blockers.push({
      id: blockerId(runId, 'mission', killSwitch.reason),
      cause: killSwitch.reason,
      owner: spec.mission?.policy.owner ?? 'workspace-owner',
      resolution: 'Clear the applicable kill switch, review impact, then resume explicitly.',
      status: 'open',
    });
  }
  const stagnation = [...log].reverse().find((entry) => entry.kind === 'stagnation-detected');
  if (stagnation?.kind === 'stagnation-detected') {
    blockers.push({
      id: blockerId(runId, 'mission', `${stagnation.fingerprint}:${stagnation.repetitions}`),
      cause: stagnation.reason,
      owner: spec.mission?.policy.owner ?? 'operator',
      resolution: 'Review the rejected evidence and change the task plan, tools, or acceptance criteria before retrying.',
      status: 'open',
    });
  }
  return blockers;
}

function buildMissionEvaluation(
  states: Map<string, NodeRunState>,
  log: RunLogEntry[],
): MissionEvaluationReport {
  const terminalStates = [...states.values()].filter((state) =>
    state === 'done' || state === 'skipped' || state === 'failed' || state === 'cancelled');
  const successfulNodes = terminalStates.filter((state) => state === 'done' || state === 'skipped').length;
  const failedNodes = terminalStates.filter((state) => state === 'failed' || state === 'cancelled').length;
  const verdicts = log.filter((entry): entry is Extract<RunLogEntry, { kind: 'verdict' }> => entry.kind === 'verdict');
  const latestVerdict = verdicts.at(-1);
  const safetyEntries = log.filter((entry) =>
    entry.kind === 'budget-breach' || entry.kind === 'deadline-breach' || entry.kind === 'kill-switch');
  const stagnationEntries = log.filter((entry) => entry.kind === 'stagnation-detected');
  const failures: string[] = [];

  if (latestVerdict?.result === 'fail' || latestVerdict?.result === 'unparsed') {
    failures.push(latestVerdict.reason ?? `Acceptance verdict: ${latestVerdict.result}`);
  }
  for (const entry of log) {
    if (entry.kind === 'node-finished' && (entry.state === 'failed' || entry.state === 'cancelled')) {
      failures.push(`${entry.nodeId}: ${entry.reason ?? `node ${entry.state}`}`);
    } else if (entry.kind === 'budget-breach') {
      failures.push(`Budget ${entry.metric} exceeded: ${entry.value} > ${entry.limit}`);
    } else if (entry.kind === 'deadline-breach') {
      failures.push(`Mission deadline breached: ${entry.deadline}`);
    } else if (entry.kind === 'kill-switch') {
      failures.push(`Kill switch (${entry.scope}): ${entry.reason}`);
    } else if (entry.kind === 'stagnation-detected') {
      failures.push(`Repair stagnated after ${entry.repetitions} repeated rejected results: ${entry.reason}`);
    }
  }

  let status: MissionEvaluationStatus = 'not-evaluated';
  if (latestVerdict?.result === 'pass' && failedNodes === 0 && safetyEntries.length === 0) {
    status = 'passing';
  } else if (
    latestVerdict?.result === 'fail'
    || latestVerdict?.result === 'unparsed'
    || failedNodes > 0
    || safetyEntries.length > 0
    || stagnationEntries.length > 0
  ) {
    status = 'failing';
  } else if (terminalStates.length > 0 || verdicts.length > 0) {
    status = 'pending';
  }

  return {
    status,
    acceptance: latestVerdict?.result ?? 'not-evaluated',
    evaluatedNodes: terminalStates.length,
    successfulNodes,
    failedNodes,
    ...(terminalStates.length > 0
      ? { nodeSuccessRate: Math.round((successfulNodes / terminalStates.length) * 1_000) / 10 }
      : {}),
    safetyIssueCount: safetyEntries.length,
    evidenceCount: terminalStates.length + verdicts.length + safetyEntries.length + stagnationEntries.length,
    failures: [...new Set(failures)],
  };
}

function buildMissionCostReport(
  currency: 'USD' | 'EUR' | undefined,
  used: number | undefined,
  limit: number | undefined,
  warningPercent: number,
): MissionCostReport {
  const resolvedCurrency = currency ?? 'USD';
  if (used == null) {
    return {
      status: 'untracked',
      currency: resolvedCurrency,
      ...(limit != null ? { limit } : {}),
      warningPercent,
    };
  }
  if (limit == null) {
    return {
      status: 'tracking',
      currency: resolvedCurrency,
      used,
      warningPercent,
    };
  }

  const percentUsed = limit === 0
    ? (used === 0 ? 0 : 100)
    : Math.round((used / limit) * 1_000) / 10;
  const remaining = Math.round((limit - used) * 10_000) / 10_000;
  const status: MissionCostReport['status'] = used > limit
    ? 'exceeded'
    : percentUsed >= warningPercent
      ? 'warning'
      : 'within-budget';
  return {
    status,
    currency: resolvedCurrency,
    used,
    limit,
    remaining,
    percentUsed,
    warningPercent,
  };
}

export function buildMissionControlSnapshot(
  spec: TaskSpec,
  runId: string,
  log: RunLogEntry[],
  telemetry: MissionControlTelemetry = {},
): MissionControlSnapshot {
  const states = foldNodeStates(spec, log);
  const approvals = foldApprovals(spec, log);
  const blockers = foldBlockers(spec, runId, log, approvals);
  const completed = [...states.values()].filter((state) => state === 'done' || state === 'skipped').length;
  const failed = [...states.values()].filter((state) => state === 'failed' || state === 'cancelled').length;
  const running = [...states.values()].filter((state) => state === 'running').length;
  const total = states.size;
  const nextActions: string[] = [];
  if (approvals.some((approval) => approval.status === 'pending')) nextActions.push('Resolve pending approval');
  if (failed > 0) nextActions.push('Review blockers and prepare a safe retry');
  if (log.some((entry) => entry.kind === 'stagnation-detected')) {
    nextActions.push('Change the repair plan before starting a new run');
  }
  if (resolvedRunStatus(log) === 'paused') nextActions.push('Resume mission');
  if (resolvedRunStatus(log) === 'running' && running === 0 && completed < total) nextActions.push('Run next ready node');
  if (nextActions.length === 0 && resolvedRunStatus(log) === 'completed') nextActions.push('Export mission report');
  const maxTokens = spec.mission?.budget?.max_tokens ?? spec.token_budget ?? telemetry.maxTokens;
  const maxCost = spec.mission?.budget?.max_cost ?? telemetry.maxCost;
  const currency = spec.mission?.budget?.currency ?? telemetry.currency ?? (maxCost != null ? 'USD' : undefined);
  const warningPercent = telemetry.warningPercent ?? 80;

  return {
    schemaVersion: 1,
    missionId: spec.id,
    runId,
    title: spec.title,
    objective: spec.goal,
    status: resolvedRunStatus(log),
    progress: {
      total,
      completed,
      failed,
      running,
      pending: Math.max(0, total - completed - failed - running),
      percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    },
    budget: {
      maxTokens,
      maxCost,
      currency,
      tokensUsed: telemetry.tokensUsed,
      costUsed: telemetry.costUsed,
    },
    evaluation: buildMissionEvaluation(states, log),
    cost: buildMissionCostReport(currency, telemetry.costUsed, maxCost, warningPercent),
    deadline: spec.mission?.deadline,
    approvals,
    blockers,
    nextActions,
    eventCount: log.length,
    latestEventAt: log.at(-1)?.t,
  };
}

export function planMissionReplay(
  spec: TaskSpec,
  sourceRunId: string,
  log: RunLogEntry[],
  loadOutput: (nodeId: string) => NodeOutput | null,
  options: {
    approveExternalMutations?: boolean;
    workspaceId?: string;
    verifyExecutionProof?: (
      proof: SignedExecutionProof,
      binding: TaskExecutionProofBinding,
    ) => ExecutionProofVerificationDecision;
  } = {},
): MissionReplayPlan {
  const confirmed = new Map<string, string | undefined>();
  const ambiguous = new Set<string>();
  const externalMutationIds = new Set(
    spec.nodes.filter((node) => node.effect === 'external-mutation').map((node) => node.id),
  );
  for (const entry of log) {
    if (entry.kind !== 'node-checkpoint') continue;
    if (entry.status === 'executing') ambiguous.add(entry.nodeId);
    else if (entry.status === 'confirmed') {
      if (externalMutationIds.has(entry.nodeId)) {
        const decision = entry.executionProof && options.workspaceId && options.verifyExecutionProof
          ? options.verifyExecutionProof(entry.executionProof, {
              workspaceId: options.workspaceId,
              missionId: spec.id,
              nodeId: entry.nodeId,
              idempotencyKey: entry.idempotencyKey,
            })
          : undefined;
        if (!decision?.allowed) {
          confirmed.delete(entry.nodeId);
          ambiguous.add(entry.nodeId);
          continue;
        }
      }
      ambiguous.delete(entry.nodeId);
      confirmed.set(entry.nodeId, entry.proofHash);
    }
  }
  const nodes = spec.nodes.map((node): MissionReplayNodePlan => {
    if (confirmed.has(node.id) && loadOutput(node.id)) {
      return { nodeId: node.id, action: 'reuse', reason: 'Confirmed output is reusable without executing the node.', effect: node.effect };
    }
    if (ambiguous.has(node.id)) {
      return {
        nodeId: node.id,
        action: 'block',
        reason: 'Execution began but was not confirmed; provider state must be reconciled first.',
        effect: node.effect,
      };
    }
    if (node.effect === 'external-mutation' && !options.approveExternalMutations) {
      return {
        nodeId: node.id,
        action: 'block',
        reason: 'External mutations are disabled for replay until explicitly approved.',
        effect: node.effect,
      };
    }
    return { nodeId: node.id, action: 'retry', reason: 'No confirmed output is available.', effect: node.effect };
  });
  const blockedNodeIds = nodes.filter((node) => node.action === 'block').map((node) => node.nodeId);
  return {
    sourceRunId,
    safeByDefault: !options.approveExternalMutations,
    nodes,
    requiresApproval: nodes.some((node) => node.effect === 'external-mutation' && node.action !== 'reuse'),
    blockedNodeIds,
  };
}

export function exportMissionReportMarkdown(snapshot: MissionControlSnapshot): string {
  const costSummary = snapshot.cost.used == null
    ? `not tracked${snapshot.cost.limit != null ? ` (limit ${snapshot.cost.limit} ${snapshot.cost.currency})` : ''}`
    : `${snapshot.cost.used} ${snapshot.cost.currency}${snapshot.cost.limit != null ? ` / ${snapshot.cost.limit} ${snapshot.cost.currency}` : ''}`;
  const lines = [
    `# Mission report — ${snapshot.title}`,
    '',
    `- Mission: \`${snapshot.missionId}\``,
    `- Run: \`${snapshot.runId}\``,
    `- Status: ${snapshot.status}`,
    `- Progress: ${snapshot.progress.completed}/${snapshot.progress.total} (${snapshot.progress.percent}%)`,
    `- Objective: ${snapshot.objective}`,
    snapshot.deadline ? `- Deadline: ${snapshot.deadline}` : '',
    '',
    '## Evaluation',
    '',
    `- Status: ${snapshot.evaluation.status}`,
    `- Acceptance: ${snapshot.evaluation.acceptance}`,
    `- Node evidence: ${snapshot.evaluation.successfulNodes}/${snapshot.evaluation.evaluatedNodes} successful${snapshot.evaluation.nodeSuccessRate != null ? ` (${snapshot.evaluation.nodeSuccessRate}%)` : ''}`,
    `- Safety issues: ${snapshot.evaluation.safetyIssueCount}`,
    ...(snapshot.evaluation.failures.length
      ? snapshot.evaluation.failures.map((failure) => `- Failure: ${failure}`)
      : ['- Failures: None']),
    '',
    '## Cost',
    '',
    `- Status: ${snapshot.cost.status}`,
    `- Usage: ${costSummary}`,
    snapshot.cost.percentUsed != null ? `- Budget consumed: ${snapshot.cost.percentUsed}%` : '',
    snapshot.cost.remaining != null ? `- Remaining: ${snapshot.cost.remaining} ${snapshot.cost.currency}` : '',
    '',
    '## Blockers',
    '',
    ...(snapshot.blockers.length
      ? snapshot.blockers.map((blocker) => `- [${blocker.status}] ${blocker.cause} — owner: ${blocker.owner}; resolution: ${blocker.resolution}`)
      : ['- None']),
    '',
    '## Approvals',
    '',
    ...(snapshot.approvals.length
      ? snapshot.approvals.map((approval) => `- ${approval.requestId}: ${approval.status} (${approval.impact}) — ${approval.reason}`)
      : ['- None']),
    '',
    '## Next actions',
    '',
    ...(snapshot.nextActions.length ? snapshot.nextActions.map((action) => `- ${action}`) : ['- None']),
    '',
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}
