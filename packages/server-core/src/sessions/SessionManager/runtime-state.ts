import type { EventSink, RpcServer } from "@craft-agent/server-core/transport";
import type { IBrowserPaneManager } from "@craft-agent/server-core/handlers";
import { RemoteBrowserPaneManager } from "../RemoteBrowserPaneManager";
import { type UserInputResponseResult } from "@craft-agent/core";
import { type AuthRequest, resolveKeepBackgroundTasksAlive } from "@craft-agent/shared/agent";
import { PrivilegedExecutionBroker } from "@craft-agent/server-core/services";
import { InitGate } from "@craft-agent/server-core/domain";
import { type PendingTurnRecovery, type ActiveSessionObjective, type ExternalActionAuthorizationCategory } from "@craft-agent/shared/sessions";
import { ConfigWatcher } from "@craft-agent/shared/config";
import { type SendMessageOptions, type PermissionRequest } from "@craft-agent/shared/protocol";
import { type Message } from "@craft-agent/core/types";
import { AutomationSystem } from "@craft-agent/shared/automations";
import { ExecutionProofCollector } from "../execution-proof-collector";
import { GenerationTelemetryLifecycle, type ExecutionTelemetrySink } from "@craft-agent/shared/telemetry";
import { ActiveDelegationDeduplicator } from "../review-delegation-policy";
import { type SpawnSessionResult } from "@craft-agent/shared/agent";
import { DelegationBudget } from "../delegation-budget";
import { type AutonomyFallbackIntent } from "../autonomy-browser-fallback";
import type { ManagedSession } from "./managed-session.ts";
import { sessionLog } from "./runtime-platform.ts";
import type { PendingDelta } from "./runtime-policy.ts";
import { resolveSessionRuntimeIdleTimeoutMs } from "./runtime-policy.ts";
import type { AgentInstance, MissionPendingTurnRecoveryClaimRecord, SessionCompletionEvent } from "./runtime-types.ts";

/** Internal session data; initialization order matches the manager. */
export class SessionRuntimeState {
  sessions: Map<string, ManagedSession> = new Map()
  /** Managed objects detached by an explicit deletion. Late completion and
     * metadata callbacks may still hold the object, but must never persist it. */
  readonly retiringSessions = new WeakSet<ManagedSession>()
  /** Async work which can still touch session-owned files after its callback
     * has started. Deletion closes admission first, then drains this exact set
     * before moving the directory. */
  readonly sessionOperationsInFlight = new WeakMap<ManagedSession, Set<Promise<unknown>>>()
  /** Mutations which do not yet own a ManagedSession (notably create/import).
     * Shutdown closes their admission synchronously and drains them before taking
     * its session snapshot. */
  readonly managerOperationsInFlight = new Set<Promise<unknown>>()
  /** Deletions detach from `sessions` before awaiting runtime/filesystem work.
     * Keep their promises visible so shutdown cannot finish before they commit. */
  readonly sessionDeletionsInFlight = new Map<string, Promise<void>>()
  /** In-memory single-owner handoff from MissionRuntime to the generic bounded
     * recovery engine. The durable PendingTurnRecovery remains the work record. */
  readonly missionPendingTurnRecoveryClaims = new Map<
      string,
      MissionPendingTurnRecoveryClaimRecord
    >()
  readonly missionRuntimeOwnedRestoredRecoverySessionIds = new Set<string>()
  /** Non-serializable capability used only by the hard context admission gate. */
  readonly contextLimitUserInputCapability = Symbol('context-limit-user-input')
  readonly delegationBudget = new DelegationBudget()
  objectiveSnapshots = new WeakMap<ManagedSession, string>()
  readonly executionProofCollector = new ExecutionProofCollector()
  // Delta batching for performance - reduces IPC events from 50+/sec to ~20/sec
  pendingDeltas: Map<string, PendingDelta> = new Map()
  deltaFlushTimers: Map<string, NodeJS.Timeout> = new Map()
  // Config watchers for live updates (sources, etc.) - one per workspace
  configWatchers: Map<string, ConfigWatcher> = new Map()
  // Automation systems for workspace event automations - one per workspace (includes scheduler, diffing, and handlers)
  automationSystems: Map<string, AutomationSystem> = new Map()
  completedChatRetentionTimer?: ReturnType<typeof setInterval>
  completedChatRetentionSweep?: Promise<void>
  retentionDeleting = new Set<string>()
  retentionStopping = false
  // Pending credential request resolvers (keyed by requestId)
  pendingCredentialResolvers: Map<string, (response: import('@craft-agent/shared/protocol').CredentialResponse) => void> = new Map()
  // Unified credential submissions are capabilities bound to one exact pending
    // request object. Keep the operation one-shot while its secure write is in
    // flight so a rapid second submit cannot store or complete it twice.
  credentialResponsesInFlight: Map<string, {
      request: AuthRequest
      operation: Promise<boolean>
    }> = new Map()
  oauthResponsesInFlight: Map<string, {
      request: AuthRequest
      flowId: string
      expiresAt: number
    }> = new Map()
  // Permission request metadata tracking (keyed by requestId)
  pendingPermissionRequests: Map<string, {
      sessionId: string
      type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
      commandHash?: string
      toolName?: string
      toolUseId?: string
      processingGeneration: number
      objectiveId?: string
      runtimeAgent?: AgentInstance
      requestedAt: number
      expiresAt: number
      request: PermissionRequest
      timeout: ReturnType<typeof setTimeout>
      sensitiveActionCategory?: ExternalActionAuthorizationCategory
      sensitiveActionTargets?: string[]
      sensitiveActionOperationHash?: string
    }> = new Map()
  // Workspace-scoped OTLP sinks. A sink is created only after explicit workspace opt-in.
  telemetrySinks: Map<string, ExecutionTelemetrySink> = new Map()
  /** Always-on, privacy-safe local operational telemetry (no prompts/tool payloads). */
  localTelemetrySinks: Map<string, ExecutionTelemetrySink> = new Map()
  // Local privacy-minimal routing observations. They never contain prompt/response bodies.
  
