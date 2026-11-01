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
import type { SessionDelegation } from './session-metadata.ts';
import type { SessionAppProvenance, SessionStatus, SessionTokenUsage } from './session-provenance.ts';
import type { ContextCompactionAttemptState, PendingTurnRecovery } from './turn-recovery.ts';

/**
 * Session header - line 1 of session.jsonl
 *
 * Contains all metadata needed for list views (pre-computed at save time).
 * This enables fast session listing without parsing message content.
 */
export interface SessionHeader {
  schemaVersion: 1;
  id: string;
  /** SDK session ID (captured after first message) */
  sdkSessionId?: string;
  /** Workspace root path (stored as portable path, e.g., ~/.craft-agent/...) */
  workspaceRootPath: string;
  /** Optional user-defined name */
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  /** App build that created this session identity. */
  createdByApp?: SessionAppProvenance;
  /** App build that most recently persisted this session. */
  lastUsedByApp?: SessionAppProvenance;
  /** Timestamp of last meaningful message — persisted separately from lastUsedAt for stable date grouping across restarts. */
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
  /** SDK cwd for session storage - set once at creation, never changes */
  sdkCwd?: string;
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
  // Pre-computed fields for fast list loading
  /** Number of messages in session */
  messageCount: number;
  /** Role/type of the last message (for badge display without loading messages) */
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  /** Preview of first user message (first 150 chars) */
  preview?: string;
  /** Token usage statistics */
  tokenUsage: SessionTokenUsage;
  /** ID of the last final (non-intermediate) assistant message - for unread detection without loading messages */
  lastFinalMessageId?: string;
}
