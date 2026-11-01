import type { z } from 'zod';
import type { TaskNodeRunStateDtoSchema, TaskRunSnapshotDtoSchema } from '../dto-contracts.ts';
import type { PermissionMode } from "../../agent/mode-types";
import type { DurableTaskSnapshotDto } from './missions.ts';

// ---------------------------------------------------------------------------
// Tasks (Conductor) DTOs — wire contract for the tasks:* channels.
// ---------------------------------------------------------------------------

export interface TaskValidationIssueDto {
  /** Dotted path into the spec, e.g. "nodes.design.depends_on". */
  path: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export interface TaskValidationResultDto {
  valid: boolean
  errors: TaskValidationIssueDto[]
  warnings: TaskValidationIssueDto[]
  /** Pre-flight estimate: total nodes and how many sessions a run would spawn. */
  estimate?: { nodeCount: number; sessionNodeCount: number }
}

export interface TaskCreateRequest {
  /** task.yaml source text (authoritative). */
  yaml: string
  /**
   * When this YAML was authored by a `tasks:generate` orchestrator, the id of that hidden
   * draft session. tasks:create promotes it in place (clears taskDraft, binds taskSlug)
   * instead of minting a second top-level session — preventing duplicate board tiles (#bug1).
   * Only honored when the draft is still unadopted and its slug matches; otherwise ignored.
   */
  orchestratorSessionId?: string
  /**
   * Edit-mode bind: the id of an existing, board-visible session (e.g. a quick-add tile) that the
   * user is saving this spec onto. tasks:create calls `bindExistingSessionToTask` and HARD-ERRORS
   * if the bind fails — it must never fall through to minting a fresh orchestrator (that would
   * leave a duplicate tile). Distinct from `orchestratorSessionId`, which adopts a hidden draft.
   */
  attachToExistingSession?: string
}

export interface TaskCreateResult {
  /** Empty string when validation failed — inspect `validation`. */
  slug: string
  /** The persistent parent/orchestrator session (author + final verifier). */
  orchestratorSessionId: string
  validation: TaskValidationResultDto
  /**
   * Resolved id of the reserved "Task" label applied to the orchestrator. May differ from the
   * literal 'task' (a user-owned label with that name forces a fresh slug like 'task-2'), so
   * navigation/filtering MUST use this id. Undefined when label application failed (fail-soft).
   */
  taskLabelId?: string
}

export interface TaskGenerateRequest {
  /** Natural-language goal the orchestrator turns into a task.yaml DAG. */
  goal: string
  /** Optional working title for the task / orchestrator session. */
  title?: string
  /** Optional model for the orchestrator session (defaults to the session default). */
  model?: string
  /** Optional working directory for the orchestrator session (defaults to project/workspace cwd). */
  cwd?: string
  /** Project to bind the draft orchestrator to, so it authors against the project's `<project_context>`. */
  projectId?: string
  /**
   * LLM connection slug that serves `model`. Required for non-default (e.g. pi/*) models — without it
   * the authoring turn can't resolve a backend and completes instantly with no output (invalid spec).
   */
  llmConnection?: string
  /** Task-level source slugs the draft orchestrator may author against (omitted → workspace default). */
  enabledSourceSlugs?: string[]
  /** Permission mode for the draft orchestrator, so its authoring turn matches the task's chosen
   *  autonomy from the start instead of running at the workspace default until adoption. */
  permissionMode?: PermissionMode
}

/**
 * Synchronous ack for `tasks:generate`. The orchestrator session is created immediately
 * (cheap) and returned right away; the authored spec arrives later via the `tasks:generated`
 * push event. This keeps the RPC well under the uniform client timeout even when authoring
 * takes longer than the request budget.
 */
export interface TaskGenerateAck {
  /** The persistent orchestrator session, reachable immediately so its work is never lost. */
  orchestratorSessionId: string
}

export interface TaskGenerateResult {
  /** The persistent orchestrator session that authored the spec (also handles revisions). */
  orchestratorSessionId: string
  /** Slug of the authored spec; empty when generation produced an invalid spec. */
  slug: string
  /** Parsed TaskSpec when valid (consumers cast to TaskSpec from @craft-agent/shared/tasks). */
  spec?: unknown
  /** The raw task.yaml the orchestrator produced — shown and editable in the editor. */
  yaml: string
  validation: TaskValidationResultDto
  /** Set when generation failed before producing a spec (e.g. orchestrator turn errored/timed out). */
  error?: string
}

export interface TaskRunRequest {
  slug: string
  runId?: string
  orchestratorSessionId?: string
  params?: Record<string, unknown>
}

export interface TaskRepairRequest {
  slug: string
  sourceRunId: string
  nodeIds: string[]
  runId?: string
  orchestratorSessionId?: string
  /** Required before a repair frontier may execute an external-mutation node. */
  approveExternalMutations?: boolean
}

export type TaskNodeRunStateDto = z.infer<typeof TaskNodeRunStateDtoSchema>

export type TaskRunSnapshotDto = z.infer<typeof TaskRunSnapshotDtoSchema>

export interface TaskApprovalRequestDto {
  requestId: string
  /** Durable task folder identifier; do not infer it from missionId. */
  slug: string
  missionId: string
  runId: string
  nodeId: string
  reason: string
  impact: 'low' | 'medium' | 'high' | 'critical'
  owner?: string
}

export interface TaskApprovalDecisionRequest {
  slug: string
  runId: string
  requestId: string
  decision: 'approved' | 'rejected'
  actor: string
  comment?: string
}

export interface TaskKillSwitchSnapshotDto {
  schemaVersion: 1
  generation: number
  global: boolean
  workspaceIds: readonly string[]
  missionIds: readonly string[]
  connectorIds: readonly string[]
  updatedAt?: string
  updatedBy?: string
  lastEventHash?: string
}

export interface TaskKillSwitchUpdateRequest {
  scope: 'global' | 'workspace' | 'mission' | 'connector'
  active: boolean
  id?: string
  reason: string
  expectedGeneration?: number
}

export interface TaskGetResult {
  slug: string
  validation: TaskValidationResultDto
  /** The parsed TaskSpec (from @craft-agent/shared/tasks) when valid; consumers cast. */
  spec?: unknown
  /** Active run snapshot when a runId was supplied and known; otherwise null. */
  run?: TaskRunSnapshotDto | null
  /** Canonical durable product object, materialized from spec + journal + task metadata. */
  task?: DurableTaskSnapshotDto
}
