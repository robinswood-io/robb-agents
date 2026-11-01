/**
 * Server DTO types — data shapes used by RPC handlers and SessionManager.
 *
 * These were previously in apps/electron/src/shared/types.ts.
 * Extracted here so handler code in @craft-agent/server-core can import
 * from @craft-agent/shared/protocol without reaching into the app.
 */
import type { Message, UserInputRequest, TypedError, ContentBadge, ToolDisplayMeta, AnnotationV1, RoutingMeta, AutonomyEvent, ToolExecutionCheckpoint } from "@craft-agent/core/types";
import type { PermissionMode } from "../../agent/mode-types";
import type { ThinkingLevel } from "../../agent/thinking-levels";
import type { ActiveSessionObjective, PendingTurnRecovery } from "../../sessions/types";
import type { AuthRequest as SharedAuthRequest } from "../../agent/index";
import type { CredentialRequest, PermissionRequest } from './files-and-permissions.ts';
import type { Session, SessionStatus } from './sessions.ts';

export interface PermissionModeState {
  permissionMode: PermissionMode
  previousPermissionMode?: PermissionMode
  transitionDisplay?: string
  modeVersion: number
  changedAt: string
  changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
}

// ---------------------------------------------------------------------------
// Session events (main → renderer)
// ---------------------------------------------------------------------------

// turnId: Correlation ID from the API's message.id, groups all events in an assistant turn
export type SessionEvent =
  | { type: 'text_delta'; sessionId: string; delta: string; turnId?: string }
  | { type: 'text_discard'; sessionId: string; turnId: string }
  | { type: 'text_complete'; sessionId: string; text: string; isIntermediate?: boolean; turnId?: string; parentToolUseId?: string; timestamp?: number; messageId?: string; routingMeta?: RoutingMeta; objectiveOutcome?: Message['objectiveOutcome'] | null; objectiveOutcomeError?: string | null }
  | { type: 'tool_start'; sessionId: string; toolName: string; toolUseId: string; toolInput: Record<string, unknown>; toolIntent?: string; toolDisplayName?: string; toolDisplayMeta?: ToolDisplayMeta; turnId?: string; parentToolUseId?: string; timestamp?: number }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; toolName: string; result: string; turnId?: string; parentToolUseId?: string; isError?: boolean; executed?: boolean; checkpoint?: ToolExecutionCheckpoint; timestamp?: number }
  | { type: 'error'; sessionId: string; error: string; timestamp?: number }
  | { type: 'typed_error'; sessionId: string; error: TypedError; timestamp?: number }
  | { type: 'complete'; sessionId: string; reason?: 'complete' | 'interrupted' | 'error' | 'timeout'; tokenUsage?: Session['tokenUsage']; hasUnread?: boolean; backgroundTasksAlive?: boolean }
  /** Complete snapshots; null explicitly clears previously published state. */
  | { type: 'objective_changed'; sessionId: string; activeObjective: ActiveSessionObjective | null; pendingTurnRecovery: PendingTurnRecovery | null }
  | { type: 'interrupted'; sessionId: string; message?: Message; queuedMessages?: string[] }
  | { type: 'status'; sessionId: string; message: string; statusType?: 'compacting' }
  | { type: 'info'; sessionId: string; message: string; statusType?: 'compaction_complete'; level?: 'info' | 'warning' | 'error' | 'success'; timestamp?: number }
  | { type: 'title_generated'; sessionId: string; title: string }
  | { type: 'title_regenerating'; sessionId: string; isRegenerating: boolean }
  | { type: 'async_operation'; sessionId: string; isOngoing: boolean }
  | { type: 'working_directory_changed'; sessionId: string; workingDirectory: string }
  | { type: 'user_input_changed'; sessionId: string; requests: UserInputRequest[] }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'credential_request'; sessionId: string; request: CredentialRequest }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: PermissionModeState['changedBy'] }
  | { type: 'plan_submitted'; sessionId: string; message: Message }
  | { type: 'sources_changed'; sessionId: string; enabledSourceSlugs: string[] }
  | { type: 'labels_changed'; sessionId: string; labels: string[] }
  | { type: 'project_id_changed'; sessionId: string; projectId: string | null }
  | { type: 'connection_changed'; sessionId: string; connectionSlug: string; supportsBranching?: boolean }
  | { type: 'task_backgrounded'; sessionId: string; toolUseId: string; taskId: string; intent?: string; turnId?: string; kind?: 'workflow'; workflowId?: string }
  | { type: 'shell_backgrounded'; sessionId: string; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds: number; turnId?: string }
  | { type: 'task_completed'; sessionId: string; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'workflow_agent_completed'; sessionId: string; workflowId: string; agentId: string; turnId?: string }
  | { type: 'shell_killed'; sessionId: string; shellId: string }
  | { type: 'user_message'; sessionId: string; message: Message; status: 'accepted' | 'queued' | 'processing'; optimisticMessageId?: string }
  | { type: 'session_flagged'; sessionId: string }
  | { type: 'session_unflagged'; sessionId: string }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'session_unarchived'; sessionId: string }
  | { type: 'name_changed'; sessionId: string; name?: string }
  | {
      type: 'session_model_changed'
      sessionId: string
      model: string | null
      /** Whether the effective model is an explicit user choice. */
      modelRoutePinned?: boolean
    }
  | { type: 'session_status_changed'; sessionId: string; sessionStatus: SessionStatus }
  | { type: 'session_metadata_changed'; sessionId: string; changes:
      Partial<Pick<Session, 'taskNodeCount' | 'taskDraft' | 'taskSlug' | 'projectId' | 'isProcessing'>>
      & { kanbanColumn?: NonNullable<Session['kanbanColumn']> | null } }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'session_shared'; sessionId: string; sharedUrl: string }
  | { type: 'session_unshared'; sessionId: string }
  | { type: 'auth_request'; sessionId: string; message: Message; request: SharedAuthRequest }
  | { type: 'auth_completed'; sessionId: string; requestId: string; success: boolean; cancelled?: boolean; error?: string }
  | { type: 'source_activated'; sessionId: string; sourceSlug: string; originalMessage: string }
  | { type: 'usage_update'; sessionId: string; tokenUsage: { inputTokens: number; contextWindow?: number } }
  | { type: 'message_annotations_updated'; sessionId: string; messageId: string; annotations: AnnotationV1[] }
  | { type: 'working_directory_error'; sessionId: string; error: string }
  | { type: 'autonomy_event'; sessionId: string; event: AutonomyEvent }

