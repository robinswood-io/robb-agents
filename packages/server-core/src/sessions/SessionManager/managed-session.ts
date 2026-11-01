import { type UserInputRequest, type AutonomyEvent } from "@craft-agent/core";
import { type PermissionMode, type AuthRequest } from "@craft-agent/shared/agent";
import { type Workspace } from "@craft-agent/shared/config";
import { type ExternalActionPolicy } from "@craft-agent/shared/workspaces";
import { type SessionHeader, type SessionAppProvenance, type SessionPersistenceRootIdentity, type PendingTurnRecovery, type ActiveSessionObjective, type SessionDelegation, type ExternalActionAuthorization, type MissionCapabilityLock, type MissionOrdinaryRouteLock } from "@craft-agent/shared/sessions";
import { type LoadedSource, TokenRefreshManager } from "@craft-agent/shared/sources";
import { McpClientPool, McpPoolServer } from "@craft-agent/shared/mcp";
import { type FileAttachment, type SendMessageOptions } from "@craft-agent/shared/protocol";
import { type Message, type StoredAttachment, type RoutingMeta } from "@craft-agent/core/types";
import { type ThinkingLevel } from "@craft-agent/shared/agent/thinking-levels";
import { type WaitDiagnosticBoundary } from "../session-wait-diagnostic";
import { type ContextCompactionAttemptState } from "../context-compaction";
import type { SelectionSnapshot } from "@craft-agent/shared/config";
import type { AgentInstance, RunningBackgroundTask, RuntimeCompactionTelemetry, RuntimeGenerationTelemetryRef, SessionCompletionEvent } from './runtime-types.ts';

