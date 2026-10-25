import type { Message } from "@craft-agent/core/types";
import type { PendingTurnRecovery } from "@craft-agent/shared/sessions";
import { createHash } from "node:crypto";
import { validRecoveryStrategy } from './clean-continuation.ts';
import type { AutomaticTurnRecoveryLimitReason } from './contracts.ts';
import { DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS, MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS } from './contracts.ts';

function recoveryStrategyAttemptBaseline(pending: PendingTurnRecovery): number {
  return validRecoveryStrategy(pending)?.attemptBaseline ?? 0;
}

export function automaticRecoveryProgressState(
  pending: PendingTurnRecovery,
  progressFingerprint: string | undefined,
): { comparable: boolean; madeProgress: boolean; stagnantAttempts: number } {
  const comparable = progressFingerprint !== undefined;
  const madeProgress = comparable
    && (pending.lastProgressFingerprint === undefined
      || progressFingerprint !== pending.lastProgressFingerprint);
  const stagnantAttempts = !comparable || madeProgress
    ? 0
    : (pending.stagnantAttempts ?? 0) + 1;
  return { comparable, madeProgress, stagnantAttempts };
}

export function automaticRecoveryLimitReason(
  pending: PendingTurnRecovery,
  nowMs: number,
  configuredAttemptLimit: number,
  absoluteAttemptLimit: number,
  maxStagnantAttempts: number,
  progressFingerprint: string | undefined,
): AutomaticTurnRecoveryLimitReason | undefined {
  if (pending.budgetHistoryUnavailable) return 'history-unavailable';
  if (pending.recoveryStrategy && !validRecoveryStrategy(pending)) return 'invalid-strategy-state';
  if (pending.exhaustedAt) return 'already-exhausted';
  if (configuredAttemptLimit <= 0) return 'disabled';
  if (pending.leaseExpiresAt !== undefined && nowMs >= pending.leaseExpiresAt) return 'lease-expired';
  if (pending.attempts >= absoluteAttemptLimit) return 'absolute-attempt-limit';

  const strategyAttempts = pending.attempts - recoveryStrategyAttemptBaseline(pending);
  if (strategyAttempts >= configuredAttemptLimit) return 'strategy-attempt-limit';

  const progress = automaticRecoveryProgressState(pending, progressFingerprint);
  if ((strategyAttempts > 0 || pending.stagnantAttempts !== undefined && pending.stagnantAttempts > 0)
    && progress.comparable
    && progress.stagnantAttempts >= Math.max(1, Math.floor(maxStagnantAttempts))) {
    return 'strategy-stagnation';
  }
  return undefined;
}

export function createPendingTurnRecovery(
  userMessageId: string,
  nowMs = Date.now(),
): PendingTurnRecovery {
  return {
    userMessageId,
    startedAt: nowMs,
    attempts: 0,
  };
}

const LEGACY_RECOVERY_OPEN = '<automatic_turn_recovery';

const LEGACY_RECOVERY_ROW = /^<automatic_turn_recovery original_user_message_id="([^"]+)" attempt="([1-9][0-9]*)">\n[\s\S]*\n<\/automatic_turn_recovery>$/;

/**
 * Reconstruct the counter omitted by legacy session headers only when the
 * durable transcript proves one exact, contiguous host recovery lineage. This
 * is deliberately narrower than parsing the prompt as general XML: malformed,
 * duplicated, cross-objective or over-cap rows keep the budget unavailable.
 */
