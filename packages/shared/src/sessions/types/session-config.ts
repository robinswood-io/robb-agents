/**
 * Session Types
 *
 * Types for workspace-scoped sessions.
 * Sessions are stored at {workspaceRootPath}/sessions/{id}/session.jsonl
 *
 * JSONL Format:
 * - Line 1: SessionHeader (metadata + pre-computed fields for fast list loading)
 * - Lines 2+: StoredMessage (one message per line)
 */
import type { PermissionMode } from "../../agent/mode-manager.ts";
import type { ThinkingLevel } from "../../agent/thinking-levels.ts";
import type { StoredMessage, AutonomyEvent, UserInputRequest } from "@craft-agent/core/types";
import type { SessionExecutionIsolation } from "../../tasks/durable-execution.ts";
import type { MissionCapabilityLock, MissionOrdinaryRouteLock } from './capability-locks.ts';
import type { ActiveSessionObjective, ExternalActionAuthorization } from './objectives.ts';
import type { SessionDelegation } from './session-metadata.ts';
import type { SessionAppProvenance, SessionStatus, SessionTokenUsage } from './session-provenance.ts';
import type { ContextCompactionAttemptState, PendingTurnRecovery } from './turn-recovery.ts';

/**
 * Session configuration (persisted metadata)
 */
