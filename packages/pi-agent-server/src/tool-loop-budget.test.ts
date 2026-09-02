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

  test('resets at each prompt and when the tool changes', () => {
    const budget = new ToolLoopBudget();
    budget.observe('Read', { path: 'a' });
    expect(budget.observe('Bash', { command: 'pwd' }).consecutiveToolCalls).toBe(1);
    budget.beginPrompt();
    expect(budget.observe('Read', { path: 'a' }).identicalCalls).toBe(1);
    expect(budget.observe('Read', { path: 'b' }).totalToolCalls).toBe(2);
  });

  test('blocks the eighth consecutive call even when every input differs', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index < 8; index += 1) {
      expect(budget.observe('Bash', { command: `check-${index}` }).action).not.toBe('block');
    }
    const decision = budget.observe('Bash', { command: 'check-8' });
    expect(decision.action).toBe('block');
    expect(decision.consecutiveToolCalls).toBe(8);
    expect(decision.totalToolCalls).toBe(8);
  });

  test('blocks the twenty-fourth tool call even when tool names alternate', () => {
    const budget = new ToolLoopBudget();
    for (let index = 1; index < 24; index += 1) {
      const toolName = index % 2 === 0 ? 'Read' : 'Grep';
      expect(budget.observe(toolName, { index }).action).not.toBe('block');
    }
    const decision = budget.observe('Read', { index: 24 });
    expect(decision.action).toBe('block');
    expect(decision.totalToolCalls).toBe(24);
  });
});
