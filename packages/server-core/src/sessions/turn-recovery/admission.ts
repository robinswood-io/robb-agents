import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { PendingTurnRecovery } from "@craft-agent/shared/sessions";
import { automaticRecoveryLimitReason, automaticRecoveryProgressState, hasAvailableExplicitRetryAllowance, latestExplicitRetryAllowance } from './budget.ts';
import { validRecoveryStrategy } from './clean-continuation.ts';
import type { AutomaticTurnRecoveryCause, AutomaticTurnRecoveryPlan, AutomaticTurnRecoveryPlanInput } from './contracts.ts';
import { DEFAULT_AUTOMATIC_TURN_RECOVERY_ATTEMPTS, DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS, MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS, MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS } from './contracts.ts';

export function advancePendingTurnRecovery(
  pending: PendingTurnRecovery,
  cause: AutomaticTurnRecoveryCause,
  nowMs = Date.now(),
  maxAttempts = DEFAULT_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
  progressFingerprint?: string,
  maxStagnantAttempts = MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS,
  leaseDurationMs = DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS,
  absoluteMaxAttempts = MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
  explicitContext?: { objectiveId: string; semanticProgressFingerprint: string },
): PendingTurnRecovery | null {
  const configuredAttemptLimit = Math.max(0, Math.floor(maxAttempts));
  const absoluteAttemptLimit = Math.min(
    MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
    Math.max(1, Math.floor(absoluteMaxAttempts)),
  );
  if (pending.explicitRetryAllowances !== undefined) {
    const grant = latestExplicitRetryAllowance(pending, explicitContext?.objectiveId);
    if (!grant || !hasAvailableExplicitRetryAllowance(pending, explicitContext?.objectiveId, nowMs)
      || pending.attempts >= absoluteAttemptLimit
      // Spending another recovery call requires substantive new evidence, not
      // failed calls, repeated observations, waits, or the checkpoint itself.
      || (cause === 'tool_checkpoint' && (!explicitContext?.semanticProgressFingerprint
        || explicitContext.semanticProgressFingerprint === grant.semanticProgressFingerprint))) return null;
    const advanced = advancePendingTurnRecovery({
      userMessageId: pending.userMessageId, startedAt: grant.authorizedAt,
      attempts: grant.attempts, leaseExpiresAt: grant.leaseExpiresAt,
      ...(grant.lastProgressFingerprint !== undefined ? { lastProgressFingerprint: grant.lastProgressFingerprint } : {}), stagnantAttempts: grant.stagnantAttempts,
    }, cause, nowMs, Math.min(configuredAttemptLimit, grant.maxAttempts), progressFingerprint,
    maxStagnantAttempts, leaseDurationMs, absoluteAttemptLimit);
    if (!advanced) return null;
    return {
      ...pending, attempts: pending.attempts + 1, lastAttemptAt: nowMs, lastCause: cause,
      explicitRetryAllowances: [...pending.explicitRetryAllowances.slice(0, -1), omitUndefined<NonNullable<PendingTurnRecovery['explicitRetryAllowances']>[number]>({
        ...grant, attempts: advanced.attempts, stagnantAttempts: advanced.stagnantAttempts ?? 0,
        lastProgressFingerprint: advanced.lastProgressFingerprint, lastProgressAt: advanced.lastProgressAt ?? grant.lastProgressAt,
        semanticProgressFingerprint: explicitContext!.semanticProgressFingerprint,
      })],
      ...(pending.continuationRequired ? { continuationRequired: false } : {}),
    };
  }
  const leaseExpiresAt = pending.leaseExpiresAt
    ?? nowMs + Math.max(0, Math.floor(leaseDurationMs));
  const pendingWithLease = pending.leaseExpiresAt === undefined
    ? { ...pending, leaseExpiresAt }
    : pending;
  const limitReason = automaticRecoveryLimitReason(
    pendingWithLease,
    nowMs,
    configuredAttemptLimit,
    absoluteAttemptLimit,
    maxStagnantAttempts,
    progressFingerprint,
  );
  if (limitReason) {
    return null;
  }

  const progress = automaticRecoveryProgressState(pending, progressFingerprint);
  return omitUndefined<PendingTurnRecovery>({
    ...pending,
    leaseExpiresAt,
    attempts: pending.attempts + 1,
    lastAttemptAt: nowMs,
    lastCause: cause,
    ...(progress.madeProgress ? { lastProgressAt: nowMs } : {}),
    ...(progress.comparable ? {
      lastProgressFingerprint: progressFingerprint,
      stagnantAttempts: progress.stagnantAttempts,
    } : {}),
    ...(pending.continuationRequired ? { continuationRequired: false } : {}),
  });
}

/**
 * Decide what the host should do when continuing an interrupted objective.
 * Unlike the legacy nullable allocator, this keeps a per-strategy ceiling from
 * being mistaken for objective exhaustion. Only a host-validated, unblocked
 * `continue` outcome may cross into replan/escalation or a fresh continuation.
 * Explicit Retry grants, malformed history, expired leases and real blockers
 * stay fail-closed.
 */
