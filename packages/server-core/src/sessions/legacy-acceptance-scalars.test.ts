import { describe, expect, it } from 'bun:test';
import { validateToolArguments, type Tool } from '@earendil-works/pi-ai';
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import { buildObjectiveContractPrompt, objectiveReviewBinding, transitionObjectiveContract } from './objective-contract.ts';
import { collectObjectiveAcceptanceObservations, projectObjectiveAcceptanceCriteria, registerObjectiveAcceptanceCriteria,
  validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';
import { buildObjectiveValidationEvidenceContext } from './objective-validation-context.ts';
import { formatLegacyAcceptanceScalarDiagnostic } from './legacy-acceptance-scalars.ts';
import { validateObjectiveOutcome } from './objective-outcome.ts';

const root: Message = { id: 'root', role: 'user', content: 'Vérifie le résultat demandé.', timestamp: 10 };
const typed: ObjectiveAcceptanceCriterion = {
  id: 'target-ready', description: 'The requested target returns the exact registered state',
  toolName: 'mcp__service__get_status', input: { target: 'requested-target', timeout: 120 },
  checks: [{ path: '$.count', equals: 1 }, { path: '$.ready', equals: true },
    { path: '$.missing', equals: null }, { path: '$.literal', equals: '001' }],
};
// The historical SDK transport: the first matching AJV anyOf branch coerces
// each JSON scalar to string before the host receives the registration.
const oldScalar = { anyOf: [{ type: 'string', maxLength: 2048 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] };
function throughOldSdk(criteria: ObjectiveAcceptanceCriterion[]): ObjectiveAcceptanceCriterion[] {
  const args = validateToolArguments({ name: 'set_completion_criteria', description: '', parameters: {
    type: 'object', properties: { criteria: { type: 'array', items: { type: 'object', properties: {
      input: { type: 'object', additionalProperties: oldScalar },
      checks: { type: 'array', items: { type: 'object', properties: { equals: oldScalar } } },
    } } } },
  } } as Tool, { type: 'toolCall', id: 'register-call', name: 'set_completion_criteria', arguments: { criteria: structuredClone(criteria) } });
  return args.criteria as ObjectiveAcceptanceCriterion[];
}
function fixture(criteria = [typed]) {
  const stored = throughOldSdk(criteria);
  const objective = registerObjectiveAcceptanceCriteria(
    transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: root.timestamp }), stored, 20);
  const registration: Message = { id: 'registration', toolUseId: 'register-call', role: 'tool', content: '',
    timestamp: 19, toolName: 'mcp__session__set_completion_criteria', toolStatus: 'completed', toolExecuted: true,
    toolInput: { criteria: structuredClone(criteria), _displayName: 'Register checks', _intent: 'Register the requested check' },
    toolResult: JSON.stringify({ objectiveId: objective.objectiveId, criteria: stored }),
  };
  const observation: Message = { id: 'observation', toolUseId: 'observed-call', role: 'tool', content: '', timestamp: 30,
    toolName: typed.toolName, toolInput: structuredClone(typed.input), toolStatus: 'completed', toolExecuted: true,
    toolResult: '{"count":1,"ready":true,"missing":null,"literal":"001"}',
  };
  const receipt: ObjectiveOutcomeDeclaration = { state: 'complete_verified', remainingWork: [], blocker: null,
    criteria: [...objective.completionCriteria, ...criteria.map(c => c.id)].map(id => ({ id, satisfied: true,
      evidence: id === 'relevant-checks-passed' || criteria.some(c => c.id === id) ? ['observed-call'] : ['assistant-final'] })),
  };
  return { objective, registration, observation, receipt, messages: [root, registration, observation] };
}