export function reconstructLegacyTurnRecoveryBudget(
  messages: readonly Message[],
  userMessageId: string,
): PendingTurnRecovery | undefined {
  const anchorIndex = messages.findIndex(message => message.id === userMessageId
    && message.role === 'user' && !message.hidden && !message.isQueued && !message.isPending
    && !message.internalOrigin && !message.agentDelivery);
  if (anchorIndex < 0) return undefined;

  const attempts: Array<{ attempt: number; timestamp: number }> = [];
  let terminal: Message | undefined;
  for (const message of messages.slice(anchorIndex + 1)) {
    if (message.role === 'user' && !message.hidden && !message.isQueued && !message.isPending
      && !message.internalOrigin && !message.agentDelivery) return undefined;
    if (message.role === 'user' && message.hidden && message.content.startsWith(LEGACY_RECOVERY_OPEN)) {
      const match = LEGACY_RECOVERY_ROW.exec(message.content);
      if (!match || message.internalOrigin || message.agentDelivery || message.isQueued || message.isPending
        || match[1] !== userMessageId) return undefined;
      const attempt = Number(match[2]);
      if (!Number.isSafeInteger(attempt) || attempt > MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS
        || !Number.isFinite(message.timestamp)) return undefined;
      attempts.push({ attempt, timestamp: message.timestamp });
      continue;
    }
    if (message.role === 'error' && message.errorCode === 'objective_validation_failed'
      && message.errorCanRetry === true) terminal = message;
  }
  if (!terminal || !Number.isFinite(terminal.timestamp) || attempts.length === 0
    || attempts.some((entry, index) => entry.attempt !== index + 1)
    || attempts[0]!.timestamp <= messages[anchorIndex]!.timestamp
    || attempts.some((entry, index) => index > 0 && entry.timestamp <= attempts[index - 1]!.timestamp)
    || attempts[attempts.length - 1]!.timestamp >= terminal.timestamp) return undefined;

  return {
    userMessageId,
    startedAt: attempts[0]!.timestamp,
    attempts: attempts[attempts.length - 1]!.attempt,
    lastAttemptAt: attempts[attempts.length - 1]!.timestamp,
    lastCause: 'objective_incomplete',
    exhaustedAt: terminal.timestamp,
    validationExhausted: true,
    ...(terminal.errorDetails?.length ? {
      validationGaps: terminal.errorDetails.slice(0, 16).map(gap => gap.slice(0, 500)),
    } : {}),
  };
}

/** Compare host validation state, independently of incidental tool activity. */
export function turnRecoveryValidationFingerprint(validationGaps: readonly string[]): string {
  const gaps = [...new Set(validationGaps.map(gap => gap.trim()).filter(Boolean))].sort();
  return createHash('sha256').update(JSON.stringify(gaps)).digest('hex').slice(0, 16);
}

type ExplicitRetryAllowance = NonNullable<PendingTurnRecovery['explicitRetryAllowances']>[number];

export function latestExplicitRetryAllowance(pending: PendingTurnRecovery, objectiveId: string | undefined): ExplicitRetryAllowance | undefined {
  const entries = pending.explicitRetryAllowances;
  const grant = entries?.[entries.length - 1];
  return entries && entries.length <= MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS && grant?.schemaVersion === 1
    && !!objectiveId && grant.objectiveId === objectiveId && !!grant.id && !!grant.userMessageId
    && Number.isSafeInteger(pending.attempts) && pending.attempts >= 0
    && Number.isSafeInteger(grant.attemptBaseline) && grant.attemptBaseline >= 0
    && Number.isSafeInteger(grant.attempts) && grant.attempts >= 0
    && pending.attempts === grant.attemptBaseline + grant.attempts
    && Number.isSafeInteger(grant.maxAttempts) && grant.maxAttempts > 0
    && grant.maxAttempts <= MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS
    && Number.isFinite(grant.authorizedAt) && Number.isFinite(grant.leaseExpiresAt)
    && grant.leaseExpiresAt > grant.authorizedAt
    && grant.leaseExpiresAt <= grant.authorizedAt + DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS
    && Number.isSafeInteger(grant.stagnantAttempts) && grant.stagnantAttempts >= 0
    && typeof grant.semanticProgressFingerprint === 'string' && grant.semanticProgressFingerprint.length > 0
    ? grant : undefined;
}

/** Only tests existing authority. Never allocates or extends a lease at startup. */
export function hasAvailableExplicitRetryAllowance(
  pending: PendingTurnRecovery, objectiveId: string | undefined, nowMs = Date.now(),
): boolean {
  const grant = latestExplicitRetryAllowance(pending, objectiveId);
  return !pending.budgetHistoryUnavailable && !!grant && !grant.exhaustedAt
    && pending.attempts < MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS
    && grant.attempts < grant.maxAttempts && nowMs < grant.leaseExpiresAt;
}

