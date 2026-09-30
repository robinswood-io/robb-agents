import type { SourceSensitivity, LegacyAutomaticModelTier } from '../config/selection-provenance.ts';
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

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type {
  StoredAttachment,
  MessageRole,
  ToolStatus,
  AuthRequestType,
  AuthStatus,
  CredentialInputMode,
  StoredMessage,
  AutonomyEvent,
  ObjectiveOutcomeDeclaration,
  ObjectiveOutcomeState,
  ObjectiveAcceptanceCriterion,
  ObjectiveProcedureId,
  UserInputRequest,
} from '@craft-agent/core/types';
import type { SessionExecutionIsolation } from '../tasks/durable-execution.ts';


/**
 * Session fields that persist to disk.
 * Add new fields here - they automatically propagate to JSONL read/write
 * via pickSessionFields() utility.
 *
 * IMPORTANT: When adding a new field:
 * 1. Add it to this array
 * 2. Add it to SessionConfig interface below
 * 3. Done - serialization is automatic
 */
export const SESSION_PERSISTENT_FIELDS = [
  // Identity
  'id', 'workspaceRootPath', 'sdkSessionId', 'sdkCwd',
  // Timestamps
  'createdAt', 'lastUsedAt', 'lastMessageAt',
  // App build provenance
  'createdByApp', 'lastUsedByApp',
  // Display
  'name', 'isFlagged', 'sessionStatus', 'labels', 'hidden',
  // Read tracking
  'lastReadMessageId', 'hasUnread',
  // Config
  'enabledSourceSlugs', 'permissionMode', 'previousPermissionMode', 'workingDirectory',
  // Model/Connection
  'model', 'modelRoutePinned', 'llmConnection', 'connectionRoutePinned', 'connectionLocked', 'thinkingLevel', 'thinkingLevelPinned',
  // Sharing
  'sharedUrl', 'sharedId',
  // Plan execution
  'pendingPlanExecution',
  // Archive
  'isArchived', 'archivedAt',
  // Branching
  'branchFromMessageId',
  'branchFromSdkSessionId',
  'branchFromSessionPath',
  'branchFromSdkCwd',
  'branchFromSdkTurnId',
  // Remote transfer handoff
  'transferredSessionSummary',
  'transferredSessionSummaryApplied',
  // Automation origin
  'triggeredBy',
  // Project binding (workspace-scoped grouping)
  'projectId',
  // Kanban: task/subtask hierarchy + board column
  'parentSessionId', 'delegation',
  'kanbanColumn',
  // Tasks Conductor: link a session back to the task spec / run / DAG node that owns it
  'taskSlug',
  'taskRunId',
  'taskNodeId',
  'taskNodeCount',
  'taskDraft',
  'executionIsolation',
  // Mission Orchestration v2: durable dispatch identity for crash recovery
  'missionId',
  'missionWorkItemId',
  'missionDispatchId',
  'missionRole',
  'missionRouteLockSha256',
  'missionOrdinaryRouteLock',
  'missionCapabilityLock',
  // Runtime evidence of autonomous resolution and human-only blockers
  'autonomyEvents',
  'playbookSlug',
  'externalActionAuthorizations',
  // Durable in-flight turn marker used to recover after a host restart/stream loss
  'pendingTurnRecovery',
  // Durable objective contract used for continuation routing and per-objective budgets
  'activeObjective',
  // Durable bounded backoff preventing repeated context-compaction charges after restart
  'contextCompactionAttempt',
  // Earliest transcript row allowed into provider recovery after a fresh-context handoff
  'providerContextBoundaryMessageId',
  'pendingAgentDeliveryIds',
  'pendingQueuedMessageIds',
  'pendingAuthRequestId',
  'userInputRequests',
] as const;

/** Host-internal immutable capability lease for a specialized Mission session. */
export interface MissionCapabilityLock {
  schemaVersion: 1;
  capabilityEnvelopeSha256: string;
  capabilities: Array<{
    kind: 'skill' | 'tool' | 'source' | 'workspace-read' | 'workspace-write' | 'network' | 'external-mutation';
    name: string;
    identitySha256?: string;
    authorityBindingId?: string;
  }>;
}

