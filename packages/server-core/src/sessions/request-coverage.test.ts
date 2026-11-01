import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import { transitionObjectiveContract } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { validateObjectiveOutcome } from './objective-outcome.ts';
import { scopeReviewFixture } from './__fixtures__/scope-review.ts';

const root: Message = { id: 'request', role: 'user', timestamp: 1,
  content: 'Vérifie les deux minuteurs cleanup et archive sur le serveur dev et fournis leur état.' };
const criterion = (timer: string): ObjectiveAcceptanceCriterion => ({
  id: `${timer}-active`, description: `${timer} is enabled`, toolName: 'mcp__ops__get_timer',
  input: { host: 'dev', timer }, checks: [{ path: 'enabled', equals: true }],
});
function scenario(targets: string[]) {
  const objective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), targets.map(criterion), 2);
  const messages: Message[] = [root, ...targets.map((timer, index): Message => ({
    id: `${timer}-result`, toolUseId: `${timer}-call`, role: 'tool', content: '', timestamp: 3 + index,
    toolName: 'mcp__ops__get_timer', toolStatus: 'completed', toolExecuted: true,
    toolInput: { host: 'dev', timer }, toolResult: JSON.stringify({ enabled: true }),
  }))];
  const declaration: ObjectiveOutcomeDeclaration = { state: 'complete_verified', blocker: null, remainingWork: [],
    criteria: [...targets.map(timer => ({ id: `${timer}-active`, satisfied: true, evidence: [`${timer}-call`] })),
      ...objective.completionCriteria.map(id => ({ id, satisfied: true, evidence: ['cleanup-call'] }))] };
  return { objective, messages, declaration };
}

describe('original request coverage, beyond the checks selected by the executor', () => {
  it('rejects the audit reproduction: one of two named targets registered and observed', () => {
    const { objective, messages, declaration } = scenario(['cleanup']);
    const result = validateObjectiveOutcome(declaration, { objective, messages });
    expect(result.valid).toBe(false);
    expect(result.state).toBe('continue');
    expect(result.gaps).toContain('Full-request coverage requires the current independent review, not only a successful registered observation');
  });

  it('does not compensate a missing requirement with a failing scope review', () => {
    const { objective, messages, declaration } = scenario(['cleanup']);
    messages.push(scopeReviewFixture(objective, messages, 'FAIL'));
    expect(validateObjectiveOutcome(declaration, { objective, messages }).valid).toBe(false);
  });

  it('accepts both observations after the existing independent review covers the whole request', () => {
    const { objective, messages, declaration } = scenario(['cleanup', 'archive']);
    messages.push(scopeReviewFixture(objective, messages));
    expect(validateObjectiveOutcome(declaration, { objective, messages })).toMatchObject({ valid: true, state: 'complete_verified' });
  });

  it('still rejects a registered target with no observation, even if a reviewer claims PASS', () => {
    const { objective, messages, declaration } = scenario(['cleanup', 'archive']);
    const partial = messages.filter(message => message.id !== 'archive-result');
    partial.push(scopeReviewFixture(objective, partial));
    expect(validateObjectiveOutcome(declaration, { objective, messages: partial }).valid).toBe(false);
  });

  it('invalidates a scope review when the original request or its amendments change', () => {
    const { objective, messages, declaration } = scenario(['cleanup', 'archive']);
    messages.push(scopeReviewFixture(objective, messages));
    for (const changed of [
      { ...objective, originalText: root.content + ' Livre aussi un rapport PDF.' },
      { ...objective, amendments: [{ messageId: 'extra', text: 'Ajoute le minuteur cleanup-weekly.', timestamp: 5 }] },
    ]) expect(validateObjectiveOutcome(declaration, { objective: changed, messages }).valid).toBe(false);
  });
});
