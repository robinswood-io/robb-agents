import type { Message } from "@craft-agent/core/types";
import type { PendingTurnRecovery } from "@craft-agent/shared/sessions";
import { looksLikePrematureFinalAssistant } from "../turn-completion.ts";

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

  for (let index = messages.length - 1; index > userIndex; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'error') return false;
    if (message.role === 'tool' || message.role === 'user') return true;
    if (
      message.role === 'assistant'
      && !message.isIntermediate
      && !looksLikePrematureFinalAssistant(message.content)
    ) return forceContinuation;
  }

  return true;
}

/** Ignore earlier terminal messages when an existing user message starts a new attempt. */
export function messagesForPendingRecovery(messages: Message[], pending: PendingTurnRecovery): Message[] {
  const boundaries = [pending.userRetryFromMessageCount, pending.userInputFromMessageCount]
    .filter((value): value is number => value !== undefined && Number.isInteger(value));
  const boundary = boundaries.length ? Math.max(...boundaries) : undefined;
  const anchorIndex = messages.findIndex(message => message.id === pending.userMessageId && message.role === 'user');
  if (boundary === undefined || !Number.isInteger(boundary) || boundary <= anchorIndex
    || boundary > messages.length || anchorIndex < 0) return messages;
  return [messages[anchorIndex]!, ...messages.slice(boundary)];
}