/** Privacy-safe identity and credential generation of one effective source. */
export interface MissionOrdinarySourceBinding {
  slug: string;
  identitySha256: string;
  authorityBindingId?: string;
}

/**
 * Host-created, privacy-safe identity of one ordinary Mission provider
 * dispatch. Persisting the complete lock lets a recovered session reject
 * silent route, credential, source, cwd, or runtime drift before provider
 * handoff without recomputing the Mission budget decision.
 */
export interface MissionOrdinaryRouteLock {
  schemaVersion: 1;
  routeDecisionSha256: string;
  routeConfigIdentitySha256: string;
  connectionIdentitySha256: string;
  sourceIdentitySha256: string;
  agentProfileId: string;
  connectionSlug: string;
  version: number;
  profile: 'maximum-quality' | 'balanced';
  origin: 'router' | 'cost-control' | 'conductor' | 'mission';
  requestedModel?: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  measuredMissionUsd: number;
  projectedRemainingUsd?: number;
  effectiveSourceSlugs: string[];
  effectiveSourceBindings: MissionOrdinarySourceBinding[];
  cwd: string;
  runtimeIdentitySha256?: string;
}

export type SessionPersistentField = typeof SESSION_PERSISTENT_FIELDS[number];

export type ContextCompactionOutcome =
  | 'succeeded'
  | 'ineffective'
  | 'unverified'
  | 'failed'
  | 'skipped-not-needed';

/** Fixed host classifications only; provider error text is never persisted. */
export type ContextCompactionIssueCode =
  | 'timeout'
  | 'not-needed'
  | 'authentication'
  | 'aborted'
  | 'backend-error';

/**
 * Durable, bounded backoff state for automatic context compaction. The hard
 * limit and follow-up marker keep above-limit recovery finite across cold
 * starts.
 */
export interface ContextCompactionAttemptState {
  attemptedAt: number;
  contextTokensBefore: number;
  /** Legacy SDK message-only estimate. Kept so old receipts remain readable,
   * but never used as a provider-context baseline. */
  contextTokensAfter?: number;
  outcome: ContextCompactionOutcome;
  /** Stable root of the objective whose context was compacted. A continuation
   * or automatic recovery keeps this identity even when its user message id
   * changes. */
  objectiveRootId?: string;
  /** A successful host compaction must wait for a provider-scale measurement
   * before another compaction can be considered for the same objective. */
  awaitingProviderContextBaseline?: true;
  /** The single above-hard-limit provider admission following a successful
   * compaction was durably consumed before provider handoff. Until the provider
   * reports its new baseline, a crash/restart must not replay that admission. */
  providerBaselineAdmissionDispatchedAt?: number;
  /** First provider-reported context measurement after a successful host
   * compaction. Material growth is measured only from this like-for-like value. */
  providerContextBaselineTokens?: number;
  hardLimitTokens?: number;
  /** True only when this receipt is the single follow-up allowed after a
   * successful compaction left the session above the same hard limit. */
  hardLimitFollowUpAttempted?: true;
  /** True only when this receipt consumed the single delayed recovery allowed
   * after the immediate hard-limit follow-up. Time alone must never replenish
   * this budget; only material context growth or a different limit may do so. */
  hardLimitRecoveryAttempted?: true;
  issueCode?: ContextCompactionIssueCode;
}

/**
 * Durable marker for a user turn that has started but has not yet produced a
 * terminal assistant response. It is written before model streaming begins so
 * a host replacement/crash can resume the turn after restart.
 */
