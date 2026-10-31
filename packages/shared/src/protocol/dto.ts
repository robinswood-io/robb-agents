/** Transport DTOs grouped by session, task, connection and workspace responsibility. */
export { generateMessageId } from '@craft-agent/core/types'
export type { PermissionRequest as BasePermissionRequest } from "@craft-agent/core/types";
export type { CredentialInputMode } from "../agent/index";
export type { AuthRequest } from "../agent/index";
export type { SessionStatus, BuiltInStatusId, Session, CreateSessionOptions, RemoteSessionTransferPayload, ImportRemoteSessionTransferResult } from './dto/sessions.ts';
export type { TaskValidationIssueDto, TaskValidationResultDto, TaskCreateRequest, TaskCreateResult, TaskGenerateRequest, TaskGenerateAck, TaskGenerateResult, TaskRunRequest, TaskRepairRequest, TaskNodeRunStateDto, TaskRunSnapshotDto, TaskApprovalRequestDto, TaskApprovalDecisionRequest, TaskKillSwitchSnapshotDto, TaskKillSwitchUpdateRequest, TaskGetResult } from './dto/tasks.ts';
export type { MissionSnapshotDto, MissionProofPassportDto, MissionProofPassportTrustAnchorDto, MissionProofPassportVerificationDto, MissionPlanRequest, MissionPlanAck, MissionPlanIssueDto, MissionPlanResult, MissionCreateAndStartRequest, MissionPreflightRequest, MissionPreflightResult, MissionReplanPreviewRequest, MissionReplanRequest, MissionReplanPreviewDto, MissionControlRequest, MissionResumeRequest, MissionConnectorApprovalRequestDto, MissionConnectorApprovalDecisionRequest, MissionConnectorApprovalRefreshRequest, DurableTaskSnapshotDto, DurableTaskCockpitProjectionsDto, DurableTaskMetadataUpdateRequest, TaskResultNodeDto, MissionBlockerDto, MissionApprovalDto, MissionControlSnapshotDto, MissionReplayPlanDto, TaskResultsDto } from './dto/missions.ts';
export type { PermissionModeState, SessionEvent, SendMessageOptions, RetryTurnResult, SessionCommand, NewChatActionParams } from './dto/session-events.ts';
export type { PermissionRequest, PermissionResponseOptions, CredentialRequest, CredentialResponse, DirectoryListingResult, FileAttachment, SessionFile, FileSearchResult } from './dto/files-and-permissions.ts';
export type { ClaudeOAuthIdentityDto, LlmConnectionSetup, TestLlmConnectionParams, TestLlmConnectionResult, SkillFile, OAuthResult, McpValidationResult, McpToolWithPermission, McpToolsResult } from './dto/connections.ts';
export type { SessionSearchMatch, SessionSearchResult, UnreadSummary, ShareResult, RefreshTitleResult, PlanStep, Plan } from './dto/session-results.ts';
export type { GitBashStatus, UpdateInfo, WorkspaceSettings, WorkspaceGovernanceUpdateRequest, WorkspaceGovernanceUpdateResult, RemoteSupervisionGrantRequest, RemoteSupervisionRevokeRequest, ClaudeOAuthResult } from './dto/workspace-and-updates.ts';
export type { TestAutomationAction, TestAutomationPayload, TestAutomationActionResult, TestAutomationResult, WindowCloseRequestSource, WindowCloseRequest } from './dto/automations-and-windows.ts';
export type { BrowserInstanceInfo, DeepLinkNavigation } from './dto/browser-navigation.ts';
