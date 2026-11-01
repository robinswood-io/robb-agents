import type { SessionEvent as ProtocolSessionEvent } from '@craft-agent/shared/protocol'
/**
 * Event Processor Types
 *
 * Defines the state and event types for the centralized event processor.
 * All agent events flow through a single pure function for consistent state transitions.
 */

import type { Session, PermissionRequest, CredentialRequest, PermissionMode } from '../../shared/types'

/**
 * Streaming state for a session - replaces streamingTextRef
 */
export interface StreamingState {
  content: string
  turnId?: string
  parentToolUseId?: string
}

/**
 * Complete state for a session - combines session + streaming
 */
export interface SessionState {
  session: Session
  streaming: StreamingState | null
}

/**
 * Text delta event - streaming text content
 */
export type TextDeltaEvent = Extract<ProtocolSessionEvent, { type: 'text_delta' }>

/**
 * Text complete event - finalizes streaming text
 */
export type TextDiscardEvent = Extract<ProtocolSessionEvent, { type: 'text_discard' }>

export type TextCompleteEvent = Extract<ProtocolSessionEvent, { type: 'text_complete' }>

/**
 * Tool start event - begins tool execution
 * Field names match SessionEvent from shared/types.ts
 */
export type ToolStartEvent = Extract<ProtocolSessionEvent, { type: 'tool_start' }>

/**
 * Tool result event - completes tool execution
 */
export type ToolResultEvent = Extract<ProtocolSessionEvent, { type: 'tool_result' }>

/**
 * Complete event - agent loop finished
 */
export type CompleteEvent = Extract<ProtocolSessionEvent, { type: 'complete' }>

/**
 * Error event - agent error occurred
 */
export type ErrorEvent = Extract<ProtocolSessionEvent, { type: 'error' }>

/**
 * Permission request event
 * Matches SessionEvent shape from shared/types.ts
 */
export type PermissionRequestEvent = Extract<ProtocolSessionEvent, { type: 'permission_request' }>

/**
 * Sources changed event
 */
export type SourcesChangedEvent = Extract<ProtocolSessionEvent, { type: 'sources_changed' }>

/**
 * Labels changed event
 */
export type LabelsChangedEvent = Extract<ProtocolSessionEvent, { type: 'labels_changed' }>

/**
 * Project id changed event (session bound/unbound to a workspace project)
 */
export type ProjectIdChangedEvent = Extract<ProtocolSessionEvent, { type: 'project_id_changed' }>

/**
 * Todo state changed event (external metadata change or agent tool)
 */
export type SessionStatusChangedEvent = Extract<ProtocolSessionEvent, { type: 'session_status_changed' }>

/**
 * Session metadata changed event — generic live push for programmatic metadata writes
 * (taskNodeCount, kanbanColumn) that don't ride the header-signature file-watch path.
 */
export type ObjectiveChangedEvent = Extract<ProtocolSessionEvent, { type: 'objective_changed' }>

export type SessionMetadataChangedEvent = Extract<ProtocolSessionEvent, { type: 'session_metadata_changed' }>

/**
 * Session flagged/unflagged events (external metadata change)
 */
export type SessionFlaggedEvent = Extract<ProtocolSessionEvent, { type: 'session_flagged' }>

export type SessionUnflaggedEvent = Extract<ProtocolSessionEvent, { type: 'session_unflagged' }>

/**
 * Session archived/unarchived events (external metadata change)
 */
export type SessionArchivedEvent = Extract<ProtocolSessionEvent, { type: 'session_archived' }>

export type SessionUnarchivedEvent = Extract<ProtocolSessionEvent, { type: 'session_unarchived' }>

/**
 * Session name changed event (external metadata change)
 */
export type NameChangedEvent = Extract<ProtocolSessionEvent, { type: 'name_changed' }>

/**
 * Plan submitted event
 */
export type PlanSubmittedEvent = Extract<ProtocolSessionEvent, { type: 'plan_submitted' }>

/**
 * Typed error event
 */
export type TypedErrorEvent = Extract<ProtocolSessionEvent, { type: 'typed_error' }>

/**
 * Status event
 */
export type StatusEvent = Extract<ProtocolSessionEvent, { type: 'status' }>

/**
 * Info event
 */
export type InfoEvent = Extract<ProtocolSessionEvent, { type: 'info' }>

/**
 * Interrupted event
 */
export type InterruptedEvent = Extract<ProtocolSessionEvent, { type: 'interrupted' }>

/**
 * Title generated event
 */
export type TitleGeneratedEvent = Extract<ProtocolSessionEvent, { type: 'title_generated' }>

/**
 * Title regenerating event - indicates title regeneration has started/finished
 * Used to show shimmer effect on title during regeneration
 * @deprecated Use AsyncOperationEvent instead
 */
export type TitleRegeneratingEvent = Extract<ProtocolSessionEvent, { type: 'title_regenerating' }>

