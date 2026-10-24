/**
 * Server DTO types — data shapes used by RPC handlers and SessionManager.
 *
 * These were previously in apps/electron/src/shared/types.ts.
 * Extracted here so handler code in @craft-agent/server-core can import
 * from @craft-agent/shared/protocol without reaching into the app.
 */
import type { Message, UserInputRequest, AutonomyEvent } from "@craft-agent/core/types";
import type { PermissionMode } from "../../agent/mode-types";
import type { ThinkingLevel } from "../../agent/thinking-levels";
import type { SessionExecutionIsolation } from "../../tasks/durable-execution";
import type { ActiveSessionObjective, MissionOrdinaryRouteLock, PendingTurnRecovery, SessionAppProvenance, SessionDelegation } from "../../sessions/types";

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/**
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string

export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled'

/**
 * Electron-specific Session type (includes runtime state).
 * Extends core Session with messages array and processing state.
 */
export interface Session {
  id: string
  workspaceId: string
  workspaceName: string
  name?: string
  /** Preview of first user message (from JSONL header, for lazy-loaded sessions) */
  preview?: string
  lastMessageAt: number
  messages: Message[]
  isProcessing: boolean
  /** Durable objective state. Only host-validated terminalState confirms success. */
  activeObjective?: ActiveSessionObjective
  /** A pending continuation is not a terminal result, even after a text_complete event. */
  pendingTurnRecovery?: PendingTurnRecovery
  /** Includes questions from this session and its descendants in the same workspace. */
  userInputRequests?: UserInputRequest[]
  /** Runtime auth card exposed without loading the session transcript. */
  pendingAuthRequestMessage?: Message
  isFlagged?: boolean
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode
  sessionStatus?: SessionStatus
  /** Labels (additive tags, many-per-session — bare IDs or "id::value" entries) */
  labels?: string[]
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  enabledSourceSlugs?: string[]
  workingDirectory?: string
  sessionFolderPath?: string
  sharedUrl?: string
  sharedId?: string
  model?: string
  /** Preserve this caller-selected model across automatic cost routing. */
  modelRoutePinned?: boolean
  llmConnection?: string
  /** Preserve this caller-selected connection across automatic policy routing. */
  connectionRoutePinned?: boolean
  thinkingLevel?: ThinkingLevel
  /** Preserve this caller-selected reasoning level across automatic cost routing. */
  thinkingLevelPinned?: boolean
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  lastFinalMessageId?: string
  isAsyncOperationOngoing?: boolean
  autonomyEvents?: AutonomyEvent[]
  playbookSlug?: string
  /** @deprecated Use isAsyncOperationOngoing instead */
  isRegeneratingTitle?: boolean
  currentStatus?: {
    message: string
    statusType?: string
  }
  createdAt?: number
  /** App build that created this session identity. */
  createdByApp?: SessionAppProvenance
  /** App build that most recently persisted this session. */
  lastUsedByApp?: SessionAppProvenance
  messageCount?: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean
  isArchived?: boolean
  archivedAt?: number
  supportsBranching?: boolean
  /** Workspace-scoped project id this session is bound to (undefined = unbound) */
  projectId?: string
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task) */
  parentSessionId?: string
  /** Host-owned autonomous delegation lineage; never supplied by an agent payload. */
  delegation?: SessionDelegation
  /** Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus */
  kanbanColumn?: string
  /** Tasks Conductor: slug of the task spec this session belongs to. */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator. */
  taskNodeCount?: number
  /** Tasks Conductor: generate-time draft orchestrator, hidden from the board until adopted by createTask. */
  taskDraft?: boolean
  /** Host-enforced tool isolation envelope for a Conductor child session. */
  executionIsolation?: SessionExecutionIsolation
  /** Mission v2 owning this specialist session. */
  missionId?: string
  /** Mission v2 work item executed by this session. */
  missionWorkItemId?: string
  /** Stable dispatch identity used for crash-safe session recovery. */
  missionDispatchId?: string
  /** Mission role assigned to this session. */
  missionRole?: 'planner' | 'worker' | 'reviewer' | 'supervisor'
  /** Immutable evaluated route identity for a specialized Mission session. */
  missionRouteLockSha256?: string
  /** Host-owned immutable route for an automatically routed ordinary Mission session. */
  missionOrdinaryRouteLock?: MissionOrdinaryRouteLock
}

