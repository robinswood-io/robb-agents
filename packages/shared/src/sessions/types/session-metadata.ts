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
import type { UserInputRequest } from "@craft-agent/core/types";
import type { SessionExecutionIsolation } from "../../tasks/durable-execution.ts";
import type { MissionCapabilityLock, MissionOrdinaryRouteLock } from './capability-locks.ts';
import type { ActiveSessionObjective, ExternalActionAuthorization } from './objectives.ts';
import type { SessionAppProvenance, SessionStatus, SessionTokenUsage } from './session-provenance.ts';
import type { ContextCompactionAttemptState, PendingTurnRecovery } from './turn-recovery.ts';

/**
 * Session metadata (lightweight, for lists)
 */
export interface SessionMetadata {
  id: string;
  workspaceRootPath: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  /** App build that created this session identity. */
  createdByApp?: SessionAppProvenance;
  /** App build that most recently persisted this session. */
  lastUsedByApp?: SessionAppProvenance;
  /** Timestamp of last meaningful message — used for date grouping. Falls back to lastUsedAt for pre-fix sessions. */
  lastMessageAt?: number;
  messageCount: number;
  /** Preview of first user message */
  preview?: string;
  sdkSessionId?: string;
  /** Whether this session is flagged */
  isFlagged?: boolean;
  /** User-controlled session status */
  sessionStatus?: SessionStatus;
  /** Labels applied to this session (bare IDs or "id::value" entries) */
  labels?: string[];
  /** Explicit per-session source selection (absent = follow workspace defaults) */
  enabledSourceSlugs?: string[];
  /** Permission mode for this session */
  permissionMode?: PermissionMode;
  /** Previous permission mode (used to preserve modeTransition context across restarts) */
  previousPermissionMode?: PermissionMode;
  /** Number of plan files for this session */
  planCount?: number;
  /** Shared viewer URL (if shared via viewer) */
  sharedUrl?: string;
  /** Shared session ID in viewer (for revoke) */
  sharedId?: string;
  /** Working directory for this session */
  workingDirectory?: string;
  /** SDK cwd for session storage - set once at creation, never changes */
  sdkCwd?: string;
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
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
  /** ID of last message user has read - for unread detection */
  lastReadMessageId?: string;
  /** ID of the last final (non-intermediate) assistant message - for unread detection */
  lastFinalMessageId?: string;
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean;
  /** Token usage statistics (from JSONL header, available without loading messages) */
  tokenUsage?: SessionTokenUsage;
  /** When true, session is hidden from session list (e.g., mini edit sessions) */
  hidden?: boolean;
  /** Whether this session is archived */
  isArchived?: boolean;
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number;
  /** Message ID that this session was branched from (hard context cutoff marker). */
  branchFromMessageId?: string;
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
  /** In-flight user turn awaiting automatic recovery after host/stream interruption. */
  pendingTurnRecovery?: PendingTurnRecovery;
  /** Current objective contract used for routing, budgets, and completion gates. */
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
  /** Unexpired sensitive-action grants, scoped to category + concrete target. */
  externalActionAuthorizations?: ExternalActionAuthorization[];
}

/** Assigned by the host, never accepted from an agent's spawn payload. */
export interface SessionDelegation {
  rootSessionId: string;
  rootObjectiveId: string;
  parentObjectiveId: string;
  depth: number;
  role: 'worker' | 'reviewer';
  /**
   * Host-owned exact parent binding for the exceptional reviewer created by a
   * terminal reconciliation. Its presence keeps that child read-only across
   * restart even when legacy lineage IDs are stale or unavailable.
   */
  reviewBinding?: { objectiveId: string; acceptanceSha256: string };
  finishedAt?: number;
}
