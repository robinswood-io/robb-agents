
/** Host-persisted semantic kind for one inter-session delivery. */
export type AgentMessageType = 'progress' | 'result' | 'question' | 'decision';

// ============================================================
// Session Self-Management Types — Resolution
// ============================================================

/** Result of resolving label names/IDs against configured labels. */
export interface ResolvedLabelsResult {
  /** Resolved label IDs (ready to store) */
  resolved: string[];
  /** Labels that couldn't be matched to any configured label */
  unknown: string[];
  /** All valid label IDs (for error messages) */
  available: string[];
  /**
   * Optional per-input rejection reason, keyed by the original input string.
   * Populated by `resolveSessionLabels()` from `@craft-agent/shared/labels`.
   * Handlers use this to build clearer errors (e.g. "label X doesn't accept a value").
   */
  reasons?: Record<string, string>;
}

/** Result of resolving a status name/ID against configured statuses. */
export interface ResolvedStatusResult {
  /** Matched status ID, or null if unknown */
  resolved: string | null;
  /** All valid status IDs (for error messages) */
  available: string[];
  /**
   * Category of the matched status ('open' | 'closed'), when resolved. Lets the
   * status tool reject agent-driven *closed* transitions (the human owns closure)
   * while still allowing open ones like `needs-review`.
   */
  category?: 'open' | 'closed';
}

// ============================================================
// Session Self-Management Types
// ============================================================

/** Full metadata for a single session (returned by get_session_info). */
export interface SessionInfo {
  id: string;
  name: string;
  labels: string[];
  status: string;
  permissionMode: string;
  createdAt: number;
  updatedAt?: number;
  workingDirectory?: string;
  projectId?: string;
  llmConnection?: string;
  model?: string;
  isActive: boolean;
  /** Own-session host-selected evidence IDs; metadata is never itself target evidence. */
  objectiveEvidenceContext?: string;
}

/** Compact session summary (returned by list_sessions). */
export interface SessionListItem {
  id: string;
  name: string;
  labels: string[];
  status: string;
  createdAt: number;
}

/** Options for list_sessions filtering and pagination. */
export interface ListSessionsOptions {
  status?: string;
  label?: string;
  search?: string;
  sortBy?: 'recent' | 'name' | 'status';
  limit?: number;
  offset?: number;
}

/** Paginated result from list_sessions. */
export interface ListSessionsResult {
  total: number;
  returned: number;
  sessions: SessionListItem[];
}

/** Host-selected failure context only: never a completion receipt or new authority. */
export interface WaitSessionDiagnostic {
  verified: false;
  objectiveId: string;
  source: 'current-generation' | 'persisted-objective';
  processingGeneration?: number;
  messageId?: string;
  text?: string;
  textTruncated?: boolean;
  errorMessageId?: string;
  errorText?: string;
  errorTextTruncated?: boolean;
  validationGaps?: string[];
  validationGapsTruncated?: boolean;
}

export interface WaitSessionSnapshot {
  sessionId: string;
  state: 'active' | 'idle' | 'missing';
  status?: string;
  processingGeneration?: number;
  reason?: 'complete' | 'interrupted' | 'error' | 'timeout';
  finalText?: string;
  /** Opaque host cursor; only a delivery position, never an acceptance proof. */
  cursor?: string;
  changed?: boolean;
  finalMessageId?: string;
  finalTextTruncated?: boolean;
  diagnostic?: WaitSessionDiagnostic;
  needsAttention?: boolean;
  /** Host objective state explains a validation stop without inventing a user question. */
  objectiveState?: string;
}

export interface WaitSessionsResult {
  outcome: 'completed' | 'timeout';
  mode?: WaitSessionsMode;
  sessions: WaitSessionSnapshot[];
}

export type WaitSessionsMode = 'first' | 'all';

/**
 * Result of delivering a cross-session message (send_agent_message).
 * Lets the sender report the truth instead of an unconditional "sent".
 */
export interface SendAgentMessageResult {
  /**
   * - `delivered`: the durable receipt has advanced beyond queued.
   * - `queued`: the durable receipt still says queued, whether because the
   *   target was busy or because its processing transition is not durable yet.
   */
  delivery: 'delivered' | 'queued';
  /** Whether the target session was processing a turn when the message arrived. */
  targetBusy: boolean;
  receiptId?: string;
  status?: 'queued' | 'processing' | 'processed' | 'failed';
}

/**
 * A background task tracked by the main process (returned by
 * list_background_tasks). This is the cross-subprocess source of truth: the
 * SDK's in-subprocess task tools only see tasks launched in the CURRENT
 * subprocess, so they cannot report a task from a prior turn's (torn-down)
 * subprocess. `status: 'orphaned'` means the owning turn ended before a terminal
 * notification arrived — the task most likely died with its subprocess.
 */
export interface BackgroundTaskInfo {
  taskId: string;
  intent?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned';
  /** ms timestamp when the task was backgrounded */
  startTime: number;
  /** seconds elapsed since start (derived at query time) */
  elapsedSeconds: number;
  /** ms timestamp when the task reached a terminal/orphaned status, if any */
  completedAt?: number;
}