export interface SendMessageOptions {
  skillSlugs?: string[]
  badges?: ContentBadge[]
  optimisticMessageId?: string
  /**
   * Optional compare-and-send guard used by the Remote offline outbox. The
   * host checks this immediately before appending the user message and rejects
   * with SESSION_CONTEXT_CHANGED if any field moved.
   */
  expectedSessionAnchor?: {
    messageCount: number
    lastFinalMessageId: string | null
    lastMessageAt: number
  }
  /**
   * When true, the message drives a turn (reaches the model) but is marked
   * `hidden` on the persisted `Message` so it never renders as a transcript
   * bubble. Used for system-generated nudges (e.g. WS2 background-task-completion
   * surfacing) that should wake the agent without looking user-authored.
   */
  hidden?: boolean
  /**
   * Internal marker for a host-driven retry of an already-persisted user turn.
   * The original visible message remains the durable recovery anchor; this
   * hidden nudge must not replace it with a second user-authored turn.
   */
  automaticRecovery?: {
    originalUserMessageId: string
    cause: 'app_restart' | 'stream_ended' | 'runtime_error' | 'premature_final' | 'tool_checkpoint' | 'evidence_gate' | 'objective_incomplete' | 'objective_continue' | 'user_retry'
    /** Private host-issued dispatch identity. RPC callers cannot supply the
     * enclosing automaticRecovery provenance. */
    dispatchId?: string
    dispatchAttempt?: number
    dispatchOrigin?: 'restart' | 'retry' | 'automatic'
    dispatchAllocatedAt?: number
    /** Host-authenticated bounded handoff. Public RPC rejects the enclosing
     * automaticRecovery object, so callers cannot mint a context reset. */
    cleanContinuationId?: string
  }
  /** Host-routed provenance. user-input requires a validated, persisted question response. */
  internalOrigin?: {
    /** source-activation is minted by the host's private restart capability. */
    kind: 'agent-message' | 'auth-result' | 'auth-retry' | 'browser-fallback' | 'source-activation' | 'spawned-session' | 'automation' | 'user-input'
    /** Host-only durable source-activation binding; public RPC rejects the
     * enclosing internalOrigin object. */
    objectiveId?: string
    objectiveRevision?: string
    /** Host-only source identity and nonce for durable restart provenance. */
    sourceSlug?: string
    sourceActivationId?: string
    senderSessionId?: string
    deliveryId?: string
    attachmentsSha256?: string
    /** Host-persisted semantic kind for an inter-session delivery. */
    agentMessageType?: 'progress' | 'result' | 'question' | 'decision'
    /** Host-only Task assignment; client RPC rejects the entire internalOrigin object. */
    authenticatedTaskText?: string
  }
}

// ---------------------------------------------------------------------------
// Session commands (consolidated operations)
// ---------------------------------------------------------------------------

export interface RetryTurnResult {
  status: 'started' | 'already_running'
}

export type SessionCommand =
  | { type: 'flag' }
  | { type: 'unflag' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'rename'; name: string }
  | { type: 'setSessionStatus'; state: SessionStatus }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'setActiveViewing'; workspaceId: string }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'updateWorkingDirectory'; dir: string }
  | { type: 'setSources'; sourceSlugs: string[] }
  | { type: 'setLabels'; labels: string[] }
  | { type: 'setProjectId'; projectId: string | null }
  | { type: 'setKanbanColumn'; column: string | null }
  | { type: 'showInFinder' }
  | { type: 'copyPath' }
  | { type: 'shareToViewer' }
  | { type: 'updateShare' }
  | { type: 'revokeShare' }
  | { type: 'refreshTitle' }
  | { type: 'restartRuntime' }
  | { type: 'retryTurn'; userMessageId: string }
  | { type: 'setConnection'; connectionSlug: string }
  | { type: 'setPendingPlanExecution'; planPath: string; draftInputSnapshot?: string }
  | { type: 'markCompactionComplete' }
  | { type: 'markPendingPlanExecutionDispatched' }
  | { type: 'clearPendingPlanExecution' }
  | { type: 'addAnnotation'; messageId: string; annotation: AnnotationV1 }
  | { type: 'removeAnnotation'; messageId: string; annotationId: string }
  | { type: 'updateAnnotation'; messageId: string; annotationId: string; patch: Partial<AnnotationV1> }

export interface NewChatActionParams {
  input?: string
  name?: string
}
