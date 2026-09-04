import type { Message } from '@craft-agent/core/types';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { looksLikePrematureFinalAssistant } from './turn-completion.ts';

export type AutomaticTurnRecoveryCause = NonNullable<PendingTurnRecovery['lastCause']>;

/** A generous total bound paired with a strict no-progress circuit breaker. */
export const MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS = 8;
export const MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS = 2;
export const DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS = 30 * 1000;
const MAX_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class AutomaticRecoveryStalledError extends Error {
  constructor(timeoutMs: number) {
    super(`Automatic turn recovery produced no activity for ${timeoutMs} ms`);
    this.name = 'AutomaticRecoveryStalledError';
  }
}

export function resolveAutomaticRecoveryInactivityTimeoutMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS;
  if (parsed === 0) return 0;
  return Math.min(
    Math.max(Math.floor(parsed), MIN_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS),
    MAX_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS,
  );
}

/**
 * Bound each wait for the next provider event during an automatic recovery.
 * Every event resets the deadline. A stalled iterator is intentionally left
 * for SessionManager's error path to dispose with the complete runtime.
 */
export async function* withAutomaticRecoveryInactivityTimeout<T>(
  source: AsyncIterable<T>,
  timeoutMs: number,
): AsyncGenerator<T> {
  if (timeoutMs <= 0) {
    yield* source;
    return;
  }

  const iterator = source[Symbol.asyncIterator]();
  let stalled = false;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = await Promise.race([
          iterator.next(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new AutomaticRecoveryStalledError(timeoutMs)), timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (next.done) return;
        yield next.value;
      } catch (error) {
        stalled = error instanceof AutomaticRecoveryStalledError;
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } finally {
    if (!stalled && iterator.return) {
      await iterator.return();
    }
  }
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

export function advancePendingTurnRecovery(
  pending: PendingTurnRecovery,
  cause: AutomaticTurnRecoveryCause,
  nowMs = Date.now(),
  maxAttempts = MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS,
  progressFingerprint?: string,
  maxStagnantAttempts = MAX_AUTOMATIC_TURN_RECOVERY_STAGNANT_ATTEMPTS,
): PendingTurnRecovery | null {
  if (pending.exhaustedAt || pending.attempts >= Math.max(0, Math.floor(maxAttempts))) {
    return null;
  }

  const progressComparable = progressFingerprint !== undefined;
  const madeProgress = progressComparable
    && pending.lastProgressFingerprint !== undefined
    && progressFingerprint !== pending.lastProgressFingerprint;
  const stagnantAttempts = !progressComparable || pending.lastProgressFingerprint === undefined || madeProgress
    ? 0
    : (pending.stagnantAttempts ?? 0) + 1;
  if (progressComparable && stagnantAttempts >= Math.max(1, Math.floor(maxStagnantAttempts))) {
    return null;
  }

  return {
    ...pending,
    attempts: pending.attempts + 1,
    lastAttemptAt: nowMs,
    lastCause: cause,
    ...(progressComparable ? { lastProgressFingerprint: progressFingerprint, stagnantAttempts } : {}),
    ...(pending.continuationRequired ? { continuationRequired: false } : {}),
  };
}

export function exhaustPendingTurnRecovery(
  pending: PendingTurnRecovery,
  nowMs = Date.now(),
): PendingTurnRecovery {
  return {
    ...pending,
    exhaustedAt: nowMs,
  };
}

/**
 * A stale marker must never replay a turn that already produced a terminal
 * assistant response or visible error before the previous process exited.
 */
export function turnStillNeedsRecovery(
  messages: Message[],
  userMessageId: string,
  forceContinuation = false,
): boolean {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return false;

  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'error') return false;
    if (
      message.role === 'assistant'
      && !message.isIntermediate
      && !looksLikePrematureFinalAssistant(message.content)
    ) return forceContinuation;
  }

  return true;
}

export function buildAutomaticTurnRecoveryPrompt(
  pending: PendingTurnRecovery,
  cause: AutomaticTurnRecoveryCause,
): string {
  const causeLabel = cause === 'app_restart'
    ? 'the application restarted while the turn was active'
    : cause === 'stream_ended'
      ? 'the provider stream ended before a final response'
      : cause === 'premature_final'
        ? 'the previous response announced more work instead of completing it'
        : cause === 'tool_checkpoint'
          ? 'the host tool-call budget reached a structural checkpoint before the objective was complete'
          : cause === 'evidence_gate'
            ? 'the high-stakes completion gate still requires authoritative evidence or independent review'
            : cause === 'objective_incomplete'
              ? 'the objective completion contract still lacks execution or verification evidence'
        : 'the agent runtime failed before a final response';

  return [
    `<automatic_turn_recovery original_user_message_id="${pending.userMessageId}" attempt="${pending.attempts + 1}">`,
    `Continue the interrupted user turn because ${causeLabel}.`,
    'Use the preserved conversation and tool results. Do not repeat an external mutation that may already have completed; verify its state first and reuse idempotency or duplicate checks when available.',
    cause === 'premature_final'
      ? 'Treat the reported technical obstacle as a diagnosis checkpoint, not a terminal result. Form a materially different hypothesis, inspect the strongest available evidence, test the safest viable correction or alternate route, and verify the user-visible outcome. Perform the remaining actions now. Do not end with another promise, a proposed next correction, or an untested recommendation.'
      : '',
    cause === 'tool_checkpoint'
      ? 'Resume from the preserved tool results. Continue with the remaining checklist; do not treat the prior tool-call ceiling as completion.'
      : '',
    cause === 'evidence_gate'
      ? 'Before any further mutation, gather the missing primary or official evidence. Then obtain an independent review of the deliverable and verify the end-user result.'
      : '',
    cause === 'objective_incomplete'
      ? 'Resume the original objective, perform the missing execution or verification steps now, and report the concrete evidence. Do not substitute a plan or assertion for the requested outcome.'
      : '',
    'Finish the requested work and provide the final user-facing response.',
    '</automatic_turn_recovery>',
  ].filter(Boolean).join('\n');
}
