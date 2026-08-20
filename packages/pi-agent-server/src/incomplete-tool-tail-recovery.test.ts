import { describe, expect, it } from 'bun:test';
import {
  IncompleteToolTailRecovery,
  prepareMessagesForIncompleteTailContinuation,
} from './incomplete-tool-tail-recovery.ts';

const toolTail = [{ role: 'assistant' }, { role: 'toolResult' }];
const finalTail = [{ role: 'assistant' }];
const partialAssistantTail = [
  {
    role: 'assistant',
    stopReason: 'aborted',
    errorMessage: 'Request was aborted',
    content: [
      { type: 'thinking', thinking: 'Planning the next tool call' },
      { type: 'text', text: 'The development server is available. I will' },
    ],
  },
];

describe('IncompleteToolTailRecovery', () => {
  it('removes only an aborted assistant tail before Agent.continue()', () => {
    expect(prepareMessagesForIncompleteTailContinuation(partialAssistantTail)).toEqual({
      messages: [],
      removedAbortedAssistant: true,
    });
    expect(prepareMessagesForIncompleteTailContinuation(toolTail)).toEqual({
      messages: toolTail,
      removedAbortedAssistant: false,
    });
    expect(prepareMessagesForIncompleteTailContinuation([
      { role: 'assistant', stopReason: 'stop' },
    ]).removedAbortedAssistant).toBe(false);
  });

  it('does not suppress a normal final assistant response', async () => {
    const recovery = new IncompleteToolTailRecovery();
    recovery.beginPrompt();

    expect(recovery.shouldSuppressAgentEnd(finalTail)).toBe(false);
    expect(await recovery.recover(async () => {})).toBe('none');

    recovery.endPrompt();
  });

  it('continues once when Pi ends immediately after a tool result', async () => {
    const recovery = new IncompleteToolTailRecovery();
    recovery.beginPrompt();
    expect(recovery.shouldSuppressAgentEnd(toolTail)).toBe(true);

    let continuations = 0;
    const result = await recovery.recover(async () => {
      continuations += 1;
      expect(recovery.shouldSuppressAgentEnd(finalTail)).toBe(false);
    });

    expect(result).toBe('recovered');
    expect(continuations).toBe(1);
    recovery.endPrompt();
  });

  it('continues when Pi unexpectedly aborts after partial assistant commentary', async () => {
    const recovery = new IncompleteToolTailRecovery();
    recovery.beginPrompt();
    expect(recovery.shouldSuppressAgentEnd(partialAssistantTail)).toBe(true);

    let continuations = 0;
    const result = await recovery.recover(async () => {
      continuations += 1;
      expect(recovery.shouldSuppressAgentEnd([
        { role: 'assistant', stopReason: 'stop' },
      ])).toBe(false);
    });

    expect(result).toBe('recovered');
    expect(continuations).toBe(1);
    recovery.endPrompt();
  });

  it('preserves terminal assistant stops, errors, and output-limit endings', async () => {
    const recovery = new IncompleteToolTailRecovery();
    recovery.beginPrompt();

    expect(recovery.shouldSuppressAgentEnd([
      { role: 'assistant', stopReason: 'stop' },
    ])).toBe(false);
    expect(recovery.shouldSuppressAgentEnd([
      { role: 'assistant', stopReason: 'error' },
    ])).toBe(false);
    expect(recovery.shouldSuppressAgentEnd([
      { role: 'assistant', stopReason: 'length' },
    ])).toBe(false);
    expect(await recovery.recover(async () => {})).toBe('none');

    recovery.endPrompt();
  });

  it('does not suppress partial commentary from an explicitly aborted prompt', async () => {
    const recovery = new IncompleteToolTailRecovery();
    recovery.beginPrompt();
    recovery.requestAbort();

    expect(recovery.shouldSuppressAgentEnd(partialAssistantTail)).toBe(false);
    expect(await recovery.recover(async () => {})).toBe('none');

    recovery.endPrompt();
  });

  it('retries repeated tool-tail endings but remains bounded', async () => {
    const recovery = new IncompleteToolTailRecovery(2);
    recovery.beginPrompt();
    expect(recovery.shouldSuppressAgentEnd(toolTail)).toBe(true);

    let continuations = 0;
    const result = await recovery.recover(async () => {
      continuations += 1;
      expect(recovery.shouldSuppressAgentEnd(toolTail)).toBe(true);
    });

    expect(result).toBe('exhausted');
    expect(continuations).toBe(2);
    recovery.endPrompt();
  });

  it('does not recover an explicitly aborted prompt', async () => {
    const recovery = new IncompleteToolTailRecovery();
    recovery.beginPrompt();
    expect(recovery.shouldSuppressAgentEnd(toolTail)).toBe(true);
    recovery.requestAbort();

    let continued = false;
    expect(await recovery.recover(async () => {
      continued = true;
    })).toBe('aborted');
    expect(continued).toBe(false);

    recovery.endPrompt();
  });
});