export interface PendingTurnRecovery {
  userMessageId: string;
  startedAt: number;
  /** A legacy turn lost its recovery counters. Explicit Retry may resume it;
   * automatic recovery must never invent a fresh allowance for that history. */
  budgetHistoryUnavailable?: boolean;
  /** Fixed wall-clock lease for the automatic-recovery phase of this logical turn. */
  leaseExpiresAt?: number;
  attempts: number;
  /** Number of provider-context resets already opened for this objective.
   * This is monotonic and bounded so semantic progress cannot mint leases
   * indefinitely by repeatedly reaching the absolute attempt ceiling. */
  cleanContinuationCount?: number;
  /** First user row visible to a freshly-created provider context. Provider
   * recovery callbacks must never replay transcript entries before it. */
  cleanContextBoundaryMessageId?: string;
  /**
   * The configured recovery ceiling applies to one strategy, not to the
   * objective itself. The host advances this durable phase only after the
   * current strategy reached its bounded attempt/stagnation limit while a
   * validated, unblocked objective still has concrete work remaining.
   *
   * `attemptBaseline` keeps the existing monotonic `attempts` counter intact
   * for crash/replay fencing while allowing the next materially different
   * strategy to receive its own bounded allowance.
   */
  recoveryStrategy?: {
    schemaVersion: 1;
    phase: 'resume' | 'replan' | 'escalate';
    attemptBaseline: number;
    transitionCount: number;
    transitionedAt: number;
    reason: 'attempt-limit' | 'stagnation';
  };
  /**
   * Durable identity for the latest recovery model dispatch. `attempts` is the
   * bounded automatic-recovery budget; `attempt` below is a monotonic dispatch
   * sequence that also counts an explicit Retry. Keeping both prevents a cold
   * restart from replaying an already-started Retry under the same attempt
   * label or losing an allocation that was persisted just before dispatch.
   */
  recoveryDispatch?: {
    schemaVersion: 1;
    id: string;
    attempt: number;
    cause: 'app_restart' | 'stream_ended' | 'runtime_error' | 'premature_final' | 'tool_checkpoint' | 'evidence_gate' | 'objective_incomplete' | 'objective_continue' | 'user_retry';
    origin: 'restart' | 'retry' | 'automatic';
    allocatedAt: number;
    phase: 'allocated' | 'started';
    startedAt?: number;
    /** Present only when the host durably fences exact tool input before its
     * PreToolUse acknowledgement. Legacy started dispatches without this
     * capability may have executed unrecorded work and are never reclaimable. */
    preToolExecutionReceiptVersion?: 1;
    /** Bounded host intent used to reconstruct a specialized fallback after a
     * crash. Raw provider prompt text is never persisted as recovery authority. */
    fallbackIntent?: {
      kind: 'browser_fallback' | 'structured_fallback';
      failedToolName: string;
    };
    /** Deterministic bounded handoff identity for a provider-context reset.
     * The prompt is reconstructed from host-owned objective state on restart. */
    cleanContinuationId?: string;
    /** Exact authenticated answer carried by this generic dispatch because the
     * provider had not reached its write-ahead boundary before the crash.
     * Absence is fail-closed: a possibly consumed answer is provenance only. */
    carriedUserInputResponseId?: string;
    /** Provider/runtime preparation failures happen before the model can
     * consume this dispatch, so they do not spend `attempt`. Keep a separate,
     * restart-proof and text-free receipt to bound setup retries without
     * losing the original clean allocation. */
    setupFailureCount?: number;
    lastSetupFailureClass?:
      | 'interactive-auth-required'
      | 'credential-required'
      | 'permission-denied'
      | 'invalid-input'
      | 'conflict'
      | 'rate-limited'
      | 'timeout'
      | 'network-unavailable'
      | 'execution-bridge-unavailable'
      | 'service-unavailable'
      | 'resource-exhausted'
      | 'model-unavailable'
      | 'backend-init-failed'
      | 'sandbox-denied'
      | 'unknown';
    /** Absolute wall-clock fence for the next pre-provider setup attempt.
     * Persisting it prevents restart loops from bypassing provider Retry-After
     * or the host's bounded exponential backoff. */
    setupRetryNotBefore?: number;
    /** A bounded setup retry reached a durable stop. A fresh explicit Retry
     * may allocate a new dispatch after the underlying issue is corrected. */
    setupRetryBlockedAt?: number;
    /** The host could not prove that its latest clean-setup state reached
     * durable storage. This dispatch stays human-retry-only across restart. */
    setupPersistenceFencedAt?: number;
  };
  /** Host-issued prospective allowances from explicit Retry. Earlier entries,
   * cumulative attempts and legacy exhaustion remain intact, including on rollback. */
  explicitRetryAllowances?: Array<{
    schemaVersion: 1;
    id: string;
    objectiveId: string;
    userMessageId: string;
    authorizedAt: number;
    attemptBaseline: number;
    maxAttempts: number;
    leaseExpiresAt: number;
    attempts: number;
    lastProgressFingerprint?: string;
    semanticProgressFingerprint: string;
    stagnantAttempts: number;
    lastProgressAt?: number;
    exhaustedAt?: number;
  }>;
  lastAttemptAt?: number;
  /** Last pass that added semantic evidence or a confirmed execution. */
  lastProgressAt?: number;
  lastCause?: 'app_restart' | 'stream_ended' | 'runtime_error' | 'premature_final' | 'tool_checkpoint' | 'evidence_gate' | 'objective_incomplete' | 'objective_continue' | 'user_retry';
  /** Transcript boundary before an explicit retry; earlier final/error messages belong to the previous attempt. */
  userRetryFromMessageCount?: number;
  /** Transcript boundary before dispatching a saved question response; the question's final may follow the queued answer. */
  userInputFromMessageCount?: number;
  /** Stable fingerprint of semantic evidence and confirmed execution seen before the last recovery pass. */
  lastProgressFingerprint?: string;
  /** Consecutive recovery passes that produced no new semantic evidence or confirmed execution. */
  stagnantAttempts?: number;
  /** Host-authored checkpoint that forces continuation independently of assistant prose. */
  continuationRequired?: boolean;
  /** Bounded host validation gaps supplied to the next automatic recovery. */
  validationGaps?: string[];
  /** Bounded remaining work from a host-validated `continue` receipt. */
  continuationWork?: string[];
  /** Durable logical provenance for `continuationWork`. Technical recovery
   * causes may replace `lastCause`, but must not turn validated remaining work
   * into an unrelated restart/runtime retry. */
  continuationOrigin?: 'objective_continue';
  exhaustedAt?: number;
  /** Retain validation exhaustion through an explicit retry's later transport/setup failure. */
  validationExhausted?: boolean;
  /** An unresolved approval is a pause, never an authorization to replay a tool. */
  waitingForPermission?: {
    requestId: string;
    requestedAt: number;
    toolName: string;
    /** Exact pre-execution tool receipt, when supplied by the provider. */
    toolUseId?: string;
    /** The provider-side request no longer exists after restart; a fresh tool request is required. */
    recoveryRequired?: boolean;
  };
}

