import type { z } from 'zod';
import type { MissionControlSnapshotDtoSchema, MissionReplayPlanDtoSchema, TaskResultsDtoSchema, DurableTaskSnapshotDtoSchema } from '../dto-contracts.ts';
import type { MissionDigitalTwinReport, MissionReplanPreview, MissionSnapshot, MissionSpec, MissionWorkItem, ProofPassportTrustAnchor, SignedProofPassport } from "../../missions";
import type { DurableTaskCockpitProjections, DurableTaskExternalRefs } from "../../tasks";
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

export type DurableTaskSnapshotDto = z.infer<typeof DurableTaskSnapshotDtoSchema>

export type DurableTaskCockpitProjectionsDto = DurableTaskCockpitProjections

export interface DurableTaskMetadataUpdateRequest {
  slug: string
  expectedRevision?: number
  archived?: boolean
  nextAction?: string | null
  externalRefs?: Partial<DurableTaskExternalRefs>
}

/** One subtask's outcome in a completed/persisted run, for the editor's Results tab. */
export type TaskResultNodeDto = z.infer<typeof TaskResultsDtoSchema>['nodes'][number]

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

export type MissionControlSnapshotDto = z.infer<typeof MissionControlSnapshotDtoSchema>

export type MissionReplayPlanDto = z.infer<typeof MissionReplayPlanDtoSchema>

/**
 * Storage-backed read of a task run's outcome — verdict + per-node final output, recovered from
 * the persisted run artifacts (run-log.jsonl, nodes/<id>.json, per-run spec.json snapshot). Unlike
 * `TaskRunSnapshotDto` this survives restart and does not require an active in-memory run.
 */
export type TaskResultsDto = z.infer<typeof TaskResultsDtoSchema>
