import type { Message } from '@craft-agent/core/types';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';

export type AutomaticTurnRecoveryCause = NonNullable<PendingTurnRecovery['lastCause']>;

/** One immediate retry plus one later retry keeps recovery useful but bounded. */
export const MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS = 2;

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
): PendingTurnRecovery | null {
  if (pending.exhaustedAt || pending.attempts >= MAX_AUTOMATIC_TURN_RECOVERY_ATTEMPTS) {
    return null;
  }

  return {
    ...pending,
    attempts: pending.attempts + 1,
    lastAttemptAt: nowMs,
    lastCause: cause,
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
): boolean {
  const userIndex = messages.findIndex(message => message.id === userMessageId && message.role === 'user');
  if (userIndex < 0) return false;

  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'error') return false;
    if (message.role === 'assistant' && !message.isIntermediate) return false;
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
      : 'the agent runtime failed before a final response';

  return [
    `<automatic_turn_recovery original_user_message_id="${pending.userMessageId}" attempt="${pending.attempts + 1}">`,
    `Continue the interrupted user turn because ${causeLabel}.`,
    'Use the preserved conversation and tool results. Do not repeat an external mutation that may already have completed; verify its state first and reuse idempotency or duplicate checks when available.',
    'Finish the requested work and provide the final user-facing response.',
    '</automatic_turn_recovery>',
  ].join('\n');
}
