// =============================================================================
// Package re-exports (convenience for renderer imports)
// =============================================================================
// Core types
import type { UserInputResponse, UserInputResponseResult } from "@craft-agent/core/types";
// =============================================================================
// ElectronAPI — type-safe IPC API exposed to renderer
// =============================================================================
// Re-import types for ElectronAPI
import type { StoredAttachment as StoredAttachmentType } from "@craft-agent/core/types";
// Import protocol types used by ElectronAPI (they come through the `export *` above,
// but we need them in scope for the interface definition)
import type { Session, UnreadSummary, CreateSessionOptions, TaskValidationResultDto, TaskCreateRequest, TaskCreateResult, TaskGenerateRequest, TaskGenerateAck, TaskGenerateResult, TaskRunRequest, TaskRunSnapshotDto, TaskApprovalRequestDto, TaskApprovalDecisionRequest, TaskKillSwitchSnapshotDto, TaskKillSwitchUpdateRequest, TaskGetResult, TaskResultsDto, TaskRepairRequest, DurableTaskSnapshotDto, DurableTaskMetadataUpdateRequest, DurableTaskCockpitProjectionsDto, MissionPlanRequest, MissionPlanAck, MissionPlanResult, MissionCreateAndStartRequest, MissionPreflightRequest, MissionPreflightResult, MissionReplanPreviewDto, MissionReplanPreviewRequest, MissionReplanRequest, MissionControlRequest, MissionConnectorApprovalDecisionRequest, MissionConnectorApprovalRefreshRequest, MissionConnectorApprovalRequestDto, MissionResumeRequest, MissionSnapshotDto, MissionProofPassportDto, MissionProofPassportTrustAnchorDto, MissionProofPassportVerificationDto, FileAttachment, SendMessageOptions, PermissionResponseOptions, CredentialResponse } from "@craft-agent/shared/protocol";
import type { OperationsStatusDto, OperationsSettingsDto } from '@craft-agent/shared/operations';

export interface SessionTaskApi {

  // Session management
  getSessions(): Promise<Session[]>
  getUnreadSummary(): Promise<UnreadSummary>
  markAllSessionsRead(workspaceId: string): Promise<void>
  getSessionMessages(sessionId: string): Promise<Session | null>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  deleteSession(sessionId: string): Promise<void>
  sendMessage(sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachmentType[], options?: SendMessageOptions): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>

  // Tasks (Conductor)
  validateTask(workspaceId: string, yaml: string): Promise<TaskValidationResultDto>
  createTask(workspaceId: string, req: TaskCreateRequest): Promise<TaskCreateResult>
  generateTask(workspaceId: string, req: TaskGenerateRequest): Promise<TaskGenerateAck>
  /** Async generate result (or error), keyed by orchestratorSessionId. Subscribe before/after generateTask. */
  onTaskGenerated(callback: (workspaceId: string, result: TaskGenerateResult) => void): () => void
  runTask(workspaceId: string, req: TaskRunRequest): Promise<TaskRunSnapshotDto>
  pauseTask(workspaceId: string, slug: string, runId: string): Promise<void>
  resumeTask(workspaceId: string, slug: string, runId: string): Promise<void>
  stopTask(workspaceId: string, slug: string, runId: string): Promise<void>
  repairTask(workspaceId: string, req: TaskRepairRequest): Promise<TaskRunSnapshotDto>
  listTaskApprovals(workspaceId: string, slug?: string, runId?: string): Promise<TaskApprovalRequestDto[]>
  resolveTaskApproval(
    workspaceId: string,
    req: TaskApprovalDecisionRequest,
  ): Promise<TaskRunSnapshotDto>
  getTaskKillSwitches(workspaceId: string): Promise<TaskKillSwitchSnapshotDto>
  setTaskKillSwitch(
    workspaceId: string,
    request: TaskKillSwitchUpdateRequest,
  ): Promise<TaskKillSwitchSnapshotDto>
  getTask(workspaceId: string, slug: string, runId?: string): Promise<TaskGetResult>
  listTasks(workspaceId: string): Promise<string[]>
  listDurableTasks(workspaceId: string, includeArchived?: boolean): Promise<DurableTaskSnapshotDto[]>
  updateTaskMetadata(workspaceId: string, request: DurableTaskMetadataUpdateRequest): Promise<DurableTaskSnapshotDto>
  getTaskCockpitProjections(workspaceId: string, slug: string): Promise<DurableTaskCockpitProjectionsDto>
  getTaskResults(workspaceId: string, slug: string, runId?: string): Promise<TaskResultsDto>

  // Missions v2
  planMission(workspaceId: string, request: MissionPlanRequest): Promise<MissionPlanAck>
  getMissionPlan(workspaceId: string, plannerSessionId: string): Promise<MissionPlanResult>
  onMissionPlanned(callback: (workspaceId: string, result: MissionPlanResult) => void): () => void
  startMission(workspaceId: string, request: MissionCreateAndStartRequest): Promise<MissionSnapshotDto>
  preflightMission(workspaceId: string, request: MissionPreflightRequest): Promise<MissionPreflightResult>
  previewMissionReplan(workspaceId: string, request: MissionReplanPreviewRequest): Promise<MissionReplanPreviewDto>
  replanMission(workspaceId: string, request: MissionReplanRequest): Promise<MissionSnapshotDto>
  getMission(workspaceId: string, missionId: string): Promise<MissionSnapshotDto>
  listMissions(workspaceId: string): Promise<MissionSnapshotDto[]>
  listMissionConnectorApprovals(workspaceId: string): Promise<MissionConnectorApprovalRequestDto[]>
  resolveMissionConnectorApproval(
    workspaceId: string,
    request: MissionConnectorApprovalDecisionRequest,
  ): Promise<MissionSnapshotDto>
  refreshMissionConnectorApproval(
    workspaceId: string,
    request: MissionConnectorApprovalRefreshRequest,
  ): Promise<MissionSnapshotDto>
  getMissionProofPassport(workspaceId: string, missionId: string): Promise<MissionProofPassportDto | null>
  getMissionProofPassportTrustAnchor(workspaceId: string): Promise<MissionProofPassportTrustAnchorDto>
  verifyMissionProofPassport(workspaceId: string, missionId: string): Promise<MissionProofPassportVerificationDto>
  pauseMission(workspaceId: string, request: MissionControlRequest): Promise<MissionSnapshotDto>
  resumeMission(workspaceId: string, request: MissionResumeRequest): Promise<MissionSnapshotDto>
  cancelMission(workspaceId: string, request: MissionControlRequest): Promise<MissionSnapshotDto>
  onMissionChanged(callback: (workspaceId: string, snapshot: MissionSnapshotDto) => void): () => void
  getOperationsStatus(workspaceId: string): Promise<OperationsStatusDto>
  updateOperationsSettings(workspaceId: string, settings: OperationsSettingsDto): Promise<OperationsSettingsDto>
  resolveOperationsApproval(workspaceId: string, request: { approvalId: string; approved: boolean }): Promise<{ resolved: boolean }>

  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean, options?: PermissionResponseOptions): Promise<boolean>
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>

  respondToUserInput(sessionId: string, response: UserInputResponse): Promise<UserInputResponseResult>
}
