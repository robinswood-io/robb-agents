import type { Message } from '@craft-agent/core/types';
import type { ActiveSessionObjective, PendingTurnRecovery } from '@craft-agent/shared/sessions';
import type { WaitSessionDiagnostic } from '@craft-agent/session-tools-core';

export interface WaitDiagnosticBoundary {
  generation: number;
  objectiveId: string;
  fromMessageCount: number;
}

/** Select existing terminal text; never parse its verdict or grant execution authority. */
export function buildSessionWaitDiagnostic(input: {
  objective?: ActiveSessionObjective;
  messages: Message[];
  pending?: PendingTurnRecovery;
  processingGeneration: number;
  boundary?: WaitDiagnosticBoundary;
  lastFinalMessageId?: string;
}): WaitSessionDiagnostic | undefined {
  const { objective, messages, pending, processingGeneration, boundary } = input;
  if (!objective || objective.terminalState === 'active' || objective.terminalState === 'complete_verified') return undefined;
  const objectiveId = objective.objectiveId ?? objective.userMessageId;
  const anchorId = objective.lastUserMessageId ?? objective.userMessageId;
  const anchorIndex = messages.findIndex(message => message.id === anchorId && message.role === 'user');
  if (anchorIndex < 0) return undefined;
  let from = anchorIndex + 1;
  const runtime = processingGeneration > 0;
  if (runtime) {
    if (!boundary || boundary.generation !== processingGeneration || boundary.objectiveId !== objectiveId) return undefined;
    if (!Number.isInteger(boundary.fromMessageCount) || boundary.fromMessageCount < 0 || boundary.fromMessageCount > messages.length) return undefined;
    from = Math.max(from, boundary.fromMessageCount);
  }
  if (pending) {
    const pendingAnchor = messages.findIndex(message => message.id === pending.userMessageId && message.role === 'user');
    if (pendingAnchor < anchorIndex) return undefined;
    from = Math.max(from, pendingAnchor + 1);
    for (const position of [pending.userRetryFromMessageCount, pending.userInputFromMessageCount]) {
      if (position === undefined) continue;
      if (!Number.isInteger(position) || position < 0 || position > messages.length) return undefined;
      from = Math.max(from, position);
    }
  }
  let final: Message | undefined;
  let error: Message | undefined;
  for (let index = messages.length - 1; index >= from; index--) {
    const message = messages[index]!;
    if (message.timestamp < objective.startedAt || message.hidden || message.parentToolUseId) continue;
    if (!error && message.role === 'error') error = message;
    if (!final && message.role === 'assistant' && !message.isIntermediate
      && message.id === input.lastFinalMessageId) final = message;
    if (final && error) break;
  }
  // Old gaps alone cannot stand in for a terminal diagnostic from this attempt.
  if (!final && !error) return undefined;
  const gaps = pending?.validationGaps;
  return {
    verified: false, objectiveId,
    source: runtime ? 'current-generation' : 'persisted-objective',
    ...(runtime ? { processingGeneration } : {}),
    ...(final ? { messageId: final.id, text: final.content.slice(0, 32_000),
      ...(final.content.length > 32_000 ? { textTruncated: true } : {}) } : {}),
    ...(error ? { errorMessageId: error.id, errorText: error.content.slice(0, 2000),
      ...(error.content.length > 2000 ? { errorTextTruncated: true } : {}) } : {}),
    ...(gaps?.length ? { validationGaps: gaps.slice(0, 16).map(gap => gap.slice(0, 500)),
      ...(gaps.length > 16 || gaps.some(gap => gap.length > 500) ? { validationGapsTruncated: true } : {}) } : {}),
  };
}