export interface SessionConfig {
  id: string;
  /** SDK session ID (captured after first message) */
  sdkSessionId?: string;
  /** Workspace root path this session belongs to */
  workspaceRootPath: string;
  /** Optional user-defined name */
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  /** App build that created this session identity. Immutable after creation. */
  createdByApp?: SessionAppProvenance;
  /** App build that most recently persisted this session. */
  lastUsedByApp?: SessionAppProvenance;
  /** Timestamp of last meaningful message (user or final assistant). Used for date grouping in session list.
   *  Separate from lastUsedAt which tracks any session access (auto-save, open to read, etc.). */
  lastMessageAt?: number;
  /** Whether this session is flagged */
  isFlagged?: boolean;
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode;
  /** Previous permission mode (used to preserve modeTransition context across restarts) */
  previousPermissionMode?: PermissionMode;
  /** User-controlled session status - determines inbox vs completed */
  sessionStatus?: SessionStatus;
  /** Labels applied to this session (bare IDs or "id::value" entries) */
  labels?: string[];
  /** ID of last message user has read */
  lastReadMessageId?: string;
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean;
  /** Per-session source selection (source slugs) */
  enabledSourceSlugs?: string[];
  /** Working directory for this session (used by agent for bash commands and context) */
  workingDirectory?: string;
  /** SDK cwd for session storage - set once at creation, never changes. Ensures SDK can find session transcripts regardless of workingDirectory changes. */
  sdkCwd?: string;
  /** Recent structured resolution/fallback evidence, capped by SessionManager. */
  autonomyEvents?: AutonomyEvent[];
  /** Optional operational playbook bound to this session. */
  playbookSlug?: string;
  /** Unexpired sensitive-action grants, scoped to category + concrete target. */
  externalActionAuthorizations?: ExternalActionAuthorization[];
  /** In-flight user turn awaiting a final response; cleared on terminal completion or explicit stop. */
  pendingTurnRecovery?: PendingTurnRecovery;
  /** Current objective contract, retained across terse continuation turns and restarts. */
  activeObjective?: ActiveSessionObjective;
  /** Last bounded context-compaction attempt, retained to preserve backoff across restarts. */
  contextCompactionAttempt?: ContextCompactionAttemptState;
  /** Earliest transcript row allowed into provider recovery/fallback context. */
  providerContextBoundaryMessageId?: string;
  /** Durable questions owned by this session; ancestor DTOs aggregate them in memory only. */
  userInputRequests?: UserInputRequest[];
  pendingAgentDeliveryIds?: string[];
  /** Durable inbox index, including ordinary user messages awaiting dispatch. */
  pendingQueuedMessageIds?: string[];
  /** Index of the unresolved auth-request message; contains no credentials. */
  pendingAuthRequestId?: string;
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string;
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string;
  /** Model to use for this session (overrides global config if set) */
  model?: string;
  /** Host-authenticated manual/task route that automatic tiering must preserve. */
  modelRoutePinned?: boolean;
  /** LLM connection slug for this session (locked after first message) */
  llmConnection?: string;
  /** Host-authenticated connection selection; automatic policy choices remain adaptive. */
  connectionRoutePinned?: boolean;
  /** Whether the connection is locked (cannot be changed after first agent creation) */
  connectionLocked?: boolean;
  /** Thinking level for this session ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel;
  /** Host-authenticated reasoning override that automatic tiering must preserve. */
  thinkingLevelPinned?: boolean;
  /**
   * Pending plan execution state - tracks "Accept & Compact" flow.
   * When set, indicates a plan needs to be executed after compaction completes.
   * Cleared on: successful execution, new user message, or manual clear.
   */
  pendingPlanExecution?: {
    /** Path to the plan file to execute */
    planPath: string;
    /** Optional snapshot of draft input captured at accept time */
    draftInputSnapshot?: string;
    /** Whether we're still waiting for compaction to complete */
    awaitingCompaction: boolean;
    /** Whether execution has already been dispatched from the UI. */
    executionDispatched?: boolean;
  };
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean;
  /** Whether this session is archived */
  isArchived?: boolean;
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number;
  /**
   * Message ID this session was branched from.
   * Branching semantics are a hard cutoff: model context must not include parent messages after this message.
   */
  branchFromMessageId?: string;
  /**
   * Parent session's SDK session ID (optional, only for provider strategies that support strict SDK-level forking).
   */
  branchFromSdkSessionId?: string;
  /**
   * Parent session's storage path (optional, only when provider-level forking needs parent session files).
   */
  branchFromSessionPath?: string;
  /**
   * Parent session's sdkCwd (optional). SDK session files are stored per-CWD
   * (`~/.claude/projects/{cwd-hash}/`), so forking requires the child subprocess
   * to use the parent's CWD to locate the parent's session file.
   */
  branchFromSdkCwd?: string;
  /**
   * Provider-native branch anchor at the branch point.
   * - Claude: assistant message UUID (used as `resumeSessionAt`)
   * - Pi: session entry ID (used with SessionManager.branch(anchor))
   */
  branchFromSdkTurnId?: string;
  /** One-shot hidden summary injected on the first turn after a remote transfer. */
  transferredSessionSummary?: string;
  /** Whether the transferred-session summary has already been injected. */
  transferredSessionSummaryApplied?: boolean;
  /** Metadata for sessions created by automations */
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number };
  /** Workspace-scoped project id this session belongs to (undefined = unbound). */
  projectId?: string;
  /** Parent session id — when set, this session is a subtask of the parent (undefined = top-level task). */
  delegation?: SessionDelegation;
  parentSessionId?: string;
  /** Kanban board column id ('todo' | 'in-progress' | 'done'). Drag-to-move target; independent of sessionStatus. */
  kanbanColumn?: string;
  /** Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes). */
  taskSlug?: string;
  /** Tasks Conductor: id of the run that spawned this child session (child nodes only). */
  taskRunId?: string;
  /** Tasks Conductor: id of the DAG node this child session executes (child nodes only). */
  taskNodeId?: string;
  /** Tasks Conductor: total DAG node count (orchestrator only) — board progress denominator that stays stable while children spawn lazily. */
  taskNodeCount?: number;
  /** Tasks Conductor: generate-time draft orchestrator. Hidden from the board until adopted (promoted) by createTask. */
  taskDraft?: boolean;
  /** Host-enforced tool isolation envelope for a Conductor child session. */
  executionIsolation?: SessionExecutionIsolation;
  /** Mission v2 owning this specialist session. */
  missionId?: string;
  /** Mission v2 work item executed by this session. */
  missionWorkItemId?: string;
  /** Stable dispatch identity used to find/recover this session after a crash. */
  missionDispatchId?: string;
  /** Mission role assigned to this session. */
  missionRole?: 'planner' | 'worker' | 'reviewer' | 'supervisor';
  /** Immutable evaluated route identity for a specialized Mission session. */
  missionRouteLockSha256?: string;
  /** Host-owned immutable route identity for an automatically routed ordinary Mission session. */
  missionOrdinaryRouteLock?: MissionOrdinaryRouteLock;
  /** Host-internal evaluated capability identities; never accepted from renderer input. */
  missionCapabilityLock?: MissionCapabilityLock;
}

/**
 * Stored session with conversation data
 */
export interface StoredSession extends SessionConfig {
  messages: StoredMessage[];
  tokenUsage: SessionTokenUsage;
}
