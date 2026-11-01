import type { LegacyAutomaticModelTier } from "../../config/selection-provenance.ts";
import type { ThinkingLevel } from "../../agent/thinking-levels.ts";
import type { ObjectiveOutcomeDeclaration, ObjectiveOutcomeState, ObjectiveAcceptanceCriterion, ObjectiveProcedureId } from "@craft-agent/core/types";
import type { PendingTurnRecovery } from './turn-recovery.ts';

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