export type SessionObjectiveTerminalState =
  | 'active'
  | 'complete_verified'
  | 'blocked_human'
  | 'blocked_policy'
  | 'exhausted';

export type SessionObjectiveDeclaredState = ObjectiveOutcomeState;
export type SessionObjectiveOutcomeDeclaration = ObjectiveOutcomeDeclaration;

/**
 * Durable contract for the current user objective. It deliberately references
 * the original transcript message instead of duplicating sensitive user text.
 */
export interface ActiveSessionObjective {
  schemaVersion: 1;
  /**
   * Strongest tier selected automatically during this objective. The value is
   * monotonic until a genuinely new objective starts so a continuation or
   * recovery can promote the model but never silently downgrade it.
   */
  automaticModelTier?: LegacyAutomaticModelTier;
  /** Budget retained by an explicit Stop, not an automatic recovery authority.
   * Only Retry of this exact objective and accepted user anchor may consume it. */
  interruptedTurnRecovery?: {
    objectiveId: string;
    userMessageId: string;
    recovery: PendingTurnRecovery;
  };
  /** Original request kept locally across compaction; never a new permission. */
  originalText?: string;
  requiresObservationEvidence?: boolean;
  /** New objectives require target-bound checks; legacy stored objectives remain readable. */
  requiresAcceptanceCriteria?: boolean;
  /** Registered checks may be extended. An exact failed check may be replaced
   * only by the host-validated explicit `_vN` supersession contract. */
  acceptanceCriteria?: ObjectiveAcceptanceCriterion[];
  acceptanceRegisteredAt?: number;
  /** Host registration time per check; extending a contract preserves earlier observations. */
  acceptanceRegisteredAtById?: Record<string, number>;
  /** Host revision tied to a direct user amendment, never chosen by a tool. */
  acceptanceRevision?: string;
  acceptanceRegisteredRevision?: string;
  acceptanceNeedsReview?: boolean;
  acceptanceHistory?: Array<{ revision: string; criteria: ObjectiveAcceptanceCriterion[]; registeredAt?: number; registeredAtById?: Record<string, number> }>;

