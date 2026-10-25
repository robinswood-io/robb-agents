import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { objectiveReviewBinding, transitionObjectiveContract } from "./objective-contract.ts";
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { criterion, objective, observation, receipt, root } from "./testing/objective-acceptance-criteria-fixture.ts";

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
  it('reads only own data properties and supports explicit scalar JSON roots', () => {
    const input = Object.create({ host: 'dev' }) as Record<string, unknown>;
    input.timer = 'cleanup';
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, toolInput: input }], receipt)).toHaveLength(1);
    Object.defineProperty(input, 'host', { get() { throw new Error('must not invoke accessors'); } });
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, toolInput: input }], receipt)).toHaveLength(1);
    const scalarObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, checks: [{ path: '$', equals: true }] }], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(scalarObjective, [root, { ...observation, toolResult: 'true' }], receipt)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(scalarObjective, [root, { ...observation, toolResult: 'false' }], receipt)).toHaveLength(1);
  });

  it('preserves verified observations after internal result delivery without treating the delivery as business evidence', () => {
    for (const toolName of ['send_agent_message', 'session__send_agent_message', 'mcp__session__send_agent_message']) {
      const delivery: Message = { ...observation, id: 'delivery', toolUseId: 'delivery', timestamp: 5,
        toolName, toolInput: { targetSessionId: 'parent', message: 'Verification complete' }, toolResult: '{"status":"delivered"}' };
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, delivery], receipt)).toEqual([]);
      const deliveryObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, toolName, input: { targetSessionId: 'parent' }, checks: [{ path: 'status', equals: 'delivered' }] }], 2,
      );
      expect(validateObjectiveAcceptanceCriteria(deliveryObjective, [root, delivery], {
        ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['delivery'] }],
      })).toHaveLength(1);
      const textDeliveryObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, toolName, input: { targetSessionId: 'parent' }, checks: [{ path: '$text', equals: 'OK' }] }], 2,
      );
      expect(validateObjectiveAcceptanceCriteria(textDeliveryObjective, [root, { ...delivery, toolResult: 'OK' }], {
        ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['delivery'] }],
      })).toHaveLength(1);
    }
    for (const toolName of ['mcp__gmail__send_message', 'mcp__other__send_agent_message']) {
      const mutation = { ...observation, id: 'sent', toolUseId: 'sent', timestamp: 5, toolName };
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, mutation], receipt)).toHaveLength(1);
    }
  });

  it('resolves a tool-name alias only to the latest exact current criterion observation', () => {
    const aliasReceipt = { ...receipt, criteria: [
      { id: criterion.id, satisfied: true, evidence: [`tool:${criterion.toolName}`] },
    ] };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], aliasReceipt)).toEqual([]);

    const wrongTarget = { ...observation, toolInput: { host: 'production', timer: 'cleanup' } };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, wrongTarget], aliasReceipt)).toHaveLength(1);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, timestamp: 0 }], aliasReceipt)).toHaveLength(1);

    const mutation: Message = { ...observation, id: 'mutation', toolUseId: 'mutation', timestamp: 5,
      toolName: 'Edit', toolInput: { file_path: '/tmp/timer' }, toolResult: 'updated' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, mutation], aliasReceipt)).toHaveLength(1);

    const failed = { ...observation, toolStatus: 'error' as const, isError: true, toolResult: 'request failed' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, failed], aliasReceipt)).toHaveLength(1);

    const second = { ...observation, id: 'm2', toolUseId: 't2', timestamp: 5 };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, second], aliasReceipt)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, second], {
      ...aliasReceipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['t2'] }],
    })).toEqual([]);

    for (const ref of ['assistant-final', 'tool:mcp__other__get_timer', `tool:${criterion.toolName.toUpperCase()}`]) {
      expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], {
        ...aliasReceipt, criteria: [{ id: criterion.id, satisfied: true, evidence: [ref] }],
      })).toHaveLength(1);
    }
  });

  it('freezes expectations and registration time; only additive changes are allowed', () => {
    expect(registerObjectiveAcceptanceCriteria(objective, [criterion], 99)).toEqual(objective);
    expect(() => registerObjectiveAcceptanceCriteria(objective, [{ ...criterion, checks: [{ path: 'enabled', equals: false }] }])).toThrow('cannot be weakened');
    expect(() => registerObjectiveAcceptanceCriteria(objective, [{ ...criterion, input: { 'constructor.prototype': true } }])).toThrow();
    expect(() => registerObjectiveAcceptanceCriteria(objective, [criterion, criterion])).toThrow();
  });

  it('supersedes only an explicitly versioned criterion with a current negative observation', () => {
    const negative = {
      ...observation,
      id: 'negative-observation',
      toolUseId: 'negative-observation',
      toolResult: '{"enabled":false,"nextRunScheduled":true}',
    };
    const corrected: ObjectiveAcceptanceCriterion = {
      ...criterion,
      id: 'timer-active_v2',
      supersedes: 'timer-active',
    };
    const revised = registerObjectiveAcceptanceCriteria(
      objective,
      [corrected],
      10,
      undefined,
      [root, negative],
    );
    expect(revised.acceptanceCriteria).toEqual([corrected]);
    expect(revised.acceptanceRegisteredAtById).toEqual({ 'timer-active_v2': 10 });
    expect(revised.acceptanceHistory?.at(-1)).toMatchObject({
      revision: 'criterion-correction:timer-active',
      criteria: [criterion],
      registeredAt: 2,
    });
    expect(objectiveReviewBinding(revised)).not.toEqual(objectiveReviewBinding(objective));

    const nextVersion: ObjectiveAcceptanceCriterion = {
      ...corrected,
      id: 'timer-active_v3',
      supersedes: 'timer-active_v2',
    };
    expect(() => registerObjectiveAcceptanceCriteria(
      revised,
      [nextVersion],
      11,
      undefined,
      [root, negative],
    )).toThrow('must be re-observed after that exact version was registered');
    const freshNegative = {
      ...negative,
      id: 'negative-observation-v2',
      toolUseId: 'negative-observation-v2',
      timestamp: 12,
    };
    expect(registerObjectiveAcceptanceCriteria(
      revised,
      [nextVersion],
      13,
      undefined,
      [root, negative, freshNegative],
    ).acceptanceCriteria).toEqual([nextVersion]);

    for (const [candidate, transcript, error] of [
      [{ ...corrected, id: 'timer-active_v3' }, [root, negative], 'next explicit version ID'],
      [corrected, [root, observation], 'negative result'],
      [corrected, [root], 'negative result'],
      [{ ...corrected, requirementId: 'changed-requirement' }, [root, negative], 'preserve requirementId'],
      [{ ...corrected, checks: [{ path: 'enabled', equals: false }] }, [root, negative], 'preserve the exact'],
      [{ ...corrected, checks: [...criterion.checks, { path: 'scheduled', equals: true }] }, [root, negative], 'preserve the exact'],
      [{ ...corrected, input: { host: 'prod', timer: 'cleanup' } }, [root, negative], 'preserve the exact'],
      [{ ...corrected, toolName: 'mcp__other__get_timer' }, [root, negative], 'preserve the exact'],
    ] as const) {
      expect(() => registerObjectiveAcceptanceCriteria(
        objective,
        [candidate as ObjectiveAcceptanceCriterion],
        10,
        undefined,
        [...transcript],
      )).toThrow(error);
    }

    const merelyAdded = registerObjectiveAcceptanceCriteria(
      objective,
      [{ ...corrected, supersedes: undefined }],
      10,
    );
    expect(merelyAdded.acceptanceCriteria?.map(item => item.id)).toEqual([
      'timer-active',
      'timer-active_v2',
    ]);

    const shaHash = 'a'.repeat(64);
    const shellCriterion: ObjectiveAcceptanceCriterion = {
      id: 'proxy-artifact-sha256',
      description: 'Verify SHA-256 of generated artifact',
      toolName: 'Bash',
      input: { command: 'shasum -a 256 dist/app.js' },
      checks: [{ path: '$.proxySha256', equals: shaHash }],
    };
    const shellObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [shellCriterion],
      2,
    );
    const plainTextObservation: Message = {
      id: 'sha-obs', toolUseId: 'sha-obs', role: 'tool', content: '', toolName: 'Bash',
      toolStatus: 'completed', toolExecuted: true, timestamp: 5,
      toolInput: { command: 'shasum -a 256 dist/app.js' },
      toolResult: `${shaHash}  dist/app.js\n`,
    };
    const repairedToText = registerObjectiveAcceptanceCriteria(
      shellObjective,
      [{
        ...shellCriterion,
        id: 'proxy-artifact-sha256_v2',
        supersedes: 'proxy-artifact-sha256',
        checks: [{ path: '$text', equals: `${shaHash}  dist/app.js` }],
      }],
      10,
      undefined,
      [root, plainTextObservation],
    );
    expect(repairedToText.acceptanceCriteria?.[0]?.id).toBe('proxy-artifact-sha256_v2');
    expect(repairedToText.acceptanceCriteria?.[0]?.checks).toEqual([{ path: '$text', equals: `${shaHash}  dist/app.js` }]);
  });

  it('allows only a complete identical criteria replay during terminal reconciliation', () => {
    const additional: ObjectiveAcceptanceCriterion = {
      ...criterion,
      id: 'timer-visible',
      description: 'The authorized timer remains visible on the requested host',
      checks: [{ path: 'visible', equals: true }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [criterion, additional],
      2,
    );
    const terminal = {
      ...registered,
      terminalReconciliation: { messageId: 'reconcile-terminal', timestamp: 10 },
    };
    const beforeCriteria = structuredClone(terminal.acceptanceCriteria);
    const beforeBinding = objectiveReviewBinding(terminal);

    const repeated = registerObjectiveAcceptanceCriteria(
      terminal,
      structuredClone(terminal.acceptanceCriteria!),
      99,
    );
    expect(repeated).toBe(terminal);
    expect(repeated.acceptanceRegisteredAt).toBe(registered.acceptanceRegisteredAt);
    expect(objectiveReviewBinding(repeated)).toEqual(beforeBinding);

    for (const candidate of [
      [{ ...criterion, description: 'Changed terminal expectation' }, additional],
      [criterion, additional, { ...additional, id: 'timer-route' }],
      [criterion],
    ]) {
      expect(() => registerObjectiveAcceptanceCriteria(terminal, candidate, 100))
        .toThrow('Terminal reconciliation freezes the registered acceptance contract');
      expect(terminal.acceptanceCriteria).toEqual(beforeCriteria);
      expect(objectiveReviewBinding(terminal)).toEqual(beforeBinding);
    }
  });

  it('rejects procedure and requirement changes during terminal reconciliation', () => {
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    const procedural = registerObjectiveAcceptanceCriteria(base, [criterion], 2, 'software-change');
    const terminal = {
      ...procedural,
      terminalReconciliation: { messageId: 'reconcile-terminal', timestamp: 10 },
    };
    const beforeBinding = objectiveReviewBinding(terminal);

    expect(registerObjectiveAcceptanceCriteria(terminal, [structuredClone(criterion)], 20, 'software-change'))
      .toBe(terminal);
    expect(() => registerObjectiveAcceptanceCriteria(
      terminal,
      [{ ...criterion, requirementId: 'requested-behavior' }],
      21,
      'software-change',
    )).toThrow('Terminal reconciliation freezes the registered acceptance contract');
    expect(() => registerObjectiveAcceptanceCriteria(terminal, [criterion], 22, 'document-package'))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');
    expect(objectiveReviewBinding(terminal)).toEqual(beforeBinding);

    const requirementCriterion: ObjectiveAcceptanceCriterion = {
      ...criterion,
      requirementId: 'requested-behavior',
    };
    const requirementBound = registerObjectiveAcceptanceCriteria(
      base,
      [requirementCriterion],
      3,
      'software-change',
    );
    const requirementTerminal = {
      ...requirementBound,
      terminalReconciliation: { messageId: 'reconcile-requirement', timestamp: 12 },
    };
    const requirementBinding = objectiveReviewBinding(requirementTerminal);
    expect(() => registerObjectiveAcceptanceCriteria(requirementTerminal, [{
      ...requirementCriterion,
      requirementId: 'regression-checks',
    }], 23, 'software-change')).toThrow(
      'Terminal reconciliation freezes the registered acceptance contract',
    );
    expect(objectiveReviewBinding(requirementTerminal)).toEqual(requirementBinding);

    const withoutProcedure = {
      ...objective,
      terminalReconciliation: { messageId: 'reconcile-without-procedure', timestamp: 11 },
    };
    const unboundProcedure = objectiveReviewBinding(withoutProcedure);
    expect(() => registerObjectiveAcceptanceCriteria(withoutProcedure, [criterion], 24, 'software-change'))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');
    expect(objectiveReviewBinding(withoutProcedure)).toEqual(unboundProcedure);
  });

  it('permits exactly the initial registration when terminal reconciliation has no contract yet', () => {
    const unregistered = {
      ...transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      requiresAcceptanceCriteria: true,
      terminalReconciliation: {
        messageId: 'reconcile-before-registration',
        timestamp: 2,
        initialAcceptanceRegistrationRequired: true as const,
      },
    };
    expect(unregistered.acceptanceCriteria).toBeUndefined();

    const preMarkerObservation: Message = {
      ...observation,
      id: 'pre-marker-observation',
      toolUseId: 'pre-marker-observation',
      timestamp: 1.5,
    };
    const marker: Message = {
      id: 'reconcile-before-registration',
      role: 'user',
      content: 'Réconcilie uniquement les reçus existants, sans nouvel effet externe.',
      timestamp: 2,
    };
    const transcript = [root, preMarkerObservation, marker];

    const first = registerObjectiveAcceptanceCriteria(
      unregistered,
      [criterion],
      3,
      undefined,
      transcript,
    );
    expect(first.acceptanceCriteria).toEqual([criterion]);
    expect(first.procedure).toBeUndefined();
    expect(first.terminalReconciliation).toEqual(unregistered.terminalReconciliation);

    expect(registerObjectiveAcceptanceCriteria(first, [structuredClone(criterion)], 4))
      .toBe(first);
    expect(() => registerObjectiveAcceptanceCriteria(first, [{
      ...criterion, description: 'Changed after the initial registration',
    }], 5)).toThrow(
      'Terminal reconciliation freezes the registered acceptance contract',
    );

    const arbitraryLocalRead: ObjectiveAcceptanceCriterion = {
      id: 'read-arbitrary-system-file',
      description: 'An arbitrary system file contains a chosen value.',
      toolName: 'Read',
      input: { file_path: '/etc/passwd' },
      checks: [{ path: '$text', equals: 'root' }],
    };
    expect(() => registerObjectiveAcceptanceCriteria(
      unregistered,
      [arbitraryLocalRead],
      3,
      undefined,
      transcript,
    )).toThrow('already satisfied by exact persisted read-only observations');
    expect(() => registerObjectiveAcceptanceCriteria(
      unregistered,
      [criterion],
      3,
      undefined,
      [root, marker, preMarkerObservation],
    )).toThrow('already satisfied by exact persisted read-only observations');

    const noContractRequired = {
      ...unregistered,
      requiresAcceptanceCriteria: undefined,
      terminalReconciliation: { messageId: 'reconcile-without-contract', timestamp: 6 },
    };
    expect(noContractRequired.requiresAcceptanceCriteria).not.toBe(true);
    expect(() => registerObjectiveAcceptanceCriteria(noContractRequired, [criterion], 7))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');

    const missingHostCapability = {
      ...unregistered,
      terminalReconciliation: { messageId: 'reconcile-without-capability', timestamp: 8 },
    };
    expect(missingHostCapability.requiresAcceptanceCriteria).toBe(true);
    expect(() => registerObjectiveAcceptanceCriteria(missingHostCapability, [criterion], 9))
      .toThrow('Terminal reconciliation freezes the registered acceptance contract');
  });
});
