import { describe, expect, it } from 'bun:test';
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import { validateObjectiveOutcome } from './objective-outcome.ts';
import { buildObjectiveValidationEvidenceContext } from './objective-validation-context.ts';
import { objectiveReviewBinding, transitionObjectiveContract } from './objective-contract.ts';
import { collectObjectiveAcceptanceObservations, projectObjectiveAcceptanceCriteria,
  registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';

const toolName = 'mcp__marketing__gsc_list_sites';
const siteUrl = 'https://requested.example/';
const root: Message = { id: 'root', role: 'user', content: 'Verify ownership of the requested property.', timestamp: 10 };
const criterion: ObjectiveAcceptanceCriterion = {
  id: 'search-console-owner', description: 'The requested URL-prefix property is verified as owner.', toolName,
  input: { force_refresh: true, _displayName: 'Verify property', _intent: 'Verify ownership of the requested property.' },
  checks: [{ path: '$.sites.3.siteUrl', equals: siteUrl }, { path: '$.sites.3.permissionLevel', equals: 'siteOwner' }],
};
const additional: ObjectiveAcceptanceCriterion = { id: 'public-page', description: 'Public page is reachable.',
  toolName: 'Bash', input: { command: 'curl -I https://requested.example/' }, checks: [{ path: '$text', equals: '200' }] };
function stringifyScalars(items: ObjectiveAcceptanceCriterion[]) {
  return items.map(item => ({ ...structuredClone(item),
    input: Object.fromEntries(Object.entries(item.input).map(([key, value]) => [key, value === null ? '' : String(value)])),
    checks: item.checks.map(check => ({ ...check, equals: check.equals === null ? '' : String(check.equals) })),
  }));
}
function output(index = 3, permissionLevel: unknown = 'siteOwner') {
  const sites = Array.from({ length: 6 }, (_, i) => ({ siteUrl: `https://other-${i}.example/`, permissionLevel: 'siteOwner' as unknown }));
  sites[index] = { siteUrl, permissionLevel };
  return JSON.stringify({ rowCount: sites.length, sites });
}
function fixture() {
  const saved = stringifyScalars([criterion]);
  let objective = registerObjectiveAcceptanceCriteria({ ...transitionObjectiveContract({
    messageId: root.id, text: root.content, nowMs: 10 }), risk: 'high-stakes' }, saved, 20);
  const tool = (id: string, timestamp: number, toolResult: string): Message => ({ id, toolUseId: `${id}-call`,
    role: 'tool', content: '', timestamp, toolName, toolStatus: 'completed', toolExecuted: true,
    toolInput: structuredClone(criterion.input), toolResult });
  const original = tool('original', 15, output(3, 'siteUnverifiedUser'));
  original.toolInput = { force_refresh: true, _displayName: 'Discover properties', _intent: 'Discover available properties.' };
  const registration: Message = { ...tool('register', 19, JSON.stringify({ objectiveId: objective.objectiveId, criteria: saved })),
    toolName: 'mcp__session__set_completion_criteria', toolInput: { criteria: [structuredClone(criterion)] } };
  objective = registerObjectiveAcceptanceCriteria(objective, [additional], 25);
  const additive: Message = { ...registration, id: 'additive', toolUseId: 'additive-call', timestamp: 24,
    toolInput: { criteria: [additional] }, toolResult: JSON.stringify({ objectiveId: objective.objectiveId, criteria: objective.acceptanceCriteria }) };
  const current = tool('current', 30, output(1));
  const page: Message = { ...tool('page', 31, '200'), toolName: 'Bash', toolInput: additional.input };
  const declaration: ObjectiveOutcomeDeclaration = { state: 'complete_verified', blocker: null, remainingWork: [],
    criteria: [{ id: criterion.id, satisfied: true, evidence: [current.id] }, { id: additional.id, satisfied: true, evidence: [page.id] }] };
  return { objective, original, registration, additive, current, page, declaration,
    messages: [root, original, registration, additive, current, page] };
}

describe('historically attested GSC property identity', () => {
  it('resolves the original property after reordering with exact owner permission and typed input, preserving history and review hash', () => {
    const f = fixture();
    const before = JSON.stringify(f);
    const hash = objectiveReviewBinding(f.objective).acceptanceSha256;
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(f.objective, f.messages).map(x => [x.criterionId, x.passed]))
      .toEqual([[criterion.id, true], [additional.id, true]]);
    expect(projectObjectiveAcceptanceCriteria(f.objective, f.messages).criteria).toEqual(f.objective.acceptanceCriteria!);
    expect(objectiveReviewBinding(f.objective).acceptanceSha256).toBe(hash);
    expect(JSON.stringify(f)).toBe(before);
  });

  it.each([
    ['absent', (r: any) => { r.sites[1].siteUrl = 'https://different.example/'; }],
    ['duplicate', (r: any) => { r.sites[2] = { ...r.sites[1] }; }],
    ['wrong permission', (r: any) => { r.sites[1].permissionLevel = 'siteUnverifiedUser'; }],
    ['wrong type', (r: any) => { r.sites[1].permissionLevel = true; }],
    ['permission on another site', (r: any) => { r.sites[1].permissionLevel = 'siteFullUser'; r.sites[3].permissionLevel = 'siteOwner'; }],
    ['changed URL', (r: any) => { r.sites[1].siteUrl = 'https://requested.example'; }],
    ['count mismatch', (r: any) => { r.rowCount++; }],
    ['invalid row', (r: any) => { r.sites[0] = null; }],
  ])('rejects current result: %s', (_name, mutate) => {
    const f = fixture(); const result = JSON.parse(f.current.toolResult!); mutate(result);
    f.current.toolResult = JSON.stringify(result);
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toHaveLength(1);
    expect(collectObjectiveAcceptanceObservations(f.objective, f.messages).find(x => x.criterionId === criterion.id)?.passed).not.toBe(true);
  });

  it('requires the original index, unique pre-registration observation and complete raw/ACK registration chain', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.original.toolResult = output(2); },
      (f: ReturnType<typeof fixture>) => { f.messages.splice(1, 1); },
      (f: ReturnType<typeof fixture>) => { f.original.toolUseId = undefined; },
      (f: ReturnType<typeof fixture>) => { f.original.toolExecuted = false; },
      (f: ReturnType<typeof fixture>) => { f.original.toolInput!.force_refresh = 'true'; },
      (f: ReturnType<typeof fixture>) => { f.original.timestamp = 19; },
      (f: ReturnType<typeof fixture>) => { f.messages.splice(2, 0, { ...f.original, id: 'ambiguous', toolUseId: 'ambiguous-call' }); },
      (f: ReturnType<typeof fixture>) => { f.registration.toolUseId = undefined; },
      (f: ReturnType<typeof fixture>) => { f.registration.toolResult = 'PASS'; },
      (f: ReturnType<typeof fixture>) => { f.registration.toolExecuted = undefined; },
      (f: ReturnType<typeof fixture>) => { f.messages.splice(3, 1); },
      (f: ReturnType<typeof fixture>) => { f.additive.toolResult = f.registration.toolResult; },
      (f: ReturnType<typeof fixture>) => { f.messages.splice(3, 0, { ...f.registration, id: 'duplicate' }); },
      (f: ReturnType<typeof fixture>) => { f.objective.acceptanceCriteria![0]!.description = 'Different contract'; },
      (f: ReturnType<typeof fixture>) => { (f.registration.toolInput!.criteria as ObjectiveAcceptanceCriterion[])[0]!.input.force_refresh = 'true'; },
    ]) {
      const f = fixture(); mutate(f);
      expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toHaveLength(1);
    }
  });

  it('retains execution, citation, post-registration and post-mutation gates, and never coerces current input', () => {
    for (const patch of [{ toolExecuted: false }, { toolExecuted: undefined }, { isError: true }, { toolStatus: 'error' as const },
      { toolUseId: undefined, id: 'uncited' }, { timestamp: 24 }, { toolInput: { ...criterion.input, force_refresh: 'true' } },
      { toolName: 'mcp__other__gsc_list_sites' }, { toolCheckpoint: {} as never }, { toolResult: '' }]) {
      const f = fixture(); Object.assign(f.current, patch);
      expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toHaveLength(1);
    }
    const f = fixture();
    f.messages.push({ ...f.page, id: 'write', toolUseId: 'write-call', timestamp: 32, toolName: 'Write', toolInput: { path: '/tmp/state', content: 'changed' } });
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toHaveLength(2);
  });

  it('uses a newer observed result but preserves the last exact snapshot across a transport failure', () => {
    const f = fixture();
    const later = { ...f.current, id: 'later', toolUseId: 'later-call', timestamp: 35, toolResult: output(5, 'siteUnverifiedUser') };
    const messages = [...f.messages, later];
    expect(collectObjectiveAcceptanceObservations(f.objective, messages).find(x => x.criterionId === criterion.id))
      .toMatchObject({ message: { id: 'later' }, passed: false });
    expect(validateObjectiveAcceptanceCriteria(f.objective, messages, f.declaration)).toHaveLength(1);
    later.isError = true;
    expect(collectObjectiveAcceptanceObservations(f.objective, messages).find(x => x.criterionId === criterion.id))
      .toMatchObject({ message: { id: 'current' }, passed: true });
    expect(validateObjectiveAcceptanceCriteria(f.objective, messages, f.declaration)).toEqual([]);
  });

  it('a newer duplicate identity invalidates an earlier cited valid snapshot', () => {
    const f = fixture();
    const result = JSON.parse(output(5));
    result.sites[2] = { ...result.sites[5] };
    f.messages.push({ ...f.current, id: 'newest', toolUseId: 'newest-call', timestamp: 35, toolResult: JSON.stringify(result) });
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toHaveLength(1);
    expect(collectObjectiveAcceptanceObservations(f.objective, f.messages).find(x => x.criterionId === criterion.id))
      .toMatchObject({ message: { id: 'newest' }, passed: false });
  });

  it('does not satisfy a mandatory independent review with a property observation', () => {
    const f = fixture();
    f.objective.completionCriteria.push('independent-review-passed');
    f.declaration.criteria.push(...f.objective.completionCriteria.map(id => ({ id, satisfied: true, evidence: [f.current.id] })));
    expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toEqual([]);
    expect(validateObjectiveOutcome(f.declaration, { objective: f.objective, messages: f.messages }).valid).toBe(false);
  });

  it('does not generalize arbitrary array selectors or change criteria registration semantics', () => {
    for (const transform of [
      (c: ObjectiveAcceptanceCriterion) => { c.toolName = 'mcp__other__gsc_list_sites'; },
      (c: ObjectiveAcceptanceCriterion) => { c.checks[1]!.path = '$.sites.2.permissionLevel'; },
      (c: ObjectiveAcceptanceCriterion) => { c.checks.splice(0, 1); },
      (c: ObjectiveAcceptanceCriterion) => { c.checks.push({ path: '$.rowCount', equals: 6 }); },
    ]) {
      const f = fixture();
      const raw = f.registration.toolInput!.criteria as ObjectiveAcceptanceCriterion[]; transform(raw[0]!);
      const saved = stringifyScalars(raw);
      f.objective.acceptanceCriteria = [...saved, additional];
      f.registration.toolResult = JSON.stringify({ objectiveId: f.objective.objectiveId, criteria: saved });
      f.additive.toolResult = JSON.stringify({ objectiveId: f.objective.objectiveId, criteria: f.objective.acceptanceCriteria });
      expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toHaveLength(1);
    }
    const f = fixture();
    expect(() => registerObjectiveAcceptanceCriteria({ ...f.objective, terminalState: 'active' }, [criterion], 40)).toThrow('cannot be weakened');
  });
  it('rejects ambiguous original/current JSON, duplicate invocation references, unrelated ACKs and opaque registration successes', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.current.toolResult = f.current.toolResult!.replace('"rowCount":6', '"rowCount":2,"rowCount":6'); },
      (f: ReturnType<typeof fixture>) => { f.original.toolResult = f.original.toolResult!.replace('"rowCount":6', '"rowCount":2,"rowCount":6'); },
      (f: ReturnType<typeof fixture>) => { f.messages.push({ ...f.current, id: 'duplicate-call' }); },
      (f: ReturnType<typeof fixture>) => { f.messages.push({ ...f.current, toolUseId: 'duplicate-id' }); },
      (f: ReturnType<typeof fixture>) => { f.registration.toolResult = f.registration.toolResult!.replace('"objectiveId":"root"', '"objectiveId":"wrong"'); },
      (f: ReturnType<typeof fixture>) => { f.registration.toolResult = f.registration.toolResult!.replace('"objectiveId":"root"', '"objectiveId":"wrong","objectiveId":"root"'); },
      (f: ReturnType<typeof fixture>) => { f.messages.splice(3, 0, { ...f.registration, id: 'opaque', toolUseId: 'opaque-call', toolResult: 'done' }); },
      (f: ReturnType<typeof fixture>) => { f.objective.acceptanceRegisteredAt = undefined; },
      (f: ReturnType<typeof fixture>) => { f.original.toolResult = f.original.toolResult!.replace('https://other-0.example/', siteUrl); },
    ]) {
      const f = fixture(); mutate(f);
      expect(validateObjectiveAcceptanceCriteria(f.objective, f.messages, f.declaration)).toHaveLength(1);
    }
  });

  it('exposes only the attested mapping in repair/runtime prompts while preserving the original review binding', async () => {
    const { SessionManager } = await import('./SessionManager.ts');
    const f = fixture();
    const before = JSON.stringify(f);
    const context = buildObjectiveValidationEvidenceContext(f.messages, f.objective)!;
    expect(context).toContain('legacy-gsc-site-identity');
    expect(context).toContain('"originalObservationMessageId":"original"');
    expect(context).toContain('"force_refresh":true');
    expect(context).toContain('does not establish PASS');
    expect(context).not.toContain(f.original.toolResult!);
    const prototype = SessionManager.prototype as unknown as {
      buildObjectiveRuntimePrompt(managed: { messages: Message[] }, objective: typeof f.objective): string;
    };
    const prompt = prototype.buildObjectiveRuntimePrompt({ messages: f.messages }, f.objective);
    expect(prompt).toContain('legacy-gsc-site-identity');
    expect(prompt).toContain('"force_refresh":"true"');
    expect(prompt).toContain('"force_refresh":true');
    expect(prompt).toContain(objectiveReviewBinding(f.objective).acceptanceSha256!);
    expect(JSON.stringify(f)).toBe(before);
  });

});
