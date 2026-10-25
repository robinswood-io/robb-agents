import type { ActiveSessionObjective, PendingTurnRecovery } from "@craft-agent/shared/sessions";

export type AutomaticTurnRecoveryCause = NonNullable<PendingTurnRecovery['lastCause']>;

/** Absolute fail-safe in addition to the configured retry limit and wall-clock lease. */
export const MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS = 8;

export const DEFAULT_AUTOMATIC_TURN_RECOVERY_ATTEMPTS = 4;

/** Even a productive continuation remains bounded independently of a more
 * permissive workspace recovery policy; semantic stagnation can stop it sooner. */
export const MAX_OBJECTIVE_CONTINUATION_ATTEMPTS = 4;

export const MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS = 2;

export const DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS = 6 * 60 * 60 * 1000;

export const DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

export const MIN_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS = 30 * 1000;

export const MAX_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export const TOOL_RESULT_GRACE_MS = 30 * 1000;

export const STRUCTURED_OUTCOME_FINAL_REMINDER =
  'End the final user-facing response with exactly one single-line HTML comment: <!-- robb_objective_outcome {"state":"continue","criteria":[{"id":"<exact required criterion ID>","satisfied":false,"evidence":[]}],"remainingWork":["next concrete step"],"blocker":null} -->. Include every required criterion ID, use only observed evidence, and choose complete_verified or a proven blocker only when its contract is satisfied. A JSON file or prose is not this final receipt.';

export type AutomaticTurnRecoveryLimitReason =
  | 'disabled'
  | 'history-unavailable'
  | 'invalid-strategy-state'
  | 'already-exhausted'
  | 'strategy-attempt-limit'
  | 'absolute-attempt-limit'
  | 'strategy-stagnation'
  | 'lease-expired'
  | 'explicit-allowance-unavailable';

export type AutomaticTurnRecoveryPlan =
  | { action: 'dispatch'; recovery: PendingTurnRecovery }
  | {
      action: 'replan' | 'escalate';
      recovery: PendingTurnRecovery;
      reason: 'strategy-attempt-limit' | 'strategy-stagnation';
    }
  | {
      action: 'clean-continuation';
      recovery: PendingTurnRecovery;
      reason: 'absolute-attempt-limit';
    }
  | { action: 'halt'; recovery: PendingTurnRecovery; reason: AutomaticTurnRecoveryLimitReason };

export interface AutomaticTurnRecoveryPlanInput {
  pending: PendingTurnRecovery;
  cause: AutomaticTurnRecoveryCause;
  objective?: ActiveSessionObjective;
  nowMs?: number;
  maxAttempts?: number;
  progressFingerprint?: string;
  maxStagnantAttempts?: number;
  leaseDurationMs?: number;
  absoluteMaxAttempts?: number;
  explicitContext?: { objectiveId: string; semanticProgressFingerprint: string };
}

export interface CleanRecoveryContinuationEvidence {
  /** Host-validated tool, message, review, or acceptance reference. */
  reference: string;
  /** Concise fact established by that reference; never a raw provider/tool transcript. */
  summary: string;
}

export interface CleanRecoveryContinuationHandoff {
  schemaVersion: 1;
  /** Deterministic identity: replaying the same bounded facts yields the same id. */
  id: string;
  objective: {
    objectiveId: string;
    rootUserMessageId: string;
    lastUserMessageId: string;
    originalRequest: string;
    amendments: Array<{ messageId: string; text: string }>;
    orchestrationMode: ActiveSessionObjective['orchestrationMode'];
    risk: ActiveSessionObjective['risk'];
    delegatedRole?: ActiveSessionObjective['delegatedRole'];
    procedure?: ActiveSessionObjective['procedure'];
    requirements: {
      execution: boolean;
      observation: boolean;
      acceptance: boolean;
      evidenceDomain?: ActiveSessionObjective['evidenceDomain'];
      evidenceRequirement?: ActiveSessionObjective['evidenceRequirement'];
    };
    completionCriteria: ActiveSessionObjective['completionCriteria'];
    /** The previous target-bound acceptance contract is stale and must be
     * re-registered before any completion claim in the fresh context. */
    acceptanceNeedsReview?: true;
    acceptanceCriteria?: NonNullable<ActiveSessionObjective['acceptanceCriteria']>;
    outcomeCriteria: NonNullable<ActiveSessionObjective['lastOutcome']>['criteria'];
  };
  recovery: {
    sourceUserMessageId: string;
    sourceAttempts: number;
    cause?: AutomaticTurnRecoveryCause;
    strategyPhase: 'resume' | 'replan' | 'escalate';
    progressFingerprint?: string;
  };
  evidence: CleanRecoveryContinuationEvidence[];
  remainingWork: string[];
}

export interface CleanRecoveryContinuationHandoffInput {
  objective: ActiveSessionObjective;
  pending: PendingTurnRecovery;
  /** Required for legacy objectives whose original request was not persisted. */
  objectiveText?: string;
  /** Facts already validated by the host. Raw tool output must not be supplied. */
  evidence: readonly CleanRecoveryContinuationEvidence[];
  /** Must exactly match the current host-validated `continue` receipt. */
  remainingWork: readonly string[];
}

export const MAX_CLEAN_CONTINUATION_SERIALIZED_CHARS = 48_000;

export const MAX_CLEAN_CONTINUATION_OBJECTIVE_CHARS = 16_000;

export const MAX_CLEAN_CONTINUATION_AMENDMENTS = 16;

export const MAX_CLEAN_CONTINUATION_AMENDMENT_CHARS = 4_000;

export const MAX_CLEAN_CONTINUATION_CRITERIA = 32;

export const MAX_CLEAN_CONTINUATION_EVIDENCE = 32;

export const MAX_CLEAN_CONTINUATION_REMAINING_WORK = 16;

export const MAX_CLEAN_CONTINUATION_FACT_CHARS = 2_000;

export const MAX_CLEAN_CONTINUATION_ID_CHARS = 512;
