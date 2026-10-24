import type { MissionDigitalTwinReport, MissionReplanPreview, MissionSnapshot, MissionSpec, MissionWorkItem, ProofPassportTrustAnchor, SignedProofPassport } from "../../missions";
import type { DurableTaskCockpitProjections, DurableTaskExternalRefs, DurableTaskSnapshot } from "../../tasks";
import type { OperationApprovalContext, OperationRiskLevel } from "../../governance/capability-broker";

// ---------------------------------------------------------------------------
// Missions v2 DTOs — durable goal / work-item / independent-review control.
// ---------------------------------------------------------------------------

export type MissionSnapshotDto = MissionSnapshot

export type MissionProofPassportDto = SignedProofPassport

export type MissionProofPassportTrustAnchorDto = ProofPassportTrustAnchor

export type MissionProofPassportVerificationDto =
  | { valid: true; passport: SignedProofPassport }
  | { valid: false; reason: string }

export interface MissionPlanRequest {
  goal: string
  originSessionId: string
  title?: string
  projectId?: string
  cwd?: string
  model?: string
  llmConnection?: string
  enabledSourceSlugs?: string[]
}

export interface MissionPlanAck {
  planRequestId: string
  missionId: string
  plannerSessionId: string
}

export interface MissionPlanIssueDto {
  path: string
  message: string
}

export interface MissionPlanResult extends MissionPlanAck {
  status: 'planned' | 'invalid' | 'failed' | 'pending'
  spec?: MissionSpec
  issues?: MissionPlanIssueDto[]
  raw?: string
  error?: string
}

export interface MissionCreateAndStartRequest {
  spec: MissionSpec
}

/** Client supplies only a Mission identity/spec; every policy observation is host-resolved. */
export type MissionPreflightRequest =
  | { missionId: string; spec?: never }
  | { missionId?: never; spec: MissionSpec }

export type MissionPreflightResult = MissionDigitalTwinReport

export interface MissionReplanPreviewRequest {
  missionId: string
  expectedRevision: number
  proposedWorkItems: MissionWorkItem[]
}

export interface MissionReplanRequest extends MissionReplanPreviewRequest {
  reason: string
}

export type MissionReplanPreviewDto = MissionReplanPreview

export interface MissionControlRequest {
  missionId: string
  reason: string
}

export interface MissionResumeRequest {
  missionId: string
}

/** Value-free durable approval request for one brokered connector mutation. */
export interface MissionConnectorApprovalRequestDto {
  workspaceId: string
  missionId: string
  workItemId: string
  approvalId: string
  requestHash: string
  operationId: string
  risk: OperationRiskLevel
  approvalContext: OperationApprovalContext
  expiresAt: string
}

export interface MissionConnectorApprovalDecisionRequest {
  missionId: string
  workItemId: string
  approvalId: string
  requestHash: string
  decision: 'approved' | 'denied'
}

export interface MissionConnectorApprovalRefreshRequest {
  missionId: string
  workItemId: string
}

export type DurableTaskSnapshotDto = DurableTaskSnapshot

export type DurableTaskCockpitProjectionsDto = DurableTaskCockpitProjections

export interface DurableTaskMetadataUpdateRequest {
  slug: string
  expectedRevision?: number
  archived?: boolean
  nextAction?: string | null
  externalRefs?: Partial<DurableTaskExternalRefs>
}

/** One subtask's outcome in a completed/persisted run, for the editor's Results tab. */
export interface TaskResultNodeDto {
  id: string
  title: string
  /** pending | running | done | failed | cancelled | skipped */
  state: string
  /** The child session that ran this node, recovered from the run log (drill-in link). */
  sessionId?: string
  /** The node's recorded final output text (from nodes/<id>.json), when present. */
  output?: string
  dependsOn?: string[]
  attempt?: number
  proofHash?: string
  evidenceRefs?: string[]
  repair?: { allowed: boolean; reason: string }
}

