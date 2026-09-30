import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens } from '@earendil-works/pi-coding-agent';

// Pi recognizes this error as a context overflow and runs its existing
// compact-and-continue path. The guard runs before the next provider request,
// after all preceding tool results have been journaled.
export const INTRA_TURN_CONTEXT_CHECKPOINT_ERROR =
  'Your input exceeds the context window of this model (Robb intra-turn checkpoint)';

export function estimateIntraTurnContextTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

export function needsIntraTurnContextCheckpoint(
  messages: AgentMessage[],
  compactAtTokens: number,
): boolean {
  return Number.isFinite(compactAtTokens)
    && compactAtTokens > 0
    && estimateIntraTurnContextTokens(messages) >= compactAtTokens;
}
