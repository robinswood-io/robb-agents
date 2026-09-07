import { describe, expect, test } from 'bun:test';
import { ToolLoopBudget } from './tool-loop-budget.ts';

describe('ToolLoopBudget', () => {
  test('hints after three consecutive calls with different inputs', () => {
    const budget = new ToolLoopBudget();
    expect(budget.observe('Read', { path: 'a' }).action).toBe('allow');
    expect(budget.observe('Read', { path: 'b' }).action).toBe('allow');
    expect(budget.observe('Read', { path: 'c' }).action).toBe('hint');
  });

  test('blocks the fourth unchanged call even when key order differs', () => {
    const budget = new ToolLoopBudget();
    budget.observe('Grep', { path: '.', pattern: 'x' });
    budget.observe('Grep', { pattern: 'x', path: '.' });
    budget.observe('Grep', { path: '.', pattern: 'x' });
    const decision = budget.observe('Grep', { pattern: 'x', path: '.' });
    expect(decision.action).toBe('block');
    expect(decision.identicalCalls).toBe(4);
  });

  test('does not warn for distinct calls emitted in one intentional batch', () => {
    const budget = new ToolLoopBudget();
    const calls = Array.from({ length: 8 }, (_, index) => ({
      toolName: 'Read',
      input: { path: `file-${index}.ts` },
    }));
    budget.registerPlannedBatch(calls);

    for (const call of calls) {
      expect(budget.observe(call.toolName, call.input).action).toBe('allow');
    }
  });

  test('still blocks unchanged duplicates inside a planned batch', () => {
    const budget = new ToolLoopBudget();
    const calls = Array.from({ length: 4 }, () => ({
      toolName: 'Grep',
      input: { path: '.', pattern: 'same' },
    }));
    budget.registerPlannedBatch(calls);
    for (const call of calls.slice(0, 3)) budget.observe(call.toolName, call.input);
    expect(budget.observe(calls[3]!.toolName, calls[3]!.input).action).toBe('block');
  });

  test('resets at each prompt and when the tool changes', () => {
    const budget = new ToolLoopBudget();
    budget.observe('Read', { path: 'a' });
    expect(budget.observe('Bash', { command: 'pwd' }).consecutiveToolCalls).toBe(1);
    budget.beginPrompt();
    expect(budget.observe('Read', { path: 'a' }).identicalCalls).toBe(1);
    expect(budget.observe('Read', { path: 'b' }).totalToolCalls).toBe(2);
  });

  test('allows long consecutive analysis when every input is materially different', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index <= 24; index += 1) {
      expect(budget.observe('Bash', { command: `check-${index}` }).action).not.toBe('block');
    }
  });

  test('allows more than twenty-four distinct calls when tool names alternate', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index <= 30; index += 1) {
      const toolName = index % 2 === 0 ? 'Read' : 'Grep';
      expect(budget.observe(toolName, { index }).action).not.toBe('block');
    }
  });

  test('blocks a low-novelty loop at the structural checkpoint', () => {
    const budget = new ToolLoopBudget();
    let decision;
    for (let index = 1; index <= 24; index += 1) {
      decision = budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { target: index % 2 });
    }
    expect(decision?.action).toBe('block');
    expect(decision?.totalToolCalls).toBe(24);
  });

  test('emits a total-budget hint even when tool names alternate', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index < 6; index += 1) {
      budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { index });
    }
    const decision = budget.observe('Read', { index: 6 });
    expect(decision.action).toBe('hint');
    expect(decision.message).toContain('3-5 calls');
  });

  test('reserves enough budget before starting a new mutation', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index < 92; index += 1) {
      budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { index });
    }
    const decision = budget.observe('Write', { path: 'result.txt', content: 'done' });
    expect(decision.action).toBe('block');
    expect(decision.message).toContain('was not started');
    expect(decision.message).toContain('automatic recovery');
  });

  test('allows verification and cleanup after an admitted mutation crosses the soft checkpoint', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index < 18; index += 1) {
      budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { index });
    }
    expect(budget.observe('Write', { path: 'result.txt', content: 'done' }).action).not.toBe('block');
    for (let index = 19; index <= 22; index += 1) {
      expect(budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { index }).action).not.toBe('block');
    }
    expect(budget.observe('Read', { index: 23 }).action).not.toBe('block');
    expect(budget.observe('Grep', { index: 24 }).action).not.toBe('block');
  });

  test('retains an absolute safety lease for unique calls', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index < 96; index += 1) {
      expect(budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { index }).action).not.toBe('block');
    }
    expect(budget.observe('Read', { index: 96 }).action).toBe('block');
  });

  test('does not let repeated mutations extend the absolute lease', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index < 90; index += 1) {
      budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { index });
    }
    expect(budget.observe('Write', { path: 'a', content: '90' }).action).not.toBe('block');
    for (let index = 91; index < 94; index += 1) {
      budget.observe(index % 2 === 0 ? 'Read' : 'Grep', { index });
    }
    expect(budget.observe('Edit', { path: 'a', content: '94' }).action).toBe('block');
    expect(budget.observe('Read', { index: 95 }).action).not.toBe('block');
    expect(budget.observe('Write', { path: 'b', content: '96' }).action).toBe('block');
    expect(budget.observe('Edit', { path: 'c', content: '97' }).action).toBe('block');
    expect(budget.observe('Write', { path: 'd', content: '98' }).action).toBe('block');
  });
});
