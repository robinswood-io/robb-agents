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

const RECENT_TOOL_RESULTS_TO_KEEP = 6;
const PRUNE_TEXT_BLOCK_MIN_CHARS = 1_200;
const PRUNE_HEAD_CHARS = 500;
const PRUNE_TAIL_CHARS = 300;

/**
 * Non-destructively prune older `toolResult` payloads in `transformContext`
 * when accumulated intra-turn context reaches `compactAtTokens`.
 *
 * Keeps the most recent 6 tool results intact so active reasoning has full
 * fidelity, while compacting older bulky tool outputs until estimated tokens
 * fall below 85% of `compactAtTokens`. Never mutates `messages` in place.
 */
export function pruneIntraTurnToolResults(
  messages: AgentMessage[],
  compactAtTokens: number,
): AgentMessage[] {
  if (!needsIntraTurnContextCheckpoint(messages, compactAtTokens)) {
    return messages;
  }

  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: string };
    if (msg?.role === 'toolResult') {
      toolResultIndices.push(i);
    }
  }

  const prunableIndices = toolResultIndices.slice(
    0,
    Math.max(0, toolResultIndices.length - RECENT_TOOL_RESULTS_TO_KEEP),
  );
  if (prunableIndices.length === 0) {
    return messages;
  }

  const targetTokens = Math.floor(compactAtTokens * 0.85);
  let currentTokens = estimateIntraTurnContextTokens(messages);
  let result: AgentMessage[] | null = null;

  for (const index of prunableIndices) {
    if (currentTokens <= targetTokens) break;
    const original = messages[index];
    if (!original || original.role !== 'toolResult' || !Array.isArray(original.content)) continue;

    let modified = false;
    const nextContent = original.content.map(block => {
      if (
        block?.type === 'text'
        && typeof block.text === 'string'
        && block.text.length > PRUNE_TEXT_BLOCK_MIN_CHARS
      ) {
        modified = true;
        const omitted = block.text.length - (PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS);
        return {
          ...block,
          text: `${block.text.slice(0, PRUNE_HEAD_CHARS)}\n...[intra-turn context pruned (${omitted} chars omitted); re-read specific lines if needed]...\n${block.text.slice(-PRUNE_TAIL_CHARS)}`,
        };
      }
      return block;
    });

    if (!modified) continue;
    const beforeTokens = estimateTokens(messages[index]!);
    const prunedMessage = {
      ...original,
      content: nextContent,
    } as AgentMessage;
    const afterTokens = estimateTokens(prunedMessage);
    if (afterTokens >= beforeTokens) continue;

    if (!result) {
      result = [...messages];
    }
    result[index] = prunedMessage;
    currentTokens -= beforeTokens - afterTokens;
  }

  return result ?? messages;
}