export interface CreateSessionOptions {
  name?: string
  permissionMode?: PermissionMode
  /**
   * Reasoning/thinking level override. When set, takes precedence over workspace
   * and global defaults. Silently ignored by the underlying SDK on non-reasoning
   * models (e.g. gpt-4o) — provider drivers don't attach the reasoning param to
   * the API request for models with `reasoning: false` in the Pi SDK catalog.
   */
  thinkingLevel?: ThinkingLevel
  /**
   * Working directory for the session:
   * - 'user_default' or undefined: Use workspace's configured default working directory
   * - 'none': No working directory (session folder only)
   * - Absolute path string: Use this specific path
   */
  workingDirectory?: string | 'user_default' | 'none'
  model?: string
  /** Preserve this caller-selected model across automatic cost routing. */
  modelRoutePinned?: boolean
  llmConnection?: string
  /** Preserve this caller-selected connection across automatic policy routing. */
  connectionRoutePinned?: boolean
  /** Preserve this caller-selected reasoning level across automatic cost routing. */
  thinkingLevelPinned?: boolean
  systemPromptPreset?: 'default' | 'mini' | string
  hidden?: boolean
  sessionStatus?: SessionStatus
  labels?: string[]
  isFlagged?: boolean
  enabledSourceSlugs?: string[]
  /** Operational playbook to bind to this session. */
  playbookSlug?: string
  /**
   * Message ID to branch from. This is a hard context cutoff:
   * the new session must not include model context from later parent messages.
   */
  branchFromMessageId?: string
  /** Parent session ID used together with branchFromMessageId. */
  branchFromSessionId?: string
  /** Bind the new session to a workspace project (inherits project's workingDirectory). */
  projectId?: string
  /** Mark the new session as a subtask of this parent session (undefined = top-level task). */
  parentSessionId?: string
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes). */
  taskSlug?: string
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string
  /** Tasks Conductor: mark the orchestrator as a generate-time draft (hidden until adopted by createTask). */
  taskDraft?: boolean
  /** Host-enforced tool isolation envelope for a Conductor child session. */
  executionIsolation?: SessionExecutionIsolation
  /** Mission v2 owning this specialist session. */
  missionId?: string
  /** Mission v2 work item executed by this session. */
  missionWorkItemId?: string
  /** Stable dispatch identity used for crash-safe session recovery. */
  missionDispatchId?: string
  /** Mission role assigned to this session. */
  missionRole?: 'planner' | 'worker' | 'reviewer' | 'supervisor'
  /** Immutable evaluated route identity for a specialized Mission session. */
  missionRouteLockSha256?: string
  /**
   * Apply the reserved "Task" label (valueType 'number') after creation. Top-level sessions
   * allocate the next task number; sessions with a `parentSessionId` inherit the parent's
   * number (labeling a plain-chat parent in the same pass). Task flows opt in; plain chats don't.
   */
  applyTaskLabel?: boolean
}

export interface RemoteSessionTransferPayload {
  sourceSessionId: string
  name?: string
  sessionStatus?: SessionStatus
  labels?: string[]
  permissionMode?: PermissionMode
  summary: string
  /** Remote summaries are data, never executable instructions. */
  trust?: 'external-untrusted'
  /** True when credential-shaped material was removed before summarization and transfer. */
  secretLikeTextRedacted?: true
}

export interface ImportRemoteSessionTransferResult {
  sessionId: string
}
