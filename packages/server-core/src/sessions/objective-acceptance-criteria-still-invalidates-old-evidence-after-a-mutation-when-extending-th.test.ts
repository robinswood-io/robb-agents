import { withScopeReview } from "./__fixtures__/scope-review.ts";
import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { buildObjectiveContractPrompt, objectiveReviewBinding, findObjectiveText, transitionObjectiveContract } from "./objective-contract.ts";
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { criterion, objective, observation, receipt, root } from "./testing/objective-acceptance-criteria-fixture.ts";

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
  it('still invalidates old evidence after a mutation when extending the contract', () => {
    const added = { ...criterion, id: 'timer-visible', checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(objective, [added], 10);
    const mutation: Message = { ...observation, id: 'mutation', toolUseId: 'mutation', timestamp: 8,
      toolName: 'Edit', toolInput: { file_path: '/tmp/timer-config' } };
    const newObservation = { ...observation, id: 'm2', toolUseId: 't2', timestamp: 11,
      toolResult: '{"enabled":false,"nextRunScheduled":true,"visible":true}' };
    const claimed = { ...receipt, criteria: [...receipt.criteria,
      { id: added.id, satisfied: true, evidence: ['t2'] }] };
    expect(validateObjectiveAcceptanceCriteria(extended, [root, observation, mutation, newObservation], claimed)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
  });

  it('rejects a second live-release SHA for the same invocation atomically, including one incoming batch', () => {
    const base = transitionObjectiveContract({ messageId: 'live-root', text: 'Vérifie la release active.', nowMs: 1 });
    const first: ObjectiveAcceptanceCriterion = { id: 'first-release', description: 'The requested release is live.', toolName: 'Bash',
      input: { command: 'python3 /srv/verify.py --scope live' }, checks: [{ path: '$.sha', equals: 'f0b7a7283d70e058dee501cdf2bbcccdc4213de0' }] };
    const next = { ...first, id: 'next-release', checks: [{ path: '$.sha', equals: '140f4aad93c40fb33b38102446c9bc8466f87228' }] };
    const registered = registerObjectiveAcceptanceCriteria(base, [first], 2);
    const before = structuredClone(registered); const binding = objectiveReviewBinding(registered);
    expect(() => registerObjectiveAcceptanceCriteria(registered, [next], 3)).toThrow('Incompatible registered equality');
    expect(() => registerObjectiveAcceptanceCriteria(base, [first, next], 3)).toThrow('Incompatible registered equality');
    const independent = { ...first, id: 'other-server', input: { command: 'python3 /srv/verify_other.py --scope live' } };
    expect(() => registerObjectiveAcceptanceCriteria(registered, [independent, next], 3)).toThrow('Incompatible registered equality');
    expect(registered).toEqual(before);
    expect(objectiveReviewBinding(registered)).toEqual(binding);
    expect(base.acceptanceCriteria).toBeUndefined();
    // An explicit new objective has its own target/version contract; it does
    // not remove or supersede a criterion in the old objective.
    const newObjective = transitionObjectiveContract({ existing: registered, messageId: 'new-root', text: 'Nouvel objectif : vérifie la nouvelle release.' });
    expect(registerObjectiveAcceptanceCriteria(newObjective, [next], 4).acceptanceCriteria).toEqual([next]);
    expect(registered).toEqual(before);
  });

  it('compares native aliases, reordered inputs and equivalent selectors, with strict scalar types', () => {
    const first = { ...criterion, toolName: 'functions.bash', input: { command: 'cat /srv/check.json', 'target.ids.0': 17 }, checks: [{ path: '$.items[0].ready', equals: true }] };
    const registered = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content }), [first], 2);
    for (const equals of [false, 'true', 1, null]) {
      expect(() => registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'conflicting', toolName: 'Bash',
        input: { '$.target.ids[0]': 17, '$.command': 'cat /srv/check.json' }, checks: [{ path: 'items.0.ready', equals }] }], 3)).toThrow('Incompatible registered equality');
    }
    const distinctConstraints: Array<Partial<ObjectiveAcceptanceCriterion>> = [
      { toolName: 'mcp__other__bash' }, { input: { command: 'cat /srv/other.json', 'target.ids.0': 17 } },
      { input: { command: 'cat /srv/check.json', 'target.ids.0': '17' } },
      { input: { command: 'cat /srv/check.json' } }, // exact input identity, not inferred overlap
      { checks: [{ path: '$.items[1].ready', equals: false }] },
    ];
    for (const distinct of distinctConstraints) expect(registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'independent', checks: [{ path: 'items.0.ready', equals: false }], ...distinct }], 3).acceptanceCriteria).toHaveLength(2);
    expect(registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'same-expected-state' }], 3).acceptanceCriteria).toHaveLength(2);
  });

  it('uses the existing whole-text equality semantics, without trimming significant content', () => {
    const first = { ...criterion, checks: [{ path: '$text', equals: 'READY\r\n' }] };
    const registered = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content }), [first], 2);
    for (const equals of ['READY', 'READY\n', 'READY\r\n']) {
      expect(registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'same-text', checks: [{ path: '$text', equals }] }], 3).acceptanceCriteria).toHaveLength(2);
    }
    for (const equals of [' READY', 'READY ', 'READY\n\n', 'NOT READY']) {
      expect(() => registerObjectiveAcceptanceCriteria(registered, [{ ...first, id: 'conflicting-text', checks: [{ path: '$text', equals }] }], 3)).toThrow('Incompatible registered equality');
    }
  });

  it('preserves an already persisted contradiction on identical re-registration without extending it', () => {
    const legacy = { ...objective, acceptanceCriteria: [criterion, { ...criterion, id: 'old-conflict', checks: [{ path: 'enabled', equals: false }] }] };
    const before = structuredClone(legacy); const binding = objectiveReviewBinding(legacy);
    expect(registerObjectiveAcceptanceCriteria(legacy, structuredClone(legacy.acceptanceCriteria), 99)).toEqual(legacy);
    expect(registerObjectiveAcceptanceCriteria(legacy, [{ ...criterion, id: 'different-target', input: { host: 'other', timer: 'cleanup' } }], 100).acceptanceCriteria).toHaveLength(3);
    expect(() => registerObjectiveAcceptanceCriteria(legacy, [{ ...criterion, id: 'third-conflict' }], 100)).toThrow('Incompatible registered equality');
    expect(legacy).toEqual(before);
    expect(objectiveReviewBinding(legacy)).toEqual(binding);
  });

  it('retains the original request across continuation, reload and missing transcript context', () => {
    const continued = transitionObjectiveContract({ existing: JSON.parse(JSON.stringify(objective)) as typeof objective, messageId: 'u2', text: 'Poursuit' });
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

  it('matches native file parameter aliases (path vs file_path) and canonical tool aliases (functions.read vs tool:Read)', () => {
    const readCriterion: ObjectiveAcceptanceCriterion = {
      id: 'worker-artifact-read',
      description: 'Read confirms the worker artifact JSON content',
      toolName: 'functions.read',
      input: { path: '/tmp/mission-2/worker-artifact.json' },
      checks: [
        { path: '$.worker', equals: 'ok' },
        { path: '$.sum', equals: 60 },
      ],
    };
    const readObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: 'Inspecte /tmp/mission-2/worker-artifact.json.', nowMs: 1 }),
      [readCriterion],
      2,
    );
    const readMessage: Message = {
      id: 'read-msg-1',
      toolUseId: 'call-read-1',
      role: 'tool',
      content: '',
      toolName: 'Read',
      toolStatus: 'completed',
      toolExecuted: true,
      timestamp: 3,
      toolInput: { file_path: '/tmp/mission-2/worker-artifact.json' },
      toolResult: '{"worker":"ok","items":[10,20,30],"sum":60}\n',
    };
    const claim: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified',
      blocker: null,
      remainingWork: [],
      criteria: [
        { id: 'worker-artifact-read', satisfied: true, evidence: ['tool:Read'] },
        ...readObjective.completionCriteria.map(id => ({
          id,
          satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? 'tool:Read' : 'assistant-final'],
        })),
      ],
    };
    expect(validateObjectiveAcceptanceCriteria(readObjective, [root, readMessage], claim)).toEqual([]);
    expect(validateObjectiveOutcome(claim, { objective: readObjective, messages: withScopeReview(readObjective, [root, readMessage]) }).valid).toBe(true);
  });
});