/** Called only after the private, live Retry token has been authenticated. */
export function grantExplicitRetryAllowance(pending: PendingTurnRecovery, input: {
  id: string; objectiveId: string; userMessageId: string; nowMs: number;
  maxAttempts: number; progressFingerprint: string; semanticProgressFingerprint: string;
}): PendingTurnRecovery {
  if (pending.budgetHistoryUnavailable || !Number.isSafeInteger(pending.attempts)
    || pending.attempts < 0 || pending.attempts >= MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS
    || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0
    || !input.id || !input.objectiveId || !input.userMessageId || !Number.isFinite(input.nowMs)) return pending;
  // A Stop/Retry pair consumes the existing remainder, never a new reserve.
  if (hasAvailableExplicitRetryAllowance(pending, input.objectiveId, input.nowMs)) return pending;
  const previous = pending.explicitRetryAllowances;
  if (previous && (!latestExplicitRetryAllowance(pending, input.objectiveId)
    || previous.length >= MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS)) return pending;
  const required = previous?.length || pending.exhaustedAt || pending.attempts >= input.maxAttempts
    || (pending.leaseExpiresAt !== undefined && input.nowMs >= pending.leaseExpiresAt);
  if (!required) return pending;
  return {
    ...pending,
    // Previous hosts do not understand the grant, but must continue to refuse
    // automatic recovery instead of inventing an allowance after a rollback.
    exhaustedAt: pending.exhaustedAt ?? input.nowMs,
    explicitRetryAllowances: [...(previous ?? []), {
      schemaVersion: 1, id: input.id, objectiveId: input.objectiveId, userMessageId: input.userMessageId,
      authorizedAt: input.nowMs, attemptBaseline: pending.attempts,
      maxAttempts: Math.min(input.maxAttempts, MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS - pending.attempts),
      leaseExpiresAt: input.nowMs + DEFAULT_AUTOMATIC_TURN_RECOVERY_LEASE_MS,
      attempts: 0, stagnantAttempts: 0,
      lastProgressFingerprint: input.progressFingerprint,
      semanticProgressFingerprint: input.semanticProgressFingerprint,
    }],
  };
}

export function exhaustPendingTurnRecovery(
  pending: PendingTurnRecovery,
  nowMs = Date.now(),
): PendingTurnRecovery {
  return {
    ...pending,
    exhaustedAt: pending.explicitRetryAllowances ? (pending.exhaustedAt ?? nowMs) : nowMs,
    ...(pending.explicitRetryAllowances?.length ? {
      explicitRetryAllowances: [...pending.explicitRetryAllowances.slice(0, -1), {
        ...pending.explicitRetryAllowances[pending.explicitRetryAllowances.length - 1]!,
        exhaustedAt: pending.explicitRetryAllowances[pending.explicitRetryAllowances.length - 1]!.exhaustedAt ?? nowMs,
      }],
    } : {}),
  };
}

/** A transport failure can replace `lastCause`; retain the authenticated
 * origin of work copied from a host-validated `continue` receipt. The fallback
 * accepts markers written by the first build that persisted continuationWork
 * before continuationOrigin existed. */
export function hasObjectiveContinuationProvenance(
  pending: PendingTurnRecovery,
): boolean {
  return pending.continuationOrigin === 'objective_continue'
    || (pending.lastCause === 'objective_continue' && !!pending.continuationWork?.length);
}

/**
 * Runtime queues are transient. Preserve host-required continuation across a
 * crash even when a provider final already exists in the transcript.
 */
export function pendingRecoveryRequiresContinuation(
  pending: PendingTurnRecovery,
  objectiveActive: boolean,
): boolean {
  if (pending.continuationRequired) return true;
  if (!objectiveActive) return false;
  if (hasObjectiveContinuationProvenance(pending)) return true;
  return pending.lastCause === 'premature_final'
    || pending.lastCause === 'objective_incomplete'
    || pending.lastCause === 'objective_continue'
    || pending.lastCause === 'evidence_gate'
    || pending.lastCause === 'tool_checkpoint';
}
