import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import { classifyLatestTurnTerminalState } from './turn-completion.ts';

const message = (
  role: Message['role'],
  timestamp: number,
  options: Partial<Message> = {},
): Message => ({
  id: `${role}-${timestamp}`,
  role,
  content: role,
  timestamp,
  ...options,
});

describe('classifyLatestTurnTerminalState', () => {
  it('accepts a final assistant response after the latest user message', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2),
    ])).toBe('final-assistant');
  });

  it('does not treat commentary followed by a tool result as completion', () => {
    expect(classifyLatestTurnTerminalState([
      message('assistant', 1),
      message('user', 2),
      message('assistant', 3, { isIntermediate: true }),
      message('tool', 4, { toolName: 'Bash' }),
    ])).toBe('incomplete');
  });

  it('accepts a visible error as a terminal outcome', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('tool', 2, { toolName: 'Read' }),
      message('error', 3),
    ])).toBe('error');
  });

  it('does not reuse a final response from a previous turn', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 2),
      message('user', 3),
      message('tool', 4, { toolName: 'Edit' }),
    ])).toBe('incomplete');
  });

  it('accepts a final response with the same timestamp as the user message', () => {
    expect(classifyLatestTurnTerminalState([
      message('user', 1),
      message('assistant', 1),
    ])).toBe('final-assistant');
  });
});