export interface MissionBlockerDto {
  id: string
  cause: string
  owner: string
  resolution: string
  status: 'open' | 'resolved'
  nodeId?: string
}

export interface MissionApprovalDto {
  requestId: string
  nodeId: string
  reason: string
  impact: 'low' | 'medium' | 'high' | 'critical'
  owner: string
  status: 'pending' | 'approved' | 'rejected'
  actor?: string
  comment?: string
  requestedAt: string
  resolvedAt?: string
}

export interface MissionControlSnapshotDto {
  schemaVersion: 1
  missionId: string
  runId: string
  title: string
  objective: string
  status: 'not-started' | 'running' | 'paused' | 'waiting-approval' | 'verifying' | 'completed' | 'failed' | 'stopped'
  progress: {
    total: number
    completed: number
    failed: number
    running: number
    pending: number
    percent: number
  }
  budget: {
    maxTokens?: number
    maxCost?: number
    currency?: 'USD' | 'EUR'
    tokensUsed?: number
    costUsed?: number
  }
  evaluation: {
    status: 'not-evaluated' | 'pending' | 'passing' | 'failing'
    acceptance: 'not-evaluated' | 'pass' | 'fail' | 'unparsed'
    evaluatedNodes: number
    successfulNodes: number
    failedNodes: number
    nodeSuccessRate?: number
    safetyIssueCount: number
    evidenceCount: number
    failures: string[]
  }
  cost: {
    status: 'untracked' | 'tracking' | 'within-budget' | 'warning' | 'exceeded'
    currency: 'USD' | 'EUR'
    used?: number
    limit?: number
    remaining?: number
    percentUsed?: number
    warningPercent: number
  }
  deadline?: string
  approvals: MissionApprovalDto[]
  blockers: MissionBlockerDto[]
  nextActions: string[]
  eventCount: number
  latestEventAt?: string
}

export interface MissionReplayPlanDto {
  sourceRunId: string
  safeByDefault: boolean
  nodes: Array<{
    nodeId: string
    action: 'reuse' | 'retry' | 'block'
    reason: string
    effect: 'read' | 'workspace-write' | 'external-mutation'
  }>
  requiresApproval: boolean
  blockedNodeIds: string[]
}

/**
 * Storage-backed read of a task run's outcome — verdict + per-node final output, recovered from
 * the persisted run artifacts (run-log.jsonl, nodes/<id>.json, per-run spec.json snapshot). Unlike
 * `TaskRunSnapshotDto` this survives restart and does not require an active in-memory run.
 */
export interface TaskResultsDto {
  slug: string
  /** The run inspected; null when the task has never been run. */
  runId: string | null
  /** All run ids for this task (newest last), for a run picker. */
  runIds: string[]
  /** The most recent verdict (kept for back-compat with single-verdict consumers). */
  verdict?: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }
  /** Every verdict in order (a FAIL→repair loop produces several), for the Results history view. */
  verdicts?: { result: 'pass' | 'fail' | 'unparsed'; reason?: string; nodes?: string[] }[]
  /** Repair-loop accounting: attempts consumed (= count of FAIL verdicts) and the resolved cap. */
  repair?: { used: number; max: number }
  /** Terminal run status recovered from the run-log (completed | failed | stopped | …). */
  runStatus?: string
  /** The run's acceptance criteria (from the per-run spec snapshot), shown above the verdict. */
  acceptanceCriteria?: string
  /** Mission-level operational projection, durable across application restarts. */
  controlRoom?: MissionControlSnapshotDto
  /** Fail-safe checkpoint replay plan; external mutations are blocked by default. */
  replayPlan?: MissionReplayPlanDto
  /** Portable, auditable Markdown report generated from the same durable projection. */
  reportMarkdown?: string
  /** Canonical durable work object rendered above the run-level evidence. */
  task?: DurableTaskSnapshotDto
  userEvidence?: {
    actionRequested: string
    actionAttempted: string[]
    mutationsApplied: string[]
    userVerification: string
    remainingLimitations: string[]
  }
  nodes: TaskResultNodeDto[]
}