export function planAutomaticTurnRecovery(
  input: AutomaticTurnRecoveryPlanInput,
): AutomaticTurnRecoveryPlan {
  const nowMs = input.nowMs ?? Date.now();
  const maxAttempts = input.maxAttempts ?? DEFAULT_AUTOMATIC_TURN_RECOVERY_ATTEMPTS;
  const maxStagnantAttempts = input.maxStagnantAttempts
    ?? MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS;
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS;
  const absoluteMaxAttempts = Math.min(
    MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
    Math.max(1, Math.floor(input.absoluteMaxAttempts ?? MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS)),
  );
  const advanced = advancePendingTurnRecovery(
    input.pending,
    input.cause,
    nowMs,
    maxAttempts,
    input.progressFingerprint,
    maxStagnantAttempts,
    leaseDurationMs,
    absoluteMaxAttempts,
    input.explicitContext,
  );
  if (advanced) return { action: 'dispatch', recovery: advanced };

  const configuredAttemptLimit = Math.max(0, Math.floor(maxAttempts));
  const leaseExpiresAt = input.pending.leaseExpiresAt
    ?? nowMs + Math.max(0, Math.floor(leaseDurationMs));
  const pendingWithLease = input.pending.leaseExpiresAt === undefined
    ? { ...input.pending, leaseExpiresAt }
    : input.pending;
  const reason = input.pending.explicitRetryAllowances !== undefined
    ? 'explicit-allowance-unavailable' as const
    : automaticRecoveryLimitReason(
        pendingWithLease,
        nowMs,
        configuredAttemptLimit,
        absoluteMaxAttempts,
        maxStagnantAttempts,
        input.progressFingerprint,
      ) ?? 'strategy-attempt-limit';

  const outcome = input.objective?.lastOutcome;
  const pendingBelongsToObjective = input.pending.userMessageId === input.objective?.userMessageId
    || input.pending.userMessageId === input.objective?.lastUserMessageId;
  const safeValidatedContinuation = input.objective?.terminalState === 'active'
    && pendingBelongsToObjective
    && outcome?.state === 'continue'
    && outcome.blocker == null
    && outcome.remainingWork.length > 0;
  const strategyBoundary = reason === 'strategy-attempt-limit'
    || reason === 'strategy-stagnation';
  if (!safeValidatedContinuation || !strategyBoundary && reason !== 'absolute-attempt-limit') {
    return { action: 'halt', recovery: pendingWithLease, reason };
  }

  const currentPhase = validRecoveryStrategy(input.pending)?.phase ?? 'resume';
  if (strategyBoundary && currentPhase !== 'escalate') {
    const nextPhase = currentPhase === 'resume' ? 'replan' as const : 'escalate' as const;
    const transitioned: PendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
      ...pendingWithLease,
      lastCause: input.cause,
      stagnantAttempts: 0,
      continuationRequired: true,
      recoveryDispatch: undefined,
      recoveryStrategy: {
        schemaVersion: 1,
        phase: nextPhase,
        attemptBaseline: input.pending.attempts,
        transitionCount: (validRecoveryStrategy(input.pending)?.transitionCount ?? 0) + 1,
        transitionedAt: nowMs,
        reason: reason === 'strategy-stagnation' ? 'stagnation' : 'attempt-limit',
      },
    });
    return { action: nextPhase, recovery: transitioned, reason };
  }

  const verifiedNewProgress = input.progressFingerprint !== undefined
    && input.pending.lastProgressFingerprint !== undefined
    && input.progressFingerprint !== input.pending.lastProgressFingerprint;
  if (reason === 'absolute-attempt-limit' && verifiedNewProgress
    && (input.pending.cleanContinuationCount ?? 0) < 1) {
    const cleanContinuation: PendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
      ...input.pending,
      startedAt: nowMs,
      attempts: 0,
      cleanContinuationCount: (input.pending.cleanContinuationCount ?? 0) + 1,
      leaseExpiresAt: undefined,
      lastAttemptAt: undefined,
      lastCause: input.cause,
      lastProgressAt: nowMs,
      lastProgressFingerprint: input.progressFingerprint,
      stagnantAttempts: 0,
      continuationRequired: true,
      recoveryDispatch: undefined,
      recoveryStrategy: undefined,
      exhaustedAt: undefined,
      validationExhausted: undefined,
    });
    return {
      action: 'clean-continuation',
      recovery: cleanContinuation,
      reason: 'absolute-attempt-limit',
    };
  }

  return {
    action: 'halt',
    recovery: pendingWithLease,
    reason: reason === 'strategy-stagnation' || reason === 'strategy-attempt-limit'
      ? reason
      : 'absolute-attempt-limit',
  };
}
