import { describe, expect, it } from 'bun:test';
import type { Message } from '@craft-agent/core/types';
import { classifyLatestTurnTerminalState, classifyObjectiveTerminalState, incompletePlanSteps } from './turn-completion.ts';
import { buildObjectiveScopePrompt, objectiveReviewBinding, transitionObjectiveContract } from './objective-contract.ts';

const root: Message = { id: 'request', role: 'user', content: 'Vérifie cleanup et archive puis livre le rapport.', timestamp: 1 };
const final: Message = { id: 'final', role: 'assistant', content: 'Le rapport est prêt.', timestamp: 8 };
function plan(id: string, steps: Array<[string, string]>, overrides: Partial<Message> = {}): Message {
  return { id, role: 'tool', content: '', timestamp: 2, toolName: 'mcp__session__update_plan',
    toolStatus: 'completed', toolExecuted: true,
    toolInput: { plan: steps.map(([step, status]) => ({ step, status })) }, ...overrides };
}

describe('completion against the existing live checklist', () => {
  it('keeps a forgotten named target open even if a later plan omits it or becomes empty', () => {
    const messages = [root, plan('initial', [['cleanup', 'pending'], ['archive', 'pending']]),
      plan('partial', [['cleanup', 'completed']]), plan('clear', []), final];
    expect(incompletePlanSteps(messages, root.id)).toEqual(['archive']);
    expect(classifyLatestTurnTerminalState(messages, root.id)).toBe('premature-final-assistant');
    expect(classifyObjectiveTerminalState(final.content, { remainingPlanSteps: ['archive'] })).toBe('continue');
  });

  it('finishes after every original step is completed, including across persisted reloads', () => {
    const messages = [root, plan('initial', [['cleanup', 'completed'], ['archive', 'in_progress']]),
      plan('verified', [['cleanup', 'completed'], ['archive', 'completed']]), final];
    for (const state of [messages, JSON.parse(JSON.stringify(messages)) as Message[]]) {
      expect(incompletePlanSteps(state, root.id)).toEqual([]);
      expect(classifyLatestTurnTerminalState(state, root.id)).toBe('final-assistant');
    }
  });

  it('accepts native TodoWrite without adding a task protocol', () => {
    const native = plan('native', [], { toolName: 'TodoWrite', toolInput: { todos: [
      { content: 'cleanup', status: 'completed', activeForm: 'Checking cleanup' },
      { content: 'archive', status: 'pending', activeForm: 'Checking archive' },
    ] } });
    expect(incompletePlanSteps([root, native, final], root.id)).toEqual(['archive']);
  });

  it('does not use a foreign connector, a failed call or malformed plan to erase pending work', () => {
    const initial = plan('initial', [['archive', 'pending']]);
    for (const invalid of [
      plan('foreign', [['archive', 'completed']], { toolName: 'mcp__other__update_plan' }),
      plan('failed', [['archive', 'completed']], { toolStatus: 'error' }),
      plan('unexecuted', [['archive', 'completed']], { toolExecuted: false }),
      plan('malformed', [['archive', 'completed']], { toolInput: { plan: [{ step: 'archive' }] } }),
    ]) expect(incompletePlanSteps([root, initial, invalid, final], root.id)).toEqual(['archive']);
  });

  it('does not import tasks from a different objective', () => {
    const next: Message = { ...root, id: 'new-request', content: 'Autre objectif : réponds bonjour.', timestamp: 5 };
    expect(incompletePlanSteps([root, plan('old', [['archive', 'pending']]), next, final], next.id)).toEqual([]);
    expect(classifyLatestTurnTerminalState([root, plan('old', [['archive', 'pending']]), next, final], next.id)).toBe('final-assistant');
  });

  it('retains legitimate human and policy blockers while tasks remain', () => {
    for (const text of ['Connecte-toi : OAuth est requis pour terminer.', 'La politique interdit cette mutation.']) {
      const messages = [root, plan('initial', [['archive', 'pending']]), { ...final, content: text }];
      expect(classifyLatestTurnTerminalState(messages, root.id)).toBe('final-assistant');
      expect(classifyObjectiveTerminalState(text, { remainingPlanSteps: ['archive'] })).toMatch(/^blocked_/);
    }
  });

  it('cannot use a structured success to bypass an unfinished plan', () => {
    expect(classifyObjectiveTerminalState(final.content, { declaredState: 'complete_verified',
      structuredOutcomeValid: true, remainingPlanSteps: ['archive'] })).toBe('continue');
  });

  it('preserves a direct answer with no plan and no machine receipt', () => {
    expect(classifyLatestTurnTerminalState([root, final], root.id)).toBe('final-assistant');
    expect(classifyObjectiveTerminalState(final.content)).toBe('complete_verified');
  });
});

describe('small scope reminders instead of a second orchestration layer', () => {
  it('keeps the full request and accepted amendments through continuation without a host contract', () => {
    const initial = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const amended = transitionObjectiveContract({ existing: initial, messageId: 'clarification',
      text: 'Ajoute aussi une annexe au même rapport.', nowMs: 3 });
    const messages: Message[] = [root, { id: 'clarification', role: 'user', content: 'Ajoute aussi une annexe au même rapport.', timestamp: 3 }];
    const prompt = buildObjectiveScopePrompt(amended, messages, 'retry', ['archive']);
    expect(prompt).toContain(root.content);
    expect(prompt).toContain('annexe');
    expect(prompt).toContain('archive');
    expect(prompt).not.toContain('host_objective_contract');
    expect(prompt).not.toContain('robb_objective_outcome');
    expect(buildObjectiveScopePrompt(initial, [root], root.id)).toBe('');
    expect(buildObjectiveScopePrompt(JSON.parse(JSON.stringify(amended)), messages, 'retry', ['archive'])).toBe(prompt);
  });

  it('binds a structured review to the request as well as its chosen checks', () => {
    const objective = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    expect(objectiveReviewBinding(objective)).not.toEqual(objectiveReviewBinding({ ...objective, originalText: 'Vérifie cleanup seulement.' }));
    expect(objectiveReviewBinding(objective)).not.toEqual(objectiveReviewBinding({ ...objective,
      amendments: [{ messageId: 'extra', text: 'Livre aussi le PDF.', timestamp: 2 }] }));
  });
});
