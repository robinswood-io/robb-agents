import type { Message } from '@craft-agent/core/types';

/**
 * A structural tool-budget yield is progress inside one logical user turn.
 * Demote its provider "final" so lifecycle and UI cannot mistake it for the
 * mission result. The content remains visible as intermediate progress.
 */
export function demoteLatestCheckpointAssistant(
  messages: Message[],
  objectiveUserMessageId: string,
): Message | undefined {
  const objectiveIndex = messages.findIndex(message => (
    message.id === objectiveUserMessageId && message.role === 'user'
  ));
  if (objectiveIndex < 0) return undefined;
  for (let index = messages.length - 1; index > objectiveIndex; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || message.isIntermediate) continue;
    message.isIntermediate = true;
    return message;
  }
  return undefined;
}

export function latestFinalAssistantId(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && !message.isIntermediate) return message.id;
  }
  return undefined;
}