  /** Explicitly selected business procedure; immutable for this objective. */
  procedure?: { id: ObjectiveProcedureId; version: 1 };
  /** Host-assigned role, never inferred from untrusted review text. */
  delegatedRole?: 'worker' | 'reviewer';
  /** User amendments retained separately from a compacted transcript. */
  amendments?: Array<{ messageId: string; text: string; timestamp: number }>;
  /**
   * The latest accepted user turn only reconciles terminal state against the
   * already registered contract. It grants no new target, payload, mutation or
   * evidence authority; `messageId` therefore identifies a prompt constraint,
   * not a new acceptance revision.
   */
  terminalReconciliation?: {
    messageId: string;
    /** Reconciliation time, or immutable capability anchor when initial registration was required. */
    timestamp: number;
    /** Host observed that this objective required checks but had none yet. */
    initialAcceptanceRegistrationRequired?: true;
  };
  /** Stable identity of the root objective; old sessions fall back to userMessageId. */
  objectiveId?: string;
  /** Original user message that defines the invariant objective. */
  userMessageId: string;
  /** Most recent visible user message folded into this objective. */
  lastUserMessageId?: string;
  startedAt: number;
  /** Lifetime session cost when this objective started. */
  budgetBaselineUsd: number;
  /** Lifetime session token total when this objective started. */
  tokenBaseline: number;
  continuationCount: number;
  orchestrationMode: 'direct' | 'mission';
  risk: 'standard' | 'high-stakes';
  /** Objective explicitly asks for a mutation/build/deployment, so prose alone is insufficient. */
  requiresExecutionEvidence?: boolean;
  /** Persisted evidence subject only; this never grants mutation authority by itself. */
  evidenceDomain?: 'legal' | 'financial' | 'medical' | 'security';
  evidenceRequirement?: 'authoritative-sources-before-mutation';
  completionCriteria: Array<
    | 'requested-outcome-delivered'
    | 'relevant-checks-passed'
    | 'no-safe-work-remaining'
    | 'independent-review-passed'
  >;
  terminalState: SessionObjectiveTerminalState;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** Last host-validated terminal declaration, when one has been received. */
  lastOutcome?: ObjectiveOutcomeDeclaration;
  completedAt?: number;
}

export type ExternalActionAuthorizationCategory =
  | 'git_push'
  | 'deployment'
  | 'service_restart'
  | 'secret_transfer'
  | 'external_send'
  | 'external_publication'
  | 'external_mutation'
  | 'payment';

/** Durable grant scoped to one sensitive action category and concrete target. */
export interface ExternalActionAuthorization {
  category: ExternalActionAuthorizationCategory;
  targetCandidates: string[];
  toolName: string;
  /** SHA-256 over the exact tool and canonical action input; never raw content. */
  operationHash: string;
  grantedAt: number;
  expiresAt: number;
}

/**
 * Session status (user-controlled, never automatic)
 *
 * Dynamic status ID referencing workspace status config.
 * Validated at runtime via validateSessionStatus().
 * Falls back to 'todo' if status doesn't exist.
 */
export type SessionStatus = string;

/**
 * Built-in status IDs (for TypeScript consumers)
 * These are the default statuses but users can add/remove custom ones
 */
export type BuiltInStatusId = 'todo' | 'in-progress' | 'needs-review' | 'done' | 'cancelled';

/**
 * Session token usage tracking
 */
export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Model's context window size in tokens (from SDK modelUsage) */
  contextWindow?: number;
}

/**
 * App build that created or most recently persisted a session.
 * Optional on sessions written before build provenance was introduced.
 */
export interface SessionAppProvenance {
  appVersion: string;
  buildCommit?: string;
  buildChannel?: string;
  /** Whether uncommitted changes were present when this build was produced. */
  buildDirty?: boolean;
  isPackaged: boolean;
}

/**
 * Stored message format (simplified for persistence)
 * Re-exported from @craft-agent/core for convenience
 */
export type { StoredMessage } from '@craft-agent/core/types';

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
