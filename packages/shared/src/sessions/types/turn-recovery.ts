import type { ContextCompactionOutcome } from './capability-locks.ts';

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