/**
 * Generic async operation state event
 * Used to show shimmer effect during any async operation (sharing, updating, revoking, title regeneration)
 */
export type AsyncOperationEvent = Extract<ProtocolSessionEvent, { type: 'async_operation' }>

/**
 * Working directory changed event (user-initiated via UI)
 */
export type WorkingDirectoryChangedEvent = Extract<ProtocolSessionEvent, { type: 'working_directory_changed' }>

/**
 * Working directory error event - server rejected the path (cross-platform, not found, etc.)
 */
export type WorkingDirectoryErrorEvent = Extract<ProtocolSessionEvent, { type: 'working_directory_error' }>

/**
 * Permission mode changed event
 */
export type PermissionModeChangedEvent = Extract<ProtocolSessionEvent, { type: 'permission_mode_changed' }>

/**
 * Session model changed event
 */
export type SessionModelChangedEvent = Extract<ProtocolSessionEvent, { type: 'session_model_changed' }>

/**
 * LLM connection changed event - syncs session.llmConnection to renderer
 */
export type LLMConnectionChangedEvent = Extract<ProtocolSessionEvent, { type: 'connection_changed' }>

/**
 * Credential request event - prompts user for credentials
 */
export type CredentialRequestEvent = Extract<ProtocolSessionEvent, { type: 'credential_request' }>

/**
 * Task backgrounded event - background agent started
 */
export type TaskBackgroundedEvent = Extract<ProtocolSessionEvent, { type: 'task_backgrounded' }>

/**
 * Workflow agent completed - one sub-agent of a running Workflow finished.
 * Increments the owning workflow chip's completed-agent count.
 */
export type WorkflowAgentCompletedEvent = Extract<ProtocolSessionEvent, { type: 'workflow_agent_completed' }>

/**
 * Shell backgrounded event - background bash shell started
 */
export type ShellBackgroundedEvent = Extract<ProtocolSessionEvent, { type: 'shell_backgrounded' }>

/**
 * Task progress event - live progress updates for background tasks
 */
export type TaskProgressEvent = Extract<ProtocolSessionEvent, { type: 'task_progress' }>

/**
 * Task completed event - background task finished execution
 * Updates the tool message status and result when a background task completes.
 */
export type TaskCompletedEvent = Extract<ProtocolSessionEvent, { type: 'task_completed' }>

/**
 * User message event - backend confirmation of optimistic user message
 * Used for optimistic UI: frontend shows message immediately,
 * backend confirms/updates status via this event
 */
export type UserMessageEvent = Extract<ProtocolSessionEvent, { type: 'user_message' }>

/**
 * Message annotation update event
 */
export type MessageAnnotationsUpdatedEvent = Extract<ProtocolSessionEvent, { type: 'message_annotations_updated' }>

/**
 * Session shared event - session was shared to viewer
 */
export type SessionSharedEvent = Extract<ProtocolSessionEvent, { type: 'session_shared' }>

/**
 * Session unshared event - session share was revoked
 */
export type SessionUnsharedEvent = Extract<ProtocolSessionEvent, { type: 'session_unshared' }>

/**
 * Auth request event - unified auth flow (credential or OAuth)
 * Adds auth-request message to session and displays inline auth UI
 */
export type UserInputChangedEvent = Extract<ProtocolSessionEvent, { type: 'user_input_changed' }>

export type AuthRequestEvent = Extract<ProtocolSessionEvent, { type: 'auth_request' }>

/**
 * Auth completed event - auth request was completed (success, failure, or cancelled)
 * Updates the auth-request message status
 */
export type AuthCompletedEvent = Extract<ProtocolSessionEvent, { type: 'auth_completed' }>

/**
 * Source activated event - a source was auto-activated mid-turn.
 * The server owns the auto-retry; renderers should treat this as UI feedback only.
 */
export type SourceActivatedEvent = Extract<ProtocolSessionEvent, { type: 'source_activated' }>

/**
 * Usage update event - real-time context usage during processing
 * Allows UI to show growing context as agent processes, not just on complete
 */
export type AutonomyEventUpdate = Extract<ProtocolSessionEvent, { type: 'autonomy_event' }>

export type UsageUpdateEvent = Extract<ProtocolSessionEvent, { type: 'usage_update' }>

/**
 * Union of all agent events
 */
export type AgentEvent = Exclude<ProtocolSessionEvent, { type: 'session_created' | 'session_deleted' }>
/**
 * Side effects that need to be handled outside the pure processor
 */
export type Effect =
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'credential_request'; request: CredentialRequest }
  | { type: 'generate_title'; sessionId: string; userMessage: string }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: 'user' | 'system' | 'restore' | 'automation' | 'unknown' }
  | { type: 'restore_input'; text: string }
  | { type: 'toast_error'; message: string }

/**
 * Result of processing an event
 */
export interface ProcessResult {
  state: SessionState
  /** Side effects to execute (permissions, etc.) */
  effects: Effect[]
}
