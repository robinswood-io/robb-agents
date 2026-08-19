import type { Message } from '@craft-agent/core/types';

export type LatestTurnTerminalState = 'final-assistant' | 'error' | 'incomplete' | 'no-user';

/**
 * Classify whether the latest user turn has a user-visible terminal outcome.
 * Intermediate commentary and tool results are progress, not a final answer.
 */
export function classifyLatestTurnTerminalState(messages: Message[]): LatestTurnTerminalState {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex === -1) return 'no-user';

  for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === 'error') return 'error';
    if (message.role === 'assistant' && !message.isIntermediate) return 'final-assistant';
  }

  return 'incomplete';
}