    // Enforces active → exactly-one-terminal generation telemetry transitions.
  generationTelemetryLifecycle = new GenerationTelemetryLifecycle()
  // Privileged approval binding + audit logger
  privilegedExecutionBroker = new PrivilegedExecutionBroker(sessionLog)
  // Session-local admin remember windows (exact command hash binding)
  adminRememberApprovals: Map<string, {
      createdAt: number
      expiresAt: number
      sourceRequestId: string
    }> = new Map()
  // Promise deduplication for lazy-loading messages (prevents race conditions)
  messageLoadingPromises: Map<string, Promise<void>> = new Map()
  /**
     * Track which session the user is actively viewing (per workspace).
     * Map of workspaceId -> sessionId. Used to determine if a session should be
     * marked as unread when assistant completes - if user is viewing it, don't mark unread.
     */
  activeViewingSession: Map<string, string> = new Map()
  /** Coordinates startup initialization waiters from IPC handlers. */
  initGate = new InitGate()
  // O(1) index: taskId → sessionId for background task output lookup (avoids O(n) session scan)
  taskOutputIndex: Map<string, string> = new Map()
  /**
     * WS2 keep-alive flag (default ON, opt-out via `CRAFT_KEEP_BG_AGENTS_ALIVE=0`).
     * When true, a persistent streaming query keeps the subprocess alive across
     * turns so background sub-agents survive, and orphaning is suppressed. When
     * false (kill-switch), sub-agents are bound to a single turn's subprocess and
     * die at turn end, so markOrphanedBackgroundTasks() flips still-running registry
     * entries to `orphaned` on turn completion. Resolved via the shared
     * `resolveKeepBackgroundTasksAlive` so the main process and the Claude backend
     * can never disagree about whether keep-alive is on.
     */
  readonly keepBackgroundTasksAlive: boolean = resolveKeepBackgroundTasksAlive()
  /**
     * Per-session in-flight runtime-refresh promise. Ensures `updateRuntimeConfig`
     * (or a dispose) cannot overlap with another refresh OR with a send-path
     * `getOrCreateAgent` on the same session. Without this serialization, a
     * `SAVE`-triggered refresh and a `sendMessage`-triggered refresh can both
     * see `agent.isProcessing()=false`, both fire `updateRuntimeConfig`, and the
     * subprocess can race the resulting `chat` against the still-pending update.
     */
  agentRefreshLocks: Map<string, Promise<void>> = new Map()
  /** Periodically releases lazy per-session agents, MCP pools and subprocesses. */
  runtimeEvictionTimer: NodeJS.Timeout | null = null
  runtimeEvictionSweepInFlight = false
  readonly runtimeIdleTimeoutMs = resolveSessionRuntimeIdleTimeoutMs()
  /** Runtime teardown is part of the strong Task child-retirement proof. The
     * session is detached synchronously, but its provider subprocess/MCP cleanup
     * may still be running and must not overlap a replacement attempt. */
  readonly runtimeDisposalsInFlight = new Map<string, Set<Promise<void>>>()
  /** A rejected raw destructor is not proof that its process stopped. Keep the
     * exact teardown callable as a retryable strong-retirement barrier until one
     * invocation succeeds. */
  readonly runtimeDisposalBarriers = new Map<string, Map<symbol, {
      label: string
      dispose: () => void | Promise<void>
      inFlight?: Promise<void>
    }>>()
  /** Coalesce repeated strong Stop attempts while the first durable Stop is
     * still pending. A timed-out caller may retry the proof without launching a
     * second concurrent persistence/cancellation transaction. */
  readonly strongCancellationStops = new Map<string, {
      managed: ManagedSession
      operation: Promise<void>
      requiresCompletion: boolean
      generation: number
      stopCompleted: boolean
      stopFailed: boolean
      completionEvent?: SessionCompletionEvent
      completionGeneration?: number
      offCompletion: () => void
    }>()
  /** Monotonic clock to ensure strictly increasing message timestamps */
  lastTimestamp = 0
  /**
     * Optional binder installed by the messaging-gateway bootstrap. When set,
     * `executePromptAutomation` calls it after creating a session whose matcher
     * declared `telegramTopic`, so the new session is bound to a Telegram forum
     * topic in the workspace's paired supergroup. Best-effort — failures must
     * not block the session.
     */
  automationBinder?: (input: {
      workspaceId: string
      sessionId: string
      topicName: string
    }) => Promise<void>
  browserPaneManager: IBrowserPaneManager | null = null
  rpcServer: RpcServer | null = null
  remoteBpms = new Map<string, RemoteBrowserPaneManager>()
  /** Pinned desktop client per session for `client:browser:invoke` routing. */
  browserHostByCanvas = new Map<string, string>()
  eventSink: EventSink | null = null
  readonly userInputResponsesInFlight = new Map<string, Promise<UserInputResponseResult>>()
  readonly retryTurnsInFlight = new Map<string, Promise<import('@craft-agent/shared/protocol').RetryTurnResult>>()
  /** Short durable transaction that consumes one non-replay provider fence.
     * Stop records cancellation first and then waits for this promise so it can
     * tombstone/quarantine the restored marker in its own snapshot. */
  readonly providerRetryReconciliationTransactions = new Map<string, Promise<'turn' | undefined>>()
  /** Live counterpart of the cold non-replay transaction. Stop and new sends
     * wait behind this short fsync boundary instead of observing a removed WAL
     * before its generic successor exists. */
  readonly providerLiveReconciliationTransactions = new Map<string, Promise<boolean>>()
  /** Exact hidden recovery rows appended by sends that have not crossed the
     * synchronous agent.chat boundary yet. Stop removes these identities in its
     * own durable snapshot; unrelated hidden/user/agent messages are untouched. */
  readonly syntheticAutomaticMessagesInFlight = new WeakMap<ManagedSession, Set<Message>>()
  /** Non-serializable authority from an actual Retry invocation or an exact
     * host-authenticated cold reconstruction, never from a queued option. */
  readonly explicitRetryAllowanceTokens = new Map<symbol, {
      sessionId: string
      objectiveId: string
      userMessageId: string
      cancellationEpoch: number
      /** Exact host prompt that this Retry may consume while opening one fresh
       * provider boundary. Neither SendMessageOptions nor prompt text mints it. */
      contextLimitRequestId?: string
      cleanBoundaryMessageId?: string
      cleanContinuationId?: string
      /** False when resuming an allowance already committed by an earlier
       * process; cold recovery must not mint or reset a Retry budget. */
      grantNewAllowance?: boolean
      /** A recovered clean Retry may cross an already durable machine-only
       * inbox. The capability never authorizes a human row, question, decision,
       * or an unverified queue shape. */
      allowRetainedMachineInbox?: boolean
    }>()
  readonly deferredAutomaticSessions = new Set<string>()
  readonly automaticAdmissionReservations = new Set<string>()
  /** Hydration has queued one atomic provider-fence -> generic-continuation
     * snapshot, but the durable barrier has not completed yet. No live admission
     * may observe the optimistic in-memory state during that window. */
  readonly coldProviderReconciliationsInFlight = new Set<string>()
  /** Every queued snapshot advances this revision, including in-place auth or
     * question changes whose object references stay stable. Async rollback may
     * restore an older clone only while this exact revision is still current. */
  readonly sessionPersistenceEpochs = new WeakMap<ManagedSession, number>()
  /** Exact accepted receipts being tombstoned by an explicit user Stop. While
     * the snapshot is crossing fsync, neither FIFO nor a new human turn may
     * observe the marker as already retired. */
  readonly providerStopTransitionsInFlight = new Set<string>()
  readonly pendingSpawnRoots = new Map<symbol, string>()
  automaticAdmissionDrain?: Promise<void>
  automaticAdmissionWakeScheduled = false
  automaticAdmissionDrainWakeRequested = false
  /** A scheduler I/O/runtime failure must not require an unrelated UI or child
     * event to wake the retained work. Timers are runtime-only; the durable FIFO
     * or PendingTurnRecovery remains the source of truth across process restarts. */
  readonly deferredAutomaticRetryAttempts = new Map<string, number>()
  readonly deferredAutomaticRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** A failed fsync must never be followed by provider admission from the
     * newer in-memory allocation. Only a fresh human Retry may clear this fence. */
    /** A failed durability write fences only the exact allocation whose bounded
     * setup failure could not be committed. A later objective/dispatch in the
     * same session must not inherit that in-memory fault. */
  readonly cleanRetrySetupPersistenceFences = new Map<string, string>()
  /** A restored agent receipt whose rollback fsync was uncertain cannot be
     * admitted again in this process. The receipt also carries a durable marker
     * when storage becomes available, so Retry can clear it transactionally. */
  readonly agentDeliverySetupPersistenceFences = new Map<string, string>()
  readonly delegatedTerminalResultRetryAttempts = new Map<string, number>()
  readonly delegatedTerminalResultRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
     * Listeners for the in-process session-completion seam (see SessionCompletionEvent).
     * Used by the Tasks Conductor; empty until something subscribes, so zero overhead otherwise.
     */
  sessionCompletionListeners = new Set<(evt: SessionCompletionEvent) => void>()
  sessionWaitListeners = new Set<(sessionId: string) => void>()
  activeDelegations = new ActiveDelegationDeduplicator<SpawnSessionResult>()
  terminalReviewDispatchReservations = new Set<string>()
  /**
     * Process the next message in the queue.
     * Called by onProcessingStopped when queue has messages.
     */
  queuedMessageDispatches = new Map<string, symbol>()
  /** Exact private ownership for an agent receipt after FIFO dequeue and before
     * its durable queued -> processing transition. Keyed by the immutable message
     * id so a late append rollback cannot touch another reservation or turn. */
  readonly queuedAgentDeliveryDispatches = new Map<string, {
      sessionId: string
      deliveryId: string
      dispatchToken: symbol
      claimed: boolean
      claimDurable?: boolean
      providerStarted: boolean
      providerDispatchUncertain?: boolean
      attemptsBeforeClaim?: number
      dispatchSettled: boolean
    }>()
  /** Fresh append durability fences currently capable of observing and
     * cancelling an exact unclaimed dequeue. */
  readonly agentDeliveryAppendsInFlight = new Set<string>()
  readonly permissionInboxRetryDispatches = new Set<symbol>()
  /** One-shot capability reconstructed from an auth-blocked durable human FIFO. */
  readonly coldAuthHumanContinuationSessions = new WeakSet<ManagedSession>()
  /** Non-persisted authority minted only after a live visible message and its
     * handoff supersession have crossed the durability fence. */
  readonly liveDirectHumanContinuationIds = new WeakMap<ManagedSession, Set<string>>()
  /** Prevent a processing-stop callback from draining the FIFO while the
     * message + fail-closed handoff transition is still being flushed. */
  readonly directHumanSupersessionsInFlight = new WeakSet<ManagedSession>()
  /** Per-session transaction tail. A later direct send must observe either the
     * committed supersession or the fully rolled-back handoff of the prior send. */
  readonly directHumanSupersessionTransactions = new WeakMap<ManagedSession, Promise<void>>()
  /** Serializes mid-turn source activation commits and their rollback. A newer
     * objective can revoke the current transaction, but cannot observe or commit
     * another source configuration until the revoked transaction restored the
     * prior runtime snapshot. */
  readonly sourceActivationTransactions = new WeakMap<ManagedSession, Promise<void>>()
  readonly turnCancellationEpochs = new WeakMap<ManagedSession, number>()
  /** Invalidates asynchronous tool preparation as soon as a direct human turn
     * supersedes the instruction that started it, independently of Stop. */
  readonly objectiveAuthorityEpochs = new WeakMap<ManagedSession, number>()
  readonly terminalInvocationCapabilities = new Map<string, {
      managed: ManagedSession
      agent: AgentInstance | null | undefined
      generation: number
      authorityEpoch: number
      objective: ActiveSessionObjective
      scope: {
        allowInitialCriteriaRegistration: boolean
        allowReviewerSpawn: boolean
        waitReviewerSessionIds: readonly string[]
      }
      expiresAt: number
    }>()
  /** Private parent-to-child dispatch ownership. The symbol never enters the
     * child prompt, transcript, persisted metadata or an RPC payload. */
  readonly delegatedDispatchContinuations = new Map<symbol, {
      parent: ManagedSession
      child: ManagedSession
      objective: ActiveSessionObjective | undefined
      authorityEpoch: number
      parentGeneration: number
      reviewBinding?: { objectiveId: string; acceptanceSha256: string }
      expiresAt: number
    }>()
  /** Private, non-serializable ownership for an auth result/retry continuation.
     * The symbol never enters options, transcript or an RPC payload. */
  readonly authenticatedInternalContinuations = new Map<symbol, {
      managed: ManagedSession
      objective: ActiveSessionObjective
      objectiveId: string
      objectiveRevision: string
      authorityEpoch: number
      cancellationEpoch: number
      generation: number
      agent: AgentInstance | null | undefined
      kind: 'auth-result' | 'auth-retry'
      claimedGeneration?: number
      expiresAt: number
    }>()
  /** Runtime ownership only; persisted old tool rows cannot authorize a new continuation. */
  readonly checkpointToolStarts = new WeakMap<ManagedSession, {
      generation: number
      calls: Map<string, {
        objective: ActiveSessionObjective
        objectiveId: string
        acceptanceRevision: string
        acceptanceSha256: string
        authorityEpoch: number
        toolName: string
        /** One-shot in-memory claim consumed before the durability await. Pi can
         * publish tool_start before PreToolUse, but that live row may authorize
         * exactly one execute callback even while its receipt remains executing. */
        durableAdmissionClaimed?: true
      }>
    }>()
  shuttingDown = false
  /** During orderly shutdown, runtimes may still report the result of a tool
     * that already executed. This narrow gate remains open only until runtime
     * destruction is proven; every ordinary operation is rejected immediately. */
  shutdownTerminalResultAdmissionOpen = false
  cleanupPromise?: Promise<void>
  readonly restartRecoveriesInFlight = new Map<string, Promise<void>>()
  readonly permissionExpiryStopGenerations = new WeakMap<ManagedSession, number>()
  readonly permissionDeniedToolUseIdsByGeneration = new WeakMap<ManagedSession, Map<number, Set<string>>>()
  readonly runtimeProcessingGenerations = new WeakMap<AgentInstance, number>()
  /** Serializes the complete PreToolUse snapshot -> receipt -> fsync fence.
     * Without this tail, concurrent provider hooks can both inspect the same
     * pre-receipt snapshot and authorize two recovery mutations. */
  readonly toolAdmissionTransactions = new WeakMap<ManagedSession, Promise<void>>()
  /** Immutable provider-handoff owner for the PreToolUse durability ACK. */
  readonly runtimeToolAdmissionBindings = new WeakMap<AgentInstance, {
      managed: ManagedSession
      sessionId: string
      generation: number
      activeObjective: ActiveSessionObjective | undefined
      authorityEpoch: number
      userMessage: Message
      userMessageId: string
      messageCountAtHandoff: number
      lastSentOptions: SendMessageOptions | undefined
      automaticRecovery: SendMessageOptions['automaticRecovery']
      pendingTurnRecovery: PendingTurnRecovery | undefined
      recoveryDispatch: PendingTurnRecovery['recoveryDispatch']
      /** Host-authenticated fallback injected into the current provider turn.
       * This closes the ON -> redirect -> OFF admission race without treating
       * provider text as routing authority. */
      liveToolFallbackIntent?: AutonomyFallbackIntent
      /** A live provider steer may replace the objective/user boundary without
       * replacing the provider generation. Tool admission waits until that
       * replacement is fsynced, then observes the rebound boundary atomically. */
      pendingRebind?: Promise<void>
    }>()
}