describe('evaluation-only legacy scalar transport recovery', () => {
  it('preserves attested historical projection even when the old contract contains incompatible equalities', () => {
    const originals = [typed, { ...typed, id: 'old-other-count', checks: [{ path: '$.count', equals: 2 }] }];
    const stored = throughOldSdk(originals);
    const f = fixture();
    f.objective.acceptanceCriteria = stored;
    f.registration.toolInput!.criteria = structuredClone(originals);
    f.registration.toolResult = JSON.stringify({ objectiveId: f.objective.objectiveId, criteria: stored });
    const before = structuredClone(f);
    const projected = projectObjectiveAcceptanceCriteria(f.objective, f.messages);
    expect(projected.diagnostic?.kind).toBe('legacy-scalar-coercion');
    expect(projected.criteria).toEqual(originals);
    expect(collectObjectiveAcceptanceObservations(f.objective, f.messages).map(item => item.passed)).toEqual([true, false]);
    expect(registerObjectiveAcceptanceCriteria(f.objective, structuredClone(stored), 99)).toEqual(f.objective);
    expect(f).toEqual(before);
  });
  it('replays the actual historical SDK coercion and repairs types without mutating the saved contract or transcript', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    expect(f.objective.acceptanceCriteria![0]!.input.timeout).toBe('120');
    expect(f.objective.acceptanceCriteria![0]!.checks.map(c => c.equals)).toEqual(['1', 'true', '', '001']);
    expect(validateObjectiveAcceptanceCriteria(f.objective, [root, f.observation], f.receipt)).toHaveLength(1);
    const projected = projectObjectiveAcceptanceCriteria(f.objective, f.messages);
    expect(projected.criteria).toEqual([typed]);
    expect(projected.diagnostic).toMatchObject({ kind: 'legacy-scalar-coercion', objectiveId: 'root',
      registrationMessageId: 'registration', registrationToolUseId: 'register-call', scalarChangeCount: 4 });
    expect(projected.diagnostic!.persistedCriteriaSha256).toBe(objectiveReviewBinding(f.objective).acceptanceSha256);
    expect(projected.diagnostic!.projectedCriteriaSha256).not.toBe(projected.diagnostic!.persistedCriteriaSha256);
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.receipt)).toEqual([]);
    expect(validateObjectiveOutcome(f.receipt, { objective: f.objective, messages: f.messages }).valid).toBe(true);
    expect(collectObjectiveAcceptanceObservations(f.objective, f.messages).map(x => x.passed)).toEqual([true]);
    expect(JSON.stringify(f)).toBe(before);
  });

  it('recovers original false from the real SDK without accepting string false as an observed boolean', () => {
    const disabled: ObjectiveAcceptanceCriterion = { ...typed, checks: [{ path: '$.disabled', equals: false }] };
    const f = fixture([disabled]);
    f.observation.toolResult = '{"disabled":false}';
    expect(f.objective.acceptanceCriteria![0]!.checks[0]!.equals).toBe('false');
    expect(projectObjectiveAcceptanceCriteria(f.objective, f.messages).criteria[0]!.checks[0]!.equals).toBe(false);
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.receipt)).toEqual([]);
    f.observation.toolResult = '{"disabled":"false"}';
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.receipt)).toHaveLength(1);
  });

  it.each(['1', '001', 'true', 'false', ''])('preserves intentional string %j alongside genuinely coerced fields', text => {
    const c = { ...typed, checks: [{ path: '$.literal', equals: text }] };
    const f = fixture([c]);
    const p = projectObjectiveAcceptanceCriteria(f.objective, f.messages);
    expect(p.criteria).toEqual([c]);
    expect(p.criteria[0]!.checks[0]!.equals).toBe(text);
    expect(p.diagnostic!.scalarChangeCount).toBe(1); // timeout only
    const stringsOnly = fixture([{ ...c, input: { target: 'target', timeout: '120' } }]);
    expect(projectObjectiveAcceptanceCriteria(stringsOnly.objective, stringsOnly.messages).diagnostic).toBeUndefined();
  });

  it('does not weaken observation types, target, real execution, declared IDs, or chronology', () => {
    const f = fixture();
    for (const patch of [
      { toolInput: { ...typed.input, timeout: '120' } }, { toolInput: { ...typed.input, target: 'another-target' } },
      { toolName: 'mcp__other__get_status' }, { toolResult: '{"count":"1","ready":true,"missing":null,"literal":"001"}' },
      { toolResult: '{"count":1,"ready":"true","missing":null,"literal":"001"}' },
      { toolResult: '{"count":1,"ready":true,"missing":"","literal":"001"}' },
      { toolResult: '{"count":1,"ready":true,"missing":null,"literal":1}' },
      { toolExecuted: false }, { toolStatus: 'error' as const }, { isError: true }, { timestamp: 9 },
      { toolUseId: 'invented' }, { toolResult: 'PASS' },
    ]) expect(validateObjectiveOutcome(f.receipt, { objective: f.objective,
      messages: [root, f.registration, { ...f.observation, ...patch }] }).valid).toBe(false);
    const mutation: Message = { ...f.observation, id: 'mutation', toolUseId: 'mutation', timestamp: 31,
      toolName: 'Write', toolInput: { path: '/tmp/state', content: 'changed' } };
    expect(validateObjectiveAcceptanceCriteria(f.objective, [...f.messages, mutation], f.receipt)).toHaveLength(1);
    expect(f.objective.acceptanceRegisteredAt).toBe(20);
  });

  it('requires exactly one complete successful registration in the current objective', () => {
    const f = fixture();
    for (const patch of [
      { role: 'assistant' as const }, { toolName: 'mcp__other__set_completion_criteria' },
      { toolName: 'functions.set_completion_criteria' }, { toolExecuted: false }, { toolExecuted: undefined },
      { toolStatus: 'executing' as const }, { toolStatus: 'error' as const }, { isError: true },
      { toolCheckpoint: {} as never }, { toolUseId: undefined }, { id: '' }, { timestamp: 9 }, { timestamp: 21 },
      { toolResult: undefined }, { continuationRequired: true },
    ]) expect(projectObjectiveAcceptanceCriteria(f.objective, [root, { ...f.registration, ...patch }, f.observation]).diagnostic).toBeUndefined();
    for (const messages of [
      [f.registration, root, f.observation], [f.registration, f.observation],
      [root, f.registration, { ...f.registration, id: 'duplicate' }, f.observation],
      [root, f.registration, { ...f.registration, id: 'unknown-success', toolExecuted: undefined }, f.observation],
      [root, f.registration, { ...f.registration, id: 'pending', toolStatus: 'executing' as const }, f.observation],
    ]) expect(projectObjectiveAcceptanceCriteria(f.objective, messages).diagnostic).toBeUndefined();
    const previous = { ...root, id: 'previous-root', timestamp: 1 };
    expect(projectObjectiveAcceptanceCriteria(f.objective, [previous, f.registration, ...f.messages]).diagnostic).toBeDefined();
    const failed = { ...f.registration, id: 'failed', isError: true };
    expect(projectObjectiveAcceptanceCriteria(f.objective, [root, failed, f.registration, f.observation]).diagnostic).toBeDefined();
  });

  it('requires the exact host ACK, current objective, complete criteria and deterministic legacy conversion', () => {
    const f = fixture();
    const ack = JSON.parse(f.registration.toolResult!);
    const other = structuredClone(ack.criteria[0]); other.id = 'other';
    const badResults = [
      'PASS', `Explanation ${f.registration.toolResult}`, `${f.registration.toolResult}\n{}`, f.registration.toolResult!.slice(0, -1),
      JSON.stringify({ ...ack, objectiveId: 'another-root' }), JSON.stringify({ ...ack, extra: true }),
      JSON.stringify({ ...ack, criteria: [] }), JSON.stringify({ ...ack, criteria: [...ack.criteria, other] }),
      JSON.stringify({ nested: ack }), `{"objectiveId":"other",${f.registration.toolResult!.slice(1)}`,
      JSON.stringify({ content: [{ type: 'text', text: f.registration.toolResult }, { type: 'text', text: f.registration.toolResult }] }),
      JSON.stringify({ isError: true, content: [{ type: 'text', text: f.registration.toolResult }] }),
    ];
    for (const toolResult of badResults) expect(projectObjectiveAcceptanceCriteria(f.objective,
      [root, { ...f.registration, toolResult }, f.observation]).diagnostic).toBeUndefined();
    const enveloped = { ...f.registration, toolResult: JSON.stringify({ content: [{ type: 'text', text: f.registration.toolResult }] }) };
    expect(projectObjectiveAcceptanceCriteria(f.objective, [root, enveloped, f.observation]).diagnostic).toBeDefined();
    for (const field of ['id', 'description', 'toolName', 'input', 'checks']) {
      const changed = structuredClone(ack.criteria);
      changed[0][field] = field === 'input' ? { ...changed[0].input, target: 'different' }
        : field === 'checks' ? [{ path: '$.different', equals: '1' }] : 'changed';
      expect(projectObjectiveAcceptanceCriteria({ ...f.objective, acceptanceCriteria: changed }, f.messages).diagnostic).toBeUndefined();
    }
    const wrongRaw = structuredClone(f.registration.toolInput!);
    (wrongRaw.criteria as ObjectiveAcceptanceCriterion[])[0]!.checks[0]!.equals = 2;
    expect(projectObjectiveAcceptanceCriteria(f.objective, [root, { ...f.registration, toolInput: wrongRaw }]).diagnostic).toBeUndefined();
    const additive = { ...f.objective, acceptanceCriteria: [...f.objective.acceptanceCriteria!, other] };
    expect(projectObjectiveAcceptanceCriteria(additive, [root, { ...f.registration,
      toolResult: JSON.stringify({ ...ack, criteria: additive.acceptanceCriteria }) }]).diagnostic).toBeUndefined();
  });

  it('rejects invalid original selectors/scalars/structure even when a fabricated ACK mirrors their coercion', () => {
    for (const raw of [
      { ...typed, input: { 'constructor.secret': 1 } }, { ...typed, input: { '$.bad..path': 1 } },
      { ...typed, input: { target: { nested: 1 } } }, { ...typed, input: { target: [1] } },
      { ...typed, input: { target: NaN } }, { ...typed, input: { target: Infinity } },
      { ...typed, input: { target: 'x'.repeat(2049) } }, { ...typed, extra: true },
      { ...typed, checks: [{ path: '$text', equals: 1 }] },
      { ...typed, checks: [{ path: '$.count', equals: 1, extra: true }] },
    ]) {
      const f = fixture();
      const saved = JSON.parse(JSON.stringify(raw, (key, value) => key === 'target' || key === 'equals' ? String(value) : value));
      const objective = { ...f.objective, acceptanceCriteria: [saved] };
      const registration = { ...f.registration, toolInput: { criteria: [raw] },
        toolResult: JSON.stringify({ objectiveId: objective.objectiveId, criteria: [saved] }) };
      expect(projectObjectiveAcceptanceCriteria(objective, [root, registration]).diagnostic).toBeUndefined();
    }
    const f = fixture();
    expect(projectObjectiveAcceptanceCriteria(f.objective, [root, { ...f.registration,
      toolInput: { ...f.registration.toolInput, additional: true } }]).diagnostic).toBeUndefined();
  });

  it('refuses high-risk, mandatory evidence, independent-review requirements and every accepted review-tool alias', () => {
    const f = fixture();
    for (const objective of [
      { ...f.objective, risk: 'high-stakes' as const },
      { ...f.objective, evidenceRequirement: 'authoritative-sources-before-mutation' as const },
      { ...f.objective, completionCriteria: [...f.objective.completionCriteria, 'independent-review-passed' as const] },
      { ...f.objective, acceptanceRegisteredAt: undefined },
    ]) expect(projectObjectiveAcceptanceCriteria(objective, f.messages).diagnostic).toBeUndefined();
    for (const toolName of ['mcp__session__call_llm', 'functions.call_llm', 'mcp__security__reviewer',
      'custom_review', 'mcp__session__spawn_session', 'mcp__session__wait_sessions']) {
      const review = { verdict: 'PASS', ...objectiveReviewBinding(f.objective), findings: [],
        criteria: [{ id: typed.id, passed: true }] };
      const toolResult = toolName.endsWith('wait_sessions')
        ? JSON.stringify({ outcome: 'completed', sessions: [{ sessionId: 'child', state: 'idle', reason: 'complete', finalText: JSON.stringify(review) }] })
        : JSON.stringify(review);
      const message: Message = { ...f.observation, id: 'review', toolName, toolInput: { sessionIds: ['child'] }, toolResult };
      expect(projectObjectiveAcceptanceCriteria(f.objective, [...f.messages, message]).diagnostic).toBeUndefined();
    }
    const unrelated = { ...f.observation, toolName: 'mcp__session__call_llm', toolResult: 'A summary, without any review receipt' };
    expect(projectObjectiveAcceptanceCriteria(f.objective, [...f.messages, unrelated]).diagnostic).toBeDefined();
  });

  it('exposes typed effective criteria and provenance to repair prompts without certifying observations or changing the stored contract', () => {
    const f = fixture();
    const projection = projectObjectiveAcceptanceCriteria(f.objective, f.messages);
    const context = buildObjectiveValidationEvidenceContext(f.messages, f.objective)!;
    expect(context).toContain('"timeout":120');
    expect(context).toContain('"path":"$.count","equals":1');
    expect(context).toContain('"registrationMessageId":"registration"');
    expect(context).toContain('"messageId":"observation"');
    expect(context).not.toContain(f.observation.toolResult!);
    expect(context).toContain('does not establish that any criterion passed');
    const prompt = buildObjectiveContractPrompt({ ...f.objective, acceptanceCriteria: projection.criteria })
      + '\n' + formatLegacyAcceptanceScalarDiagnostic(projection.diagnostic!);
    expect(prompt).toContain('"timeout":120');
    expect(prompt).toContain('in memory only');
    expect(buildObjectiveValidationEvidenceContext([root, f.registration], f.objective)).toContain('legacy-scalar-coercion');
    expect(f.objective.acceptanceCriteria![0]!.input.timeout).toBe('120');
  });

  it('uses the same projection in the real SessionManager runtime prompt without creating a manager or agent', async () => {
    const { SessionManager } = await import('./SessionManager.ts');
    const f = fixture();
    const before = JSON.stringify(f);
    const prototype = SessionManager.prototype as unknown as {
      buildObjectiveRuntimePrompt(managed: { messages: Message[] }, objective: typeof f.objective): string;
    };
    const prompt = prototype.buildObjectiveRuntimePrompt({ messages: f.messages }, f.objective);
    expect(prompt).toContain('"timeout":120');
    expect(prompt).toContain('"path":"$.count","equals":1');
    expect(prompt).toContain('"registrationMessageId":"registration"');
    expect(prompt).toContain('in memory only');
    expect(JSON.stringify(f)).toBe(before);
    const ordinary = prototype.buildObjectiveRuntimePrompt({ messages: [root, f.observation] }, f.objective);
    expect(ordinary).toContain('"timeout":"120"');
    expect(ordinary).not.toContain('legacy-scalar-coercion');
  });
});
