import { describe, expect, it } from 'bun:test';
import { IncompleteToolTailRecovery } from './incomplete-tool-tail-recovery.ts';

const toolTail = [{ role: 'assistant' }, { role: 'toolResult' }];
const finalTail = [{ role: 'assistant' }];

describe('IncompleteToolTailRecovery', () => {
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
