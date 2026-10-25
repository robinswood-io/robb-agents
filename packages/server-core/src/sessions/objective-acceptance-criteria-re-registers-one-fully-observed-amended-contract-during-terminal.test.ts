import { withScopeReview } from "./__fixtures__/scope-review.ts";
import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { bindBusinessProcedure, businessProcedurePrompt } from "./business-procedures.ts";
import { objectiveReviewBinding, transitionObjectiveContract } from "./objective-contract.ts";
import { collectObjectiveAcceptanceObservations, registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { criterion, objective, observation, receipt, root } from "./testing/objective-acceptance-criteria-fixture.ts";

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
  it('re-registers one fully observed amended contract during terminal reconciliation', () => {
    const amendment: Message = {
      id: 'target-production',
      role: 'user',
      content: 'La cible est désormais production.',
      timestamp: 3,
    };
    const amended = transitionObjectiveContract({
      existing: objective,
      messageId: amendment.id,
      text: amendment.content,
      nowMs: amendment.timestamp,
    });
    expect(amended.acceptanceNeedsReview).toBe(true);
    expect(amended.acceptanceRevision).toBe(amendment.id);

    const productionCriterion: ObjectiveAcceptanceCriterion = {
      ...criterion,
      description: 'The authorized timer is active on the production host',
      input: { host: 'production', timer: 'cleanup' },
    };
    const productionObservation: Message = {
      ...observation,
      id: 'production-observation',
      toolUseId: 'production-observation',
      timestamp: 4,
      toolInput: structuredClone(productionCriterion.input),
    };
    const closure: Message = {
      id: 'terminal-amended-registration',
      role: 'user',
      content: 'Reprends cette mission uniquement pour réconcilier son état terminal avec l’effet déjà accompli. Tu ne dois créer aucun nouvel effet externe. Réutilise les reçus persistés et garde toute observation en lecture seule. Termine réellement comme complete_verified.',
      timestamp: 5,
    };
    const terminal = transitionObjectiveContract({
      existing: amended,
      messageId: closure.id,
      text: closure.content,
      nowMs: closure.timestamp,
    });
    expect(terminal.terminalReconciliation).toEqual({
      messageId: closure.id,
      timestamp: closure.timestamp,
      initialAcceptanceRegistrationRequired: true,
    });
    const oldBinding = objectiveReviewBinding(objective);
    const registered = registerObjectiveAcceptanceCriteria(
      terminal,
      [productionCriterion],
      6,
      undefined,
      [root, amendment, productionObservation, closure],
    );
    expect(registered.acceptanceNeedsReview).toBe(false);
    expect(registered.acceptanceCriteria).toEqual([productionCriterion]);
    expect(registered.acceptanceRegisteredRevision).toBe(amendment.id);
    expect(registered.acceptanceHistory?.at(-1)?.criteria).toEqual([criterion]);
    expect(objectiveReviewBinding(registered)).not.toEqual(oldBinding);

    expect(() => registerObjectiveAcceptanceCriteria(
      terminal,
      [productionCriterion],
      6,
      undefined,
      [root, amendment, closure],
    )).toThrow('already satisfied by exact persisted read-only observations');
  });

  it('keeps business procedure binding immutable during terminal reconciliation', () => {
    const bound = bindBusinessProcedure(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      'software-change',
    );
    const reconciled = {
      ...bound,
      terminalReconciliation: { messageId: 'receipt-only-close', timestamp: 2 },
    };
    expect(bindBusinessProcedure(reconciled, 'software-change')).toBe(reconciled);

    const unbound = {
      ...reconciled,
      procedure: undefined,
      requiresAcceptanceCriteria: undefined,
    };
    expect(() => bindBusinessProcedure(unbound, 'software-change'))
      .toThrow('Terminal reconciliation freezes the active business procedure');
    expect(() => bindBusinessProcedure(reconciled, 'software-deployment'))
      .toThrow('Terminal reconciliation freezes the active business procedure');
  });

  it('returns actionable procedure and reserved-id diagnostics before registration', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...criterion, requirementId: 'requested-behavior',
    }], 2)).toThrow('requirementId "requested-behavior" requires a selected business procedure; select procedure or omit requirementId');
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...criterion, requirementId: 'arbitrary-pass',
    }], 2, 'software-change')).toThrow('Unknown requirementId "arbitrary-pass" for business procedure "software-change". Allowed requirementId values: requested-behavior, regression-checks, user-journey');

    for (const reservedId of base.completionCriteria) {
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        ...criterion, id: reservedId,
      }], 2)).toThrow(`Criterion id "${reservedId}" is reserved by the host completion contract; choose a different criterion id`);
    }
    expect(base.acceptanceCriteria).toBeUndefined();
  });

  it('makes each procedure\'s allowed requirementId values explicit in the contract prompt', () => {
    const expected = 'Allowed requirementId values for software-change: requested-behavior, regression-checks, user-journey';
    expect(businessProcedurePrompt()).toContain(expected);
    expect(businessProcedurePrompt({ id: 'software-change', version: 1 })).toContain(expected);
  });

  it('rejects unrepairable native and namespaced shell criteria atomically before freezing their identity', () => {
    const inadmissible: Array<{ toolName: string; input: ObjectiveAcceptanceCriterion['input'] }> = [
      { toolName: 'Bash', input: { command: `python3 -c "print({'exists': True})"` } },
      { toolName: 'bash', input: { '$.command': "python3 -c 'import json; print(json.dumps({\"exists\": True))'" } },
      { toolName: 'functions.bash', input: { cmd: 'node -e "console.log(JSON.stringify({ok:true}))"' } },
      { toolName: 'Bash', input: { script: 'printf \'{"ok":true}\\n\'' } },
      { toolName: 'mcp__ops__ssh_execute', input: { server: 'staging', cwd: '/srv/release',
        command: 'python3 -c "print(1)"' } },
      { toolName: 'mcp__ops__exec_command', input: { host: 'staging', command: 'printf PASS' } },
      { toolName: 'mcp__ops__shell', input: { host: 'staging',
        command: 'python3 /srv/validate_release.py --write' } },
      { toolName: 'mcp__ops__bash', input: { host: 'staging',
        command: 'curl -X POST https://example.com/health' } },
      { toolName: 'mcp__ops__ssh_execute', input: { server: 'staging', cwd: '/srv/release',
        command: 'rm -f /srv/release/result.json' } },
    ];
    for (const [index, candidate] of inadmissible.entries()) {
      const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        id: `invalid-inline-${index}`, description: 'Inline output claims the report is valid.',
        ...candidate, checks: [{ path: '$.exists', equals: true }],
      }], 2)).toThrow('cannot serve as host-observed acceptance evidence');
      expect(base.acceptanceCriteria).toBeUndefined();
    }

    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const safe: ObjectiveAcceptanceCriterion = {
      id: 'safe-state', description: 'The state file is valid JSON.', toolName: 'Bash',
      input: { command: 'cat /tmp/state.json' }, checks: [{ path: '$.ok', equals: true }],
    };
    expect(() => registerObjectiveAcceptanceCriteria(base, [safe, {
      id: 'invalid-inline', description: 'Inline output claims the report is valid.',
      toolName: 'mcp__ops__exec_command', input: { host: 'staging', command: 'python3 -c "print(1)"' },
      checks: [{ path: '$text', equals: '1' }],
    }], 2)).toThrow('Nothing was registered');
    expect(base.acceptanceCriteria).toBeUndefined();

    // Reloaded legacy contracts remain immutable and idempotent, but the same
    // shared grammar keeps their inline output from certifying relevant checks.
    const legacyCriterion: ObjectiveAcceptanceCriterion = {
      id: 'legacy-inline', description: 'Legacy inline output claims success.', toolName: 'Bash',
      input: { command: 'python3 -c "print(1)"' }, checks: [{ path: '$text', equals: '1' }],
    };
    const legacy = { ...base, acceptanceCriteria: [legacyCriterion], acceptanceRegisteredAt: 2,
      acceptanceRegisteredAtById: { [legacyCriterion.id]: 2 } };
    expect(registerObjectiveAcceptanceCriteria(legacy, [structuredClone(legacyCriterion)], 99)).toEqual(legacy);
    const legacyResult: Message = { ...observation, id: 'legacy-inline-result', toolUseId: 'legacy-inline-result',
      toolName: 'Bash', toolInput: legacyCriterion.input, toolResult: '1', timestamp: 3 };
    const legacyReceipt: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [], criteria: [
        { id: legacyCriterion.id, satisfied: true, evidence: [legacyResult.toolUseId!] },
        ...legacy.completionCriteria.map(id => ({ id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? legacyResult.toolUseId! : 'assistant-final'] })),
      ],
    };
    expect(validateObjectiveAcceptanceCriteria(legacy, [root, legacyResult], legacyReceipt)).toEqual([]);
    expect(validateObjectiveOutcome(legacyReceipt, { objective: legacy, messages: [root, legacyResult] }).gaps)
      .toContain('criterion lacks observed evidence: relevant-checks-passed');
  });

  it('never promotes an unregistered opaque MCP shell result to relevant-checks evidence', () => {
    const unregistered = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    for (const [index, candidate] of [
      { toolName: 'mcp__ops__ssh_execute', toolInput: { server: 'staging', cwd: '/srv/release',
        command: 'python3 /srv/validate_release.py' } },
      { toolName: 'mcp__ops__exec_command', toolInput: { host: 'staging',
        command: 'curl --fail --silent https://example.com/health' } },
    ].entries()) {
      const result: Message = {
        ...observation, id: `unregistered-shell-${index}`, toolUseId: `unregistered-shell-${index}`,
        ...candidate, toolResult: '{"ok":true}', timestamp: 3 + index,
      };
      const claimed: ObjectiveOutcomeDeclaration = {
        state: 'complete_verified', blocker: null, remainingWork: [],
        criteria: unregistered.completionCriteria.map(id => ({ id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? result.toolUseId! : 'assistant-final'] })),
      };
      expect(validateObjectiveOutcome(claimed, { objective: unregistered, messages: [root, result] }).gaps)
        .toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });

  it('keeps a named validator repairable under the same immutable command after a syntax failure', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const command = 'python3 /tmp/verify_report.py';
    const reportCriterion: ObjectiveAcceptanceCriterion = {
      id: 'report-valid', description: 'The generated report passes its validator.', toolName: 'Bash',
      input: { command }, checks: [{ path: '$.exists', equals: true }, { path: '$.hasPeriods', equals: true }],
    };
    const registered = registerObjectiveAcceptanceCriteria(base, [reportCriterion], 2);
    const failed: Message = {
      ...observation, id: 'validator-syntax-error', toolUseId: 'validator-syntax-error', timestamp: 3,
      toolName: 'Bash', toolInput: { command }, toolStatus: 'error', isError: true,
      toolResult: 'SyntaxError: closing parenthesis does not match opening parenthesis',
    };
    const repair: Message = {
      ...observation, id: 'repair-validator', toolUseId: 'repair-validator', timestamp: 4,
      toolName: 'Edit', toolInput: { file_path: '/tmp/verify_report.py' }, toolResult: 'Updated validator',
    };
    const verified: Message = {
      ...observation, id: 'validator-verified', toolUseId: 'validator-verified', timestamp: 5,
      toolName: 'Bash', toolInput: { command }, toolResult: '{"exists":true,"hasPeriods":true}',
    };
    const claimed: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        { id: reportCriterion.id, satisfied: true, evidence: [verified.toolUseId!] },
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? verified.toolUseId! : 'assistant-final'],
        })),
      ],
    };
    expect(registered.acceptanceCriteria).toEqual([reportCriterion]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, failed, repair, verified]))
      .toMatchObject([{ criterionId: reportCriterion.id, passed: true,
        message: { toolUseId: verified.toolUseId } }]);
    expect(validateObjectiveOutcome(claimed, { objective: registered, messages: withScopeReview(registered, [root, failed, repair, verified]) }))
      .toMatchObject({ state: 'complete_verified', valid: true, gaps: [] });
  });

  it('rejects a new JSON selector when the exact prior observation is demonstrably text-only', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const pythonCriterion: ObjectiveAcceptanceCriterion = {
      id: 'report-shape', description: 'The report has every required section.',
      toolName: 'Bash', input: { command: 'python3 /tmp/verify_report.py' },
      checks: [{ path: '$.exists', equals: true }],
    };
    const pythonObservation: Message = { ...observation, toolName: 'Bash',
      toolInput: pythonCriterion.input, toolResult: "{'exists': True, 'hasPeriods': True}" };
    expect(() => registerObjectiveAcceptanceCriteria(
      base, [pythonCriterion], 2, undefined, [root, pythonObservation],
    )).toThrow('returned text without a supported structured projection for every requested selector');
    expect(base.acceptanceCriteria).toBeUndefined();

    const exactText = { ...pythonCriterion,
      checks: [{ path: '$text', equals: pythonObservation.toolResult! }] };
    expect(registerObjectiveAcceptanceCriteria(base, [exactText], 2, undefined,
      [root, pythonObservation]).acceptanceCriteria).toEqual([exactText]);
    // A named validator can be repaired in place without changing the frozen
    // command identity. Registration before its first observation stays valid.
    expect(registerObjectiveAcceptanceCriteria(base, [pythonCriterion], 2).acceptanceCriteria)
      .toEqual([pythonCriterion]);
  });

  it('does not bind opaque validator stdout unless the command has a bounded success marker', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const opaque: ObjectiveAcceptanceCriterion = {
      id: 'opaque-output', description: 'The validator reports PASS.', toolName: 'Bash',
      input: { command: 'python3 /tmp/verify_report.py' }, checks: [],
    };
    for (const path of ['$.stdout', 'stdout', '$.stderr', 'stderr']) {
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        ...opaque, checks: [{ path, equals: 'PASS' }],
      }], 2)).toThrow('shell output is not a structured result field');
    }
    expect(registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'opaque-exit', checks: [{ path: '$.transport.code', equals: 0 }],
    }], 2).acceptanceCriteria?.[0]?.id).toBe('opaque-exit');
    for (const checks of [
      [{ path: '$.transport.nonsense', equals: true }],
      [{ path: '$.transport.code', equals: 1 }],
      [{ path: '$.transport.success', equals: false }],
    ]) {
      expect(() => registerObjectiveAcceptanceCriteria(base, [{
        ...opaque, id: `invalid-transport-${String(checks[0]!.path).split('.').at(-1)}`,
        checks,
      }], 2)).toThrow('unsupported shell transport predicate');
    }
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'curl-without-fail-success', input: { command: 'curl --silent https://example.com/health' },
      checks: [{ path: '$.transport.success', equals: true }],
    }], 2)).toThrow('unsupported shell transport predicate');
    expect(registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'curl-with-fail-success', input: { command: 'curl --fail --silent https://example.com/health' },
      checks: [{ path: '$.transport.success', equals: true }],
    }], 2).acceptanceCriteria?.[0]?.id).toBe('curl-with-fail-success');
    expect(() => registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'bounded-output', input: { command: 'python3 /tmp/verify_report.py && printf PASS' },
      checks: [{ path: 'stdout', equals: 'PASS' }],
    }], 2)).toThrow('Use $text');
    expect(registerObjectiveAcceptanceCriteria(base, [{
      ...opaque, id: 'bounded-text', input: { command: 'python3 /tmp/verify_report.py && printf PASS' },
      checks: [{ path: '$text', equals: 'PASS' }],
    }], 2).acceptanceCriteria?.[0]?.id).toBe('bounded-text');
  });

  it('extends checks without replaying unchanged evidence and persists individual registration boundaries', () => {
    const added: ObjectiveAcceptanceCriterion = { ...criterion, id: 'timer-visible', toolName: 'mcp__ops__get_visibility',
      checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(objective, [added], 10);
    expect(extended.acceptanceRegisteredAt).toBe(10);
    expect(extended.acceptanceRegisteredAtById).toEqual({ 'timer-active': 2, 'timer-visible': 10 });
    const loaded = JSON.parse(JSON.stringify(extended));
    const newObservation = { ...observation, id: 'm2', toolUseId: 't2', timestamp: 11, toolName: added.toolName,
      toolResult: '{"enabled":true,"nextRunScheduled":true,"visible":true}' };
    const extendedReceipt = { ...receipt, criteria: [...receipt.criteria,
      { id: added.id, satisfied: true, evidence: ['t2'] }] };
    expect(validateObjectiveAcceptanceCriteria(loaded, [root, observation, newObservation], extendedReceipt)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(loaded, [root, observation, newObservation])).toHaveLength(2);
    expect(objectiveReviewBinding(loaded)).not.toEqual(objectiveReviewBinding(objective));
    const repeated = registerObjectiveAcceptanceCriteria(loaded, [added, criterion], 20);
    expect(repeated).toBe(loaded);
    expect(validateObjectiveAcceptanceCriteria(repeated, [root, observation, newObservation], extendedReceipt)).toEqual([]);
  });

  it('reuses an exact objective-scoped observation when the criterion is registered later', () => {
    const added = { ...criterion, id: 'timer-visible', checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(objective, [added], 10);
    const earlier = { ...observation, toolResult: '{"enabled":true,"nextRunScheduled":true,"visible":true}' };
    const claimed = { ...receipt, criteria: [...receipt.criteria,
      { id: added.id, satisfied: true, evidence: ['t1'] }] };
    expect(validateObjectiveAcceptanceCriteria(extended, [root, earlier], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(extended, [root, earlier]).map(item => item.criterionId))
      .toEqual(['timer-active', 'timer-visible']);
  });

  it('keeps a successful business observation across later transport failures, but not a newer negative result', () => {
    const negative = { ...observation, id: 'latest', toolUseId: 'latest', timestamp: 9,
      toolResult: '{"enabled":false,"nextRunScheduled":true}' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, negative], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
    for (const changes of [
      { isError: true, toolStatus: 'error' as const, toolResult: 'Unavailable' },
      { toolExecuted: false, toolResult: 'Not executed' },
    ]) {
      const latest = { ...observation, id: 'latest', toolUseId: 'latest', timestamp: 9, ...changes };
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, latest], receipt)).toEqual([]);
      expect(collectObjectiveAcceptanceObservations(objective, [root, observation, latest]).map(item => item.message.id))
        .toEqual(['m1']);
    }
    const empty = { ...observation, id: 'empty', toolUseId: 'empty', timestamp: 9, toolResult: '' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, empty], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
    const otherTarget = { ...observation, id: 'other', toolUseId: 'other', timestamp: 9,
      toolInput: { host: 'other', timer: 'cleanup' }, toolResult: '{"enabled":false}' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, otherTarget], receipt)).toEqual([]);
  });

  it('retains registration timestamps as provenance without turning them into duplicate-check boundaries', () => {
    const legacy = { ...objective, acceptanceRegisteredAtById: undefined };
    const added = { ...criterion, id: 'timer-visible', checks: [{ path: 'visible', equals: true }] };
    const extended = registerObjectiveAcceptanceCriteria(legacy, [added], 10);
    expect(extended.acceptanceRegisteredAtById).toEqual({ 'timer-active': 2, 'timer-visible': 10 });
    for (const at of [0, 11, Number.NaN, '2']) {
      const malformed = { ...extended, acceptanceRegisteredAtById: { 'timer-active': at } } as typeof extended;
      expect(validateObjectiveAcceptanceCriteria(malformed, [root, observation], receipt)).not.toContain(
        'Business criterion lacks matching post-action evidence: timer-active');
    }
    // Re-registering preserves old metadata, while exact objective-scoped proof
    // remains reusable.
    const lateLegacy = { ...legacy, acceptanceRegisteredAt: 8 };
    expect(registerObjectiveAcceptanceCriteria(lateLegacy, [criterion], 20)).toBe(lateLegacy);
    expect(validateObjectiveAcceptanceCriteria(lateLegacy, [root, observation], receipt)).toEqual([]);
  });

  it('invalidates evidence per explicit target instead of after every unrelated mutation', () => {
    const isolatedCriterion = { ...criterion, input: { workspaceId: 'workspace-a', timer: 'cleanup' } };
    const isolatedObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [isolatedCriterion], 2,
    );
    const isolatedObservation = { ...observation, toolInput: isolatedCriterion.input };
    const unrelatedMutation: Message = { ...observation, id: 'other-mutation', toolUseId: 'other-mutation',
      timestamp: 5, toolName: 'mcp__ops__update_timer',
      toolInput: { workspaceId: 'workspace-b', timer: 'cleanup', enabled: false }, toolResult: '{"updated":true}' };
    expect(validateObjectiveAcceptanceCriteria(isolatedObjective, [root, isolatedObservation, unrelatedMutation], receipt)).toEqual([]);
    expect(validateObjectiveOutcome(receipt, { objective: isolatedObjective,
      messages: withScopeReview(isolatedObjective, [root, isolatedObservation, unrelatedMutation]) }).valid).toBe(true);

    const relevantMutation = { ...unrelatedMutation, id: 'same-mutation', toolUseId: 'same-mutation',
      toolInput: { workspaceId: 'workspace-a', timer: 'cleanup', enabled: false } };
    expect(validateObjectiveAcceptanceCriteria(isolatedObjective, [root, isolatedObservation, relevantMutation], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);
    expect(validateObjectiveOutcome(receipt, { objective: isolatedObjective,
      messages: withScopeReview(isolatedObjective, [root, isolatedObservation, relevantMutation]) }).valid).toBe(false);
    expect(validateObjectiveAcceptanceCriteria(isolatedObjective, [root, isolatedObservation, relevantMutation, {
      ...isolatedObservation, id: 'after-mutation', toolUseId: 'after-mutation', timestamp: 6,
    }], { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, evidence: ['after-mutation'] } : item) })).toEqual([]);

    const multiIdentityCriterion = { ...criterion,
      input: { workspaceId: 'workspace-a', sessionId: 'session-shared', timer: 'cleanup' } };
    const multiIdentityObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [multiIdentityCriterion], 2,
    );
    const multiIdentityObservation = { ...observation, toolInput: multiIdentityCriterion.input };
    const inconsistentButSameSession = { ...relevantMutation, id: 'same-session-mutation',
      toolUseId: 'same-session-mutation',
      toolInput: { workspaceId: 'workspace-b', sessionId: 'session-shared', timer: 'cleanup', enabled: false } };
    expect(validateObjectiveAcceptanceCriteria(multiIdentityObjective,
      [root, multiIdentityObservation, inconsistentButSameSession], receipt)).toEqual([
      'Business criterion lacks matching post-action evidence: timer-active',
    ]);

    const pathObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'path-root', text: 'Vérifie le fichier.', nowMs: 1 }),
      [{ ...criterion, input: { file_path: '/tmp/state' } }], 2,
    );
    const pathRoot = { ...root, id: 'path-root' };
    const pathObservation = { ...observation, toolInput: { file_path: '/tmp/state' } };
    const aliasedPathMutation = { ...relevantMutation, toolName: 'Edit',
      toolInput: { file_path: '/tmp/dir/../state', new_string: 'changed' } };
    expect(validateObjectiveAcceptanceCriteria(pathObjective, [pathRoot, pathObservation, aliasedPathMutation], receipt))
      .toHaveLength(1);
  });
});
