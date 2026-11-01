import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { Message } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { transitionObjectiveContract } from './transition.ts';

export function objectiveCostUsd(
  objective: ActiveSessionObjective | undefined,
  lifetimeCostUsd: number | undefined,
): number {
  const lifetime = Math.max(0, lifetimeCostUsd ?? 0);
  return objective ? Math.max(0, lifetime - objective.budgetBaselineUsd) : lifetime;
}

export function findObjectiveText(
  messages: Message[],
  objective: ActiveSessionObjective | undefined,
): string | undefined {
  if (!objective) return undefined;
  return objective.originalText ?? messages.find(message => (
    message.id === objective.userMessageId && message.role === 'user'
  ))?.content;
}

const LEGACY_SOURCE_ACTIVATION_SUFFIX = /\n\n\[[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])? activated\]$/;

const LEGACY_AUTONOMY_FALLBACK_MESSAGE = /^<automatic_(browser|structured)_fallback\b[^>]*>[\s\S]*<\/automatic_\1_fallback>$/;

const LEGACY_AUTOMATIC_RECOVERY_MESSAGE = /^<automatic_turn_recovery\b[^>]*>[\s\S]*<\/automatic_turn_recovery>$/;

export function isHostSyntheticObjectiveText(content: string): boolean {
  const normalized = content.trim();
  const withoutActivationSuffix = normalized.replace(LEGACY_SOURCE_ACTIVATION_SUFFIX, '');
  return withoutActivationSuffix !== normalized
    || LEGACY_AUTONOMY_FALLBACK_MESSAGE.test(withoutActivationSuffix)
    || LEGACY_AUTOMATIC_RECOVERY_MESSAGE.test(normalized);
}

/**
 * Host continuations are model context, never objective authority. Current
 * rows carry `hidden`/`internalOrigin`; the content checks cover the exact
 * metadata-less rows written by older source-activation and recovery paths.
 */
export function isHostSyntheticObjectiveMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (message.hidden || message.isQueued || message.isPending || message.agentDelivery) return true;
  if (message.internalOrigin
    && message.internalOrigin.kind !== 'spawned-session'
    && message.internalOrigin.kind !== 'automation') return true;
  return isHostSyntheticObjectiveText(message.content);
}

/**
 * Rebuild the semantic contract visible at a branch anchor. Never copy state
 * produced by messages after the anchor. A full-history branch can retain the
 * exact registered contract; an earlier branch conservatively replays only its
 * visible user turns and cannot inherit future criteria or outcomes.
 */
export function reconstructObjectiveForBranch(input: {
  messages: Message[];
  sourceObjective?: ActiveSessionObjective;
  completeSourceHistory: boolean;
}): ActiveSessionObjective | undefined {
  const userMessages = input.messages.filter(message => (
    message.role === 'user' && !isHostSyntheticObjectiveMessage(message)
  ));
  if (userMessages.length === 0) return undefined;

  const rootCopied = input.sourceObjective
    && userMessages.some(message => message.id === input.sourceObjective?.userMessageId);
  if (rootCopied && input.completeSourceHistory) {
    return omitUndefined<ActiveSessionObjective>({ ...input.sourceObjective!, interruptedTurnRecovery: undefined });
  }

  let reconstructed: ActiveSessionObjective | undefined;
  for (const message of userMessages) {
    // The first internal dispatch can own a child session. Later internal
    // coordination never changes that child's accepted objective.
    if (reconstructed && message.internalOrigin) continue;
    const text = input.sourceObjective?.userMessageId === message.id
      ? input.sourceObjective.originalText ?? message.content
      : message.content;
    reconstructed = transitionObjectiveContract({
      ...(reconstructed !== undefined ? { existing: reconstructed } : {}),
      messageId: message.id,
      text,
      nowMs: message.timestamp,
      ...(input.sourceObjective?.delegatedRole !== undefined ? { delegatedRole: input.sourceObjective?.delegatedRole } : {}),
    });
  }
  if (!reconstructed) return undefined;
  if (input.sourceObjective?.userMessageId === reconstructed.userMessageId) {
    const objectiveId = input.sourceObjective.objectiveId ?? reconstructed.objectiveId;
    reconstructed = {
      ...reconstructed,
      ...(objectiveId !== undefined ? { objectiveId } : {}),
      startedAt: input.sourceObjective.startedAt,
      budgetBaselineUsd: input.sourceObjective.budgetBaselineUsd,
      tokenBaseline: input.sourceObjective.tokenBaseline,
      ...(input.sourceObjective.model ? { model: input.sourceObjective.model } : {}),
      ...(input.sourceObjective.thinkingLevel
        ? { thinkingLevel: input.sourceObjective.thinkingLevel } : {}),
    };
  }
  return reconstructed;
}
