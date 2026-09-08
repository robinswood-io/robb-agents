/**
 * Tests for the `call_llm` display-model override in PiEventAdapter.
 *
 * The adapter fills `args.model` with the selected session model ONLY when the
 * caller didn't specify one. Regression guard for issue #596 — prior behavior
 * unconditionally overwrote the agent's explicit model choice.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { PiEventAdapter } from './event-adapter.ts';

function collect<T>(gen: Generator<T>): T[] {
  return [...gen];
}

describe('PiEventAdapter — call_llm model badge', () => {
  let adapter: PiEventAdapter;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    adapter.startTurn();
  });

  it('preserves an explicit args.model unchanged', () => {
    adapter.setCallLlmModel('pi/gpt-5-mini');

    const events = collect(adapter.adaptEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'call_llm',
      args: { prompt: 'hi', model: 'pi/gpt-5-pro' },
    } as any));

    expect(events).toHaveLength(1);
    expect((events[0] as any).input.model).toBe('pi/gpt-5-pro');
  });

  it('fills args.model with callLlmModel when absent', () => {
    adapter.setCallLlmModel('pi/gpt-5-mini');

    const events = collect(adapter.adaptEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_2',
      toolName: 'call_llm',
      args: { prompt: 'hi' },
    } as any));

    expect(events).toHaveLength(1);
    expect((events[0] as any).input.model).toBe('pi/gpt-5-mini');
  });

  it('leaves args.model undefined when callLlmModel is also unset', () => {
    // No setCallLlmModel call — simulates a connection without a selected session model.

    const events = collect(adapter.adaptEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_3',
      toolName: 'call_llm',
      args: { prompt: 'hi' },
    } as any));

    expect(events).toHaveLength(1);
    expect((events[0] as any).input.model).toBeUndefined();
  });

  it('preserves explicit args.model even when callLlmModel is set to a different value', () => {
    adapter.setCallLlmModel('pi/gpt-5-mini');

    const events = collect(adapter.adaptEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_4',
      toolName: 'mcp__session__call_llm',
      args: { prompt: 'hi', model: 'pi/nonexistent-model' },
    } as any));

    expect(events).toHaveLength(1);
    // The adapter must not overwrite the agent's choice even if it looks odd —
    // the subprocess will resolve or error on invalid explicit models.
    expect((events[0] as any).input.model).toBe('pi/nonexistent-model');
  });
});