/** Live runtime slots can be explicitly cleared; persisted DTOs keep their omission rules. */
export interface ManagedSession {
  id: string
  workspace: Workspace
  /** Physical root captured when this runtime session was created. */
  readonly persistenceRootPath: string
  /** Device/inode proof preventing same-path workspace replacement. */
  readonly persistenceRootIdentity: SessionPersistenceRootIdentity
  /** Original lexical root used only for exact legacy project-memory scope keys. */
  readonly legacyProjectMemoryRootPath: string
  agent: AgentInstance | null  // Lazy-loaded - null until first message
  messages: Message[]
  isProcessing: boolean
  /** Set when user requests stop - allows event loop to drain before clearing isProcessing */
  stopRequested?: boolean | undefined
  lastMessageAt: number
  /** Last time this process used the lazily-created agent/MCP runtime. */
  runtimeLastActiveAt?: number | undefined
  streamingText: string
  streamingTurnId?: string | undefined
  // Incremented each time a new message starts processing.
  // Used to detect if a follow-up message has superseded the current one (stale-request guard).
  processingGeneration: number
  /** Generation that emitted a terminal provider error before its trailing complete event. */
  terminalErrorGeneration?: number | undefined
  /** Runtime receipts; explicit wait cursors also survive model compaction/restart. */
  waitCursors?: Record<string, string> | undefined
  lastWaitCompletion?: { generation: number; event: SessionCompletionEvent } | undefined
  /** Runtime transcript boundary for unverified diagnostics, never recovery authority. */
  waitDiagnosticBoundary?: WaitDiagnosticBoundary | undefined
  /** Generation intentionally ended so a newly activated source can restart the turn. */
  sourceActivationRestartGeneration?: number | undefined
  /** Runtime-only generation telemetry refs, keyed by processingGeneration. */
  executionTelemetryGenerations?: Map<number, RuntimeGenerationTelemetryRef> | undefined
  /** Runtime-only compaction spans, keyed by processingGeneration. */
  executionTelemetryCompactions?: Map<number, RuntimeCompactionTelemetry> | undefined
  /** Durable in-flight turn marker used for bounded automatic recovery. */
  pendingTurnRecovery?: PendingTurnRecovery | undefined
  /** Durable contract for the active user objective and its isolated budget. */
  pendingAgentDeliveryIds?: string[] | undefined
  pendingQueuedMessageIds?: string[] | undefined
  activeObjective?: ActiveSessionObjective | undefined
  userInputRequests?: UserInputRequest[] | undefined
  /** Durable Accept & Compact state; cleared atomically with an accepted user turn. */
  pendingPlanExecution?: {
    planPath: string
    draftInputSnapshot?: string
    awaitingCompaction: boolean
    executionDispatched?: boolean
  } | undefined
  /** Durable sensitive-action grants scoped to an exact category and target. */
  externalActionAuthorizations?: ExternalActionAuthorization[] | undefined
  // NOTE: Parent-child tracking state (pendingTools, parentToolStack, toolToParentMap,
  // pendingTextParent) has been removed. CraftAgent now provides parentToolUseId
  // directly on all events using the SDK's authoritative parent_tool_use_id field.
  // See: packages/shared/src/agent/tool-matching.ts
  // Session name (user-defined or AI-generated)
  name?: string | undefined
  isFlagged: boolean
  /** Whether this session is archived */
  isArchived?: boolean | undefined
  /** Recent autonomous-resolution evidence, persisted with the session. */
  autonomyEvents?: AutonomyEvent[] | undefined
  /** Browser fallback attempts already made during the current visible user turn. */
  autonomyFallbackAttemptedTools?: Set<string> | undefined
  /** Latest workspace policy waiting for the active provider stream to become idle. */
  pendingExternalActionPolicy?: ExternalActionPolicy | undefined
  /** Optional validated operational playbook bound to the session. */
  playbookSlug?: string | undefined
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number | undefined
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode | undefined
  /** Previous permission mode (preserved across restarts for session_state modeTransition context) */
  previousPermissionMode?: PermissionMode | undefined
  /** Centralized MCP client pool for this session's source connections */
  mcpPool?: McpClientPool | undefined
  /** HTTP MCP server exposing pool tools to external SDK subprocesses */
  poolServer?: McpPoolServer | undefined
  // SDK session ID for conversation continuity
  sdkSessionId?: string | undefined
  // Token usage for display
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
  } | undefined
  // Session status (user-controlled) - determines open vs closed
  // Dynamic status ID referencing workspace status config
  sessionStatus?: string | undefined
  // Read/unread tracking - ID of last message user has read
  lastReadMessageId?: string | undefined
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean | undefined
  // Per-session source selection (slugs of enabled sources)
  enabledSourceSlugs?: string[] | undefined
  // Runtime provenance: true when enabledSourceSlugs is a materialized
  // workspace default rather than an explicit session selection. Never
  // persist the materialized array or an unrelated metadata write would
  // silently freeze a formerly dynamic workspace fallback.
  inheritsWorkspaceSourceSlugs?: boolean | undefined
  // Labels applied to this session (additive tags, many-per-session)
  labels?: string[] | undefined
  // Workspace-scoped project binding (undefined = unbound)
  projectId?: string | undefined
  // Parent session id — when set, this session is a subtask of the parent (undefined = top-level task)
  delegation?: SessionDelegation | undefined
  parentSessionId?: string | undefined
  // Kanban board column id ('todo' | 'in-progress' | 'done'); independent of sessionStatus
  kanbanColumn?: string | undefined
  // Tasks Conductor: slug of the task spec this session belongs to (orchestrator + child nodes)
  taskSlug?: string | undefined
  // Tasks Conductor: id of the run that spawned this child session (child nodes only)
  taskRunId?: string | undefined
  // Tasks Conductor: id of the DAG node this child session executes (child nodes only)
  taskNodeId?: string | undefined
  // Tasks Conductor: total DAG node count (orchestrator only) — stable board progress denominator
  taskNodeCount?: number | undefined
  // Tasks Conductor: hidden generate-time orchestrator awaiting validated adoption (off the board)
  taskDraft?: boolean | undefined
  // Host-enforced tool isolation envelope for a Conductor child session
  executionIsolation?: import('@craft-agent/shared/tasks').SessionExecutionIsolation | undefined
  // Mission Orchestration v2 durable ownership and dispatch identity
  missionId?: string | undefined
  missionWorkItemId?: string | undefined
  missionDispatchId?: string | undefined
  missionRole?: 'planner' | 'worker' | 'reviewer' | 'supervisor' | undefined
  missionRouteLockSha256?: string | undefined
  missionOrdinaryRouteLock?: MissionOrdinaryRouteLock | undefined
  missionCapabilityLock?: MissionCapabilityLock | undefined
  /** Exact in-memory source config/guide snapshot consumed by the current governed turn. */
  missionTurnSourceSnapshot?: LoadedSource[] | undefined
  /** Exact skill bytes injected into the governed runtime; never re-opened by the model. */
  missionSealedSkillPackages?: Array<{ slug: string; name: string; content: string }> | undefined
  // Working directory for this session (used by agent for bash commands)
  workingDirectory?: string | undefined
  // SDK cwd for session storage - set once at creation, never changes.
  // Ensures SDK can find session transcripts regardless of workingDirectory changes.
  sdkCwd?: string | undefined
  // Shared viewer URL (if shared via viewer)
  sharedUrl?: string | undefined
  // Shared session ID in viewer (for revoke)
  sharedId?: string | undefined
  // Model to use for this session (overrides global config if set)
  model?: string | undefined
  // LLM connection slug for this session (locked after first message)
  llmConnection?: string | undefined
  // Durable provenance for a caller-selected connection. Router-selected
  // connections remain eligible for per-turn reevaluation.
  connectionRoutePinned?: boolean | undefined
  // Whether the connection is locked (cannot be changed after first agent creation)
  connectionLocked?: boolean | undefined
  // Thinking level for this session ('off', 'think', 'max')
  thinkingLevel?: ThinkingLevel | undefined
  // System prompt preset for mini agents ('default' | 'mini')
  systemPromptPreset?: 'default' | 'mini' | string | undefined
  // Role/type of the last message (for badge display without loading messages)
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error' | undefined
  // ID of the last final (non-intermediate) assistant message - pre-computed for unread detection
  lastFinalMessageId?: string | undefined
  // Turn baseline: last final assistant message ID at turn start (runtime-only, not persisted)
  turnStartFinalMessageId?: string | undefined
  /** Runtime-only status written by automatic lifecycle; explicit changes replace it and win. */
  turnLifecycleManagedStatus?: string | undefined
  // External session metadata updates seen while processing (applied after turn stop)
  pendingExternalMetadata?: SessionHeader | undefined
  // Guard: suppress external metadata revert after programmatic writes (setSessionStatus/setSessionLabels).
  // fs.watch fires during atomic write (unlink+rename) and can read stale data, reverting in-memory state.
  _metadataWriteGuardUntil?: number | undefined
  // Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration)
  // Used for shimmer effect on session title
  isAsyncOperationOngoing?: boolean | undefined
  // Preview of first user message (for sidebar display fallback)
  preview?: string | undefined
  // When the session was first created (ms timestamp from JSONL header)
  createdAt?: number | undefined
  // App build provenance (optional for legacy sessions)
  createdByApp?: SessionAppProvenance | undefined
  lastUsedByApp?: SessionAppProvenance | undefined
  // Total message count (pre-computed in JSONL header for fast list loading)
  messageCount?: number | undefined
  // Message queue for handling new messages while processing
  // When a message arrives during processing, we interrupt and queue
  messageQueue: Array<{
    message: string
    attachments?: FileAttachment[] | undefined
    storedAttachments?: StoredAttachment[] | undefined
    options?: SendMessageOptions | undefined
    messageId?: string | undefined  // Pre-generated ID for matching with UI
    optimisticMessageId?: string | undefined  // Frontend's ID for reliable event matching
  }>
  /** Runtime correlation for providers that accept a steer but later cannot deliver it. */
  pendingUserSteers?: Map<string, {
    queued: ManagedSession['messageQueue'][number]
    objectiveBefore?: ActiveSessionObjective
    objectiveAfter?: ActiveSessionObjective
    recoveryBefore?: PendingTurnRecovery
  }> | undefined
  // Map of shellId -> command for killing background shells
  backgroundShellCommands: Map<string, string>
  // Map of taskId -> output info for background task results
  backgroundTaskOutputs: Map<string, { outputFile: string; summary: string; status: string; completedAt: number }>
  // Registry of background tasks (running + recently-terminal) for this session.
  // Unlike backgroundTaskOutputs (which only stores COMPLETED tasks for output
  // retrieval), this tracks tasks from the moment they are backgrounded, so a
  // cross-subprocess "status?" query can enumerate what is actually live. The
  // SDK's in-subprocess task tools cannot answer this: their state dies with the
  // subprocess at turn end, so this main-process registry is the real source of
  // truth for background-task status. See RunningBackgroundTask.
  backgroundTaskRegistry: Map<string, RunningBackgroundTask>
  // Whether messages have been loaded from disk (for lazy loading)
  messagesLoaded: boolean
  // Pending auth request tracking (for unified auth flow)
  pendingAuthRequestId?: string | undefined
  pendingAuthRequest?: AuthRequest | undefined
  // Auth retry tracking (for mid-session token expiry)
  // Store last sent message/attachments to enable retry after token refresh
  lastSentMessage?: string | undefined
  lastSentAttachments?: FileAttachment[] | undefined
  lastSentStoredAttachments?: StoredAttachment[] | undefined
  lastSentOptions?: SendMessageOptions | undefined
  /** Runtime claim identity for a machine delivery. Unlike lastSentOptions,
   * this survives an accepted mid-turn human steer until the owning generation
   * stops and classifies the receipt. */
  activeAgentDelivery?: { deliveryId: string; generation: number } | undefined
  // Flag to prevent infinite retry loops (reset at start of each sendMessage)
  authRetryAttempted?: boolean | undefined
  // Flag indicating auth retry is in progress (to prevent complete handler from interfering)
  authRetryInProgress?: boolean | undefined
  // Whether this session is hidden from session list (e.g., mini edit sessions)
  hidden?: boolean | undefined
  branchFromMessageId?: string | undefined
  // Branch context strategy:
  // - sdk-fork: provider-level fork from parent SDK session
  // - seeded-fresh-session: fresh backend session seeded with transcript up to branch cutoff
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session' | undefined
  // Parent session's SDK session ID (used only when branchContextStrategy === 'sdk-fork')
  branchFromSdkSessionId?: string | undefined
  // Parent session's storage path (used only when branchContextStrategy === 'sdk-fork')
  branchFromSessionPath?: string | undefined
  // Parent session's sdkCwd — needed so the fork subprocess uses the correct
  // ~/.claude/projects/{cwd-hash}/ directory to find the parent's session file.
  branchFromSdkCwd?: string | undefined
  // SDK assistant message UUID at the branch point — used as resumeSessionAt
  // to trim the forked conversation at the branch point.
  branchFromSdkTurnId?: string | undefined
  // One-shot flag for seeded branch mode - set true after first turn seed injection.
  branchSeedApplied?: boolean | undefined
  // One-shot hidden summary injected on the first turn after a remote transfer.
  transferredSessionSummary?: string | undefined
  // Whether the transferred-session summary has already been injected.
  transferredSessionSummaryApplied?: boolean | undefined
  // Token refresh manager for OAuth token refresh with rate limiting
  tokenRefreshManager: TokenRefreshManager
  // Metadata for sessions created by automations
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number } | undefined
  // Promise that resolves when the agent instance is ready (for title gen to await)
  agentReady?: Promise<void> | undefined
  agentReadyResolve?: (() => void) | undefined
  // Per-session env overrides for SDK subprocess (e.g., ANTHROPIC_BASE_URL).
  // Stored on managed session so it persists across agent recreations (auth-retry, etc.)
  envOverrides?: Record<string, string> | undefined
  // Runtime-affecting backend config signature captured when the live agent was created/refreshed.
  backendRuntimeSignature?: string | undefined
  /**
   * Signature over fields that cannot be propagated via `update_runtime_config`
   * (see `runtime-config.ts:buildRestartRequiredSignature`). When this drifts,
   * the agent must be disposed + recreated rather than refreshed in place.
   */
  backendRestartSignature?: string | undefined
  // Whether the previous turn was interrupted (for context injection on next message).
  // Ephemeral — not persisted to disk. Cleared after one-shot injection.
  wasInterrupted?: boolean | undefined
  /**
   * Runtime-only: Pi SDK message id → Craft assistant message id.
   * Populated when a `text_complete` arrives carrying `sdkMessageId`, and read
   * when the follow-up `pi_turn_anchor` event arrives (deferred by one microtask
   * so the SDK's session-manager has updated its leaf — see craft-agents-oss#782).
   * Capped at PI_SDK_MESSAGE_ID_CACHE_LIMIT to bound memory in long sessions.
   */
  piSdkMessageToCraftMessage?: Map<string, string> | undefined
  // Runtime-only: annotate the next assistant response with why a route changed.
  pendingRoutingReason?: 'manual-handoff' | 'session-connection' | 'router' | string | undefined
  /** Durable host provenance for manual and task-computed model pins. */
  modelRoutePinned?: boolean | undefined
  /** Durable host provenance for a reasoning-only override. */
  thinkingLevelPinned?: boolean | undefined
  // Runtime-only: extra routing audit details for the next assistant response.
  pendingRoutingMeta?: Partial<RoutingMeta> | undefined
  /** Versioned model/thinking/profile decision captured before UI metadata is cleared. */
  pendingRoutingDecision?: SelectionSnapshot | undefined
  /** Durable backoff state preventing repeated compaction work across queued turns and restarts. */
  contextCompactionAttempt?: ContextCompactionAttemptState | undefined
  /** Durable lower transcript bound for provider fallback/recovery after a context reset. */
  providerContextBoundaryMessageId?: string | undefined
  // Runtime-only: policy-authorized fallback candidates for the current turn.
  pendingRoutingFallbackConnectionSlugs?: string[] | undefined
  // Runtime-only: provider failure emitted as a stream event. The handoff is
  // deferred until the current iterator completes so disposing its runtime
  // cannot deadlock event processing.
  pendingRuntimeProviderFallback?: {
    error: Error
    generation: number
  } | undefined
  // Runtime-only: bounded fallback attempts and per-turn loop prevention.
  routingFallbackAttempts?: number | undefined
  routingAttemptedConnectionSlugs?: Set<string> | undefined
  // Runtime-only: consecutive connection failures and cooldown windows.

  // Source-activation auto-retry (craft-agents-oss#804). When a source activates
  // mid-turn, we re-send the original message with a "[<slug> activated]" suffix
  // after a short delay. The pending slot lets `sendMessage` reject a duplicate
  // RPC from a legacy renderer while authenticating the server-owned dispatch.
  autoRetryTimer?: ReturnType<typeof setTimeout> | undefined
  autoRetryPending?: {
    content: string
    rawMessage: string
    deadlineMs: number
    tombstoneExpiresAt: number
    /** Durable objective ancestry copied into the persisted internal origin. */
    objectiveId: string
    objectiveRevision: string
    sourceSlug: string
    sourceActivationId: string
    generation: number
    cancellationEpoch: number
    messageCountAtSchedule: number
    /** Runtime-only capability held by the server timer. Text equality is not authority. */
    dispatchToken: symbol
    /** A reversible claim prevents the timer from dispatching twice across awaits. */
    dispatchInFlight: boolean
    dispatchAttempts: number
    messageId?: string
    providerStarted?: boolean
    /** True only after the hidden row has crossed its first durability fence. */
    committed: boolean
    /** Timer/objective was superseded; retain exact text only as a dedup tombstone. */
    cancelled: boolean
  } | undefined
  /** Runtime dedup history for mixed-version renderer retries. Bounded by count
   * and TTL so A remains rejected after B without swallowing human text forever. */
  autoRetryTombstones?: Array<{ content: string; expiresAt: number }> | undefined
  /** Clean, pre-enrichment input owned by the exact provider generation. */
  sourceActivationTurn?: {
    generation: number
    cancellationEpoch: number
    rawMessage: string
    objectiveId: string
    objectiveRevision: string
  } | undefined
}
