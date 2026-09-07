import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from '@craft-agent/core/types';
import { buildObjectiveContractPrompt, objectiveReviewBinding, findObjectiveText, transitionObjectiveContract } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { validateObjectiveOutcome } from './objective-outcome.ts';

const criterion: ObjectiveAcceptanceCriterion = {
  id: 'timer-active', description: 'The authorized timer is active on the requested host',
  toolName: 'mcp__ops__get_timer', input: { host: 'dev', timer: 'cleanup' },
  checks: [{ path: 'enabled', equals: true }, { path: 'nextRunScheduled', equals: true }],
};
const root: Message = { id: 'u1', role: 'user', content: 'Active et vérifie le minuteur.', timestamp: 1 };
const objective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [criterion], 2);
const observation: Message = {
  id: 'm1', toolUseId: 't1', role: 'tool', content: '', toolName: criterion.toolName,
  toolStatus: 'completed', toolExecuted: true, timestamp: 4,
  toolInput: { host: 'dev', timer: 'cleanup' }, toolResult: '{"enabled":true,"nextRunScheduled":true}',
};
const receipt: ObjectiveOutcomeDeclaration = {
  state: 'complete_verified', blocker: null, remainingWork: [],
  criteria: [
    { id: 'timer-active', satisfied: true, evidence: ['t1'] },
    ...objective.completionCriteria.map(id => ({ id, satisfied: true, evidence: [id === 'relevant-checks-passed' ? 't1' : 'assistant-final'] })),
  ],
};

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
  it('accepts exact state and rejects disabled timers, wrong targets, stale or absent observations', () => {
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], receipt)).toEqual([]);
    for (const changes of [
      { toolResult: '{"enabled":false,"nextRunScheduled":true}' },
      { toolInput: { host: 'production', timer: 'cleanup' } },
      { timestamp: 1 }, { toolExecuted: false }, { toolResult: 'PASS' },
      { toolResult: '{"content":[{"type":"text","text":""}]}' },
      { toolName: 'mcp__other__get_timer' },
    ]) expect(validateObjectiveOutcome(receipt, { objective, messages: [root, { ...observation, ...changes }] }).valid).toBe(false);
  });
  it('supports safe root JSONPath selectors and numeric array indices', () => {
    const criteria: ObjectiveAcceptanceCriterion[] = [
      {
        id: 'crm-opportunity-updated', description: 'The opportunity has the requested state',
        toolName: 'mcp__comptabilite__sellsy_get_opportunity', input: { id: 10926974 },
        checks: [
          { path: '$.name', equals: 'CERFrance Côte d’Armor — Conférence IA — 12 novembre 2026' },
          { path: '$.due_date', equals: '2026-11-12' },
          { path: '$.status', equals: 'open' },
          { path: '$.step.id', equals: 345681 },
        ],
      },
      {
        id: 'gmail-message-delivered', description: 'The sent message has the requested envelope',
        toolName: 'mcp__google-contacts__gmail_list_messages', input: { q: 'in:sent subject:"CERFrance"', maxResults: 1 },
        checks: [
          { path: '$[0].subject', equals: 'Intervention du 12 novembre 2026 — entité de facturation et lieu' },
          { path: '$[0].from', equals: 'Thibault Fritsch <thibault@robinswood.io>' },
          { path: '$[0].labelIds[0]', equals: 'SENT' },
        ],
      },
    ];
    const jsonObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), criteria, 2,
    );
    const sellsy: Message = {
      ...observation, id: 'sellsy-message', toolUseId: 'sellsy-check', timestamp: 4,
      toolName: criteria[0]!.toolName, toolInput: { id: 10926974 },
      toolResult: JSON.stringify({
        name: 'CERFrance Côte d’Armor — Conférence IA — 12 novembre 2026', due_date: '2026-11-12',
        status: 'open', step: { id: 345681 },
      }),
    };
    const gmail: Message = {
      ...observation, id: 'gmail-message', toolUseId: 'gmail-check', timestamp: 5,
      toolName: criteria[1]!.toolName, toolInput: { q: 'in:sent subject:"CERFrance"', maxResults: 1 },
      toolResult: JSON.stringify([{
        subject: 'Intervention du 12 novembre 2026 — entité de facturation et lieu',
        from: 'Thibault Fritsch <thibault@robinswood.io>', labelIds: ['SENT'],
      }]),
    };
    const jsonReceipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        { id: criteria[0]!.id, satisfied: true, evidence: ['sellsy-check'] },
        { id: criteria[1]!.id, satisfied: true, evidence: ['gmail-check'] },
        ...jsonObjective.completionCriteria.map(id => ({
          id, satisfied: true, evidence: [id === 'relevant-checks-passed' ? 'gmail-check' : 'assistant-final'],
        })),
      ],
    };
    expect(validateObjectiveAcceptanceCriteria(jsonObjective, [root, sellsy, gmail], jsonReceipt)).toEqual([]);
  });
  it('rejects dynamic, ambiguous and prototype-traversing JSONPath expressions', () => {
    for (const path of ['$..enabled', '$.', '$.[0]', '$[*].enabled', '$[?(@.enabled)]', '$[-1]', '$.constructor.enabled']) {
      expect(() => registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, checks: [{ path, equals: true }] }], 2,
      )).toThrow('Invalid JSON selector');
    }
  });
  it('rejects evidence before a mutation even if all technical flags pass', () => {
    const mutation: Message = { ...observation, id: 'm2', toolUseId: 't2', toolName: 'Edit', toolInput: { file_path: '/tmp/timer' } };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, mutation], receipt)).toHaveLength(1);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, mutation, observation], receipt)).toEqual([]);
  });
  it('requires registered checks for new actionable objectives and rechecks after partial failure', () => {
    const unregistered = transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 });
    expect(validateObjectiveAcceptanceCriteria(unregistered, [root, observation], receipt)).toHaveLength(1);
    const partial: Message = { ...observation, id: 'partial', toolUseId: 'partial', toolName: 'Edit', toolStatus: 'error', isError: true, toolResult: 'Wrote part of the file before failing' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, partial], receipt)).toHaveLength(1);
  });
  it('binds independent review to the original goal and exact target/version criteria — E12', () => {
    const reviewedObjective = { ...objective, completionCriteria: [...objective.completionCriteria, 'independent-review-passed' as const] };
    const final = { ...receipt, criteria: [...receipt.criteria, { id: 'independent-review-passed', satisfied: true, evidence: ['review'] }] };
    const reviewed = { verdict: 'PASS', ...objectiveReviewBinding(reviewedObjective), findings: [],
      criteria: [...objective.completionCriteria, criterion.id].map(id => ({ id, passed: true })) };
    const review: Message = { ...observation, id: 'review', toolUseId: 'review', toolName: 'mcp__llm__call_llm', timestamp: 6, toolResult: JSON.stringify(reviewed) };
    expect(validateObjectiveOutcome(final, { objective: reviewedObjective, messages: [root, observation, review] }).valid).toBe(true);
    for (const changed of [{ acceptanceSha256: 'old-version' }, { objectiveId: 'another-goal' }]) {
      expect(validateObjectiveOutcome(final, { objective: reviewedObjective, messages: [root, observation, { ...review, toolResult: JSON.stringify({ ...reviewed, ...changed }) }] }).valid).toBe(false);
    }
  });
  it('supports exact textual observations without accepting substring success claims', () => {
    const textCriterion = { ...criterion, checks: [{ path: '$text', equals: 'timer cleanup on dev: enabled, next run scheduled' }] };
    const textObjective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [textCriterion], 2);
    const textResult = { ...observation, toolResult: textCriterion.checks[0]!.equals };
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, textResult], receipt)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, { ...textResult, toolResult: `${textResult.toolResult} BUT FAILED` }], receipt)).toHaveLength(1);
  });
  it('accepts an exact tool-name alias without letting it bypass target or result checks', () => {
    const aliasReceipt: ObjectiveOutcomeDeclaration = {
      ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: [`tool:${criterion.toolName}`] }],
    };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], aliasReceipt)).toEqual([]);
    for (const changes of [
      { toolInput: { host: 'production', timer: 'cleanup' } },
      { toolResult: '{"enabled":false,"nextRunScheduled":true}' },
    ]) expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, ...changes }], aliasReceipt)).toHaveLength(1);
    for (const ref of ['assistant-final', 'tool:mcp__other__get_timer']) {
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], {
        ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: [ref] }],
      })).toHaveLength(1);
    }
  });
  it('freezes expectations and registration time; only additive changes are allowed', () => {
    expect(registerObjectiveAcceptanceCriteria(objective, [criterion], 99)).toEqual(objective);
    expect(() => registerObjectiveAcceptanceCriteria(objective, [{ ...criterion, checks: [{ path: 'enabled', equals: false }] }])).toThrow('cannot be weakened');
    expect(() => registerObjectiveAcceptanceCriteria(objective, [{ ...criterion, input: { 'constructor.prototype': true } }])).toThrow();
    expect(() => registerObjectiveAcceptanceCriteria(objective, [criterion, criterion])).toThrow();
  });
  it('retains the original request across continuation, reload and missing transcript context', () => {
    const continued = transitionObjectiveContract({ existing: JSON.parse(JSON.stringify(objective)), messageId: 'u2', text: 'Poursuit' });
    expect(findObjectiveText([], continued)).toBe(root.content);
    expect(continued.acceptanceCriteria).toEqual([criterion]);
    expect(buildObjectiveContractPrompt(continued)).toContain(root.content);
    const next = transitionObjectiveContract({ existing: continued, messageId: 'u3', text: 'Nouvel objectif : analyse le dossier différent.' });
    expect(next.acceptanceCriteria).toBeUndefined();
  });
  it('requires actual observations for inspection requests without requiring mutations', () => {
    const inspect = transitionObjectiveContract({ messageId: 'u1', text: 'Inspecte le serveur en lecture seule.' });
    expect(inspect.requiresObservationEvidence).toBe(true);
    expect(inspect.requiresExecutionEvidence).toBeUndefined();
    expect(buildObjectiveContractPrompt(inspect)).toContain('machine-readable');
  });
});
