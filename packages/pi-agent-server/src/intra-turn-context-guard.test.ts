import type { ToolResultMessage, TextContent } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'bun:test';
import { isContextOverflow } from '@earendil-works/pi-ai/compat';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  INTRA_TURN_CONTEXT_CHECKPOINT_ERROR,
  estimateIntraTurnContextTokens,
  needsIntraTurnContextCheckpoint,
  pruneIntraTurnToolResults,
} from './intra-turn-context-guard.ts';

const text = (value: string): AgentMessage => ({
  role: 'user', content: [{ type: 'text', text: value }], timestamp: 1,
});

const toolResult = (id: string, value: string): AgentMessage => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'Read',
  content: [{ type: 'text', text: value }],
  isError: false,
  timestamp: 1,
} as AgentMessage);

describe('Pi intra-turn context checkpoint', () => {
  it('checks accumulated messages before the next model call', () => {
    const first = text('a'.repeat(2_000));
    const second = text('b'.repeat(2_000));
    const limit = estimateIntraTurnContextTokens([first]) + 1;
    expect(needsIntraTurnContextCheckpoint([first], limit)).toBe(false);
    expect(needsIntraTurnContextCheckpoint([first, second], limit)).toBe(true);
    expect(needsIntraTurnContextCheckpoint([first, second], 0)).toBe(false);
  });

  it('uses an error recognized by Pi’s bounded compact-and-continue path', () => {
    expect(isContextOverflow({
      role: 'assistant', stopReason: 'error', errorMessage: INTRA_TURN_CONTEXT_CHECKPOINT_ERROR,
    } as never, 200_000)).toBe(true);
  });

  it('prunes older bulky toolResult payloads while keeping the latest 6 intact and preserving input immutability', () => {
    const messages: AgentMessage[] = [
      text('user mission'),
      ...Array.from({ length: 10 }, (_, i) => toolResult(`call-${i}`, `HEADER_${i}\n${'x'.repeat(8_000)}\nFOOTER_${i}`)),
    ];
    const totalBefore = estimateIntraTurnContextTokens(messages);
    // Below threshold -> returns exact same array reference
    expect(pruneIntraTurnToolResults(messages, totalBefore + 1_000)).toBe(messages);

    // Above threshold -> prunes oldest toolResult messages without mutating original array
    const pruned = pruneIntraTurnToolResults(messages, totalBefore - 500);
    expect(pruned).not.toBe(messages);
    expect(estimateIntraTurnContextTokens(pruned)).toBeLessThan(totalBefore);
    // Oldest toolResult (index 1) was pruned but keeps head and tail markers
    const firstToolText = ((pruned[1] as ToolResultMessage).content[0] as TextContent).text;
    expect(firstToolText).toContain('HEADER_0');
    expect(firstToolText).toContain('FOOTER_0');
    expect(firstToolText).toContain('intra-turn context pruned');
    // Original message at index 1 is untouched
    expect(((messages[1] as ToolResultMessage).content[0] as TextContent).text).not.toContain('intra-turn context pruned');
    // Latest 6 toolResults (indices 5..10) remain completely untouched
    for (let idx = 5; idx <= 10; idx++) {
      expect(pruned[idx]).toBe(messages[idx]);
    }
  });
});
