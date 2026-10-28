import { withScopeReview } from "./__fixtures__/scope-review.ts";
import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveOutcomeDeclaration, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { isObjectiveShellExecutorToolName } from "@craft-agent/shared/agent";
import { objectiveReviewBinding, isObjectiveMutationTool, transitionObjectiveContract } from "./objective-contract.ts";
import { collectObjectiveAcceptanceObservations, registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { criterion, objective, observation, receipt, root } from "./testing/objective-acceptance-criteria-fixture.ts";

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
  it('keeps tool observation semantics when crediting an exact short registered check', () => {
    const cases: Array<{ toolName: string; input: ObjectiveAcceptanceCriterion['input']; valid: boolean }> = [
      { toolName: 'mcp__ops__get_status', input: { host: 'staging' }, valid: true },
      { toolName: 'Bash', input: { command: 'cat /tmp/status' }, valid: true },
      { toolName: 'Bash', input: { command: 'test -s /tmp/status && printf OK' }, valid: true },
      { toolName: 'Bash', input: { command: 'grep -q ready /tmp/status && echo OK' }, valid: true },
      { toolName: 'Bash', input: { command: 'cmp -s /tmp/status /tmp/expected && printf OK' }, valid: true },
      { toolName: 'Bash', input: { command: 'curl --fail --silent https://example.com/health' }, valid: true },
      { toolName: 'Bash', input: { command: 'python3 /tmp/validate_campaign.py' }, valid: true },
      { toolName: 'Bash', input: { command: 'bun run test:orion-contract' }, valid: true },
      { toolName: 'Bash', input: { command: "docker inspect -f '{{.State.Status}}' release-api" }, valid: true },
      { toolName: 'Bash', input: { command: 'docker ps --filter name=release-api' }, valid: true },
      { toolName: 'Bash', input: { command: 'systemctl is-active --quiet release-api.service' }, valid: true },
      { toolName: 'Bash', input: { command: 'gh pr view 20 --repo craft-ai-agents/craft-agents-oss --json state' }, valid: true },
      { toolName: 'mcp__ops__ssh_execute', input: { server: 'staging', cwd: '/srv/release',
        command: 'python3 /srv/validate_release.py' }, valid: true },
      { toolName: 'mcp__ops__exec_command', input: { host: 'staging',
        command: 'curl --fail --silent https://example.com/health' }, valid: true },
      { toolName: 'mcp__pipeline__get_and_process', input: { host: 'staging' }, valid: false },
      { toolName: 'mcp__ops__get_wait_status', input: { host: 'staging' }, valid: false },
      { toolName: 'mcp__session__wait_sessions', input: { sessionId: 'child' }, valid: false },
      { toolName: 'Bash', input: { command: 'printf OK' }, valid: false },
      { toolName: 'Bash', input: { command: 'python3 -c "print(\"OK\")"' }, valid: false },
      { toolName: 'Bash', input: { command: 'curl -X POST https://example.com/health' }, valid: false },
    ];
    for (const { toolName, input, valid } of cases) {
      const base = transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 });
      const candidate = { ...criterion, toolName, input, checks: [{ path: '$text', equals: 'OK' }] };
      if (!valid && isObjectiveShellExecutorToolName(toolName)) {
        expect(() => registerObjectiveAcceptanceCriteria(base, [candidate], 2))
          .toThrow('cannot serve as host-observed acceptance evidence');
        expect(base.acceptanceCriteria).toBeUndefined();
        continue;
      }
      const registered = registerObjectiveAcceptanceCriteria(base, [candidate], 2);
      const result = { ...observation, toolName, toolInput: input, toolResult: 'OK' };
      const outcome = validateObjectiveOutcome(receipt, { objective: registered, messages: withScopeReview(registered, [root, result]) });
      expect(outcome.valid).toBe(valid);
      if (!valid) expect(outcome.gaps).toContain('criterion lacks observed evidence: relevant-checks-passed');
    }
  });

  it('compares the exact bounded Read payload while excluding only its authenticated continuation notice', () => {
    const expected = "alpha\nbeta\ngamma";
    const readCriterion: ObjectiveAcceptanceCriterion = {
      id: 'bounded-read', description: 'The exact selected source lines match.',
      toolName: 'functions.read',
      input: { path: '/tmp/selected.txt', offset: 23, limit: 3 },
      checks: [{ path: '$text', equals: expected }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [readCriterion], 2,
    );
    const checkReceipt: ObjectiveOutcomeDeclaration = {
      ...receipt,
      criteria: [
        { id: readCriterion.id, satisfied: true, evidence: ['read-result'] },
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true, evidence: [id === 'relevant-checks-passed' ? 'read-result' : 'assistant-final'],
        })),
      ],
    };
    const result: Message = {
      id: 'read-result', toolUseId: 'read-use', role: 'tool', content: '',
      toolName: 'Read', toolStatus: 'completed', toolExecuted: true, timestamp: 4,
      toolInput: { path: '/tmp/selected.txt', offset: 23, limit: 3 },
      toolResult: expected + '\n\n[350 more lines in file. Use offset=26 to continue.]',
    };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, result], checkReceipt)).toEqual([]);
    for (const changed of [
      { toolResult: expected + '\n\n[350 more lines in file. Use offset=27 to continue.]' },
      { toolResult: expected + '\n\n[350 more lines in file. Use offset=26 to continue.] extra' },
      { toolResult: expected + '\nwrong\n[350 more lines in file. Use offset=26 to continue.]' },
      { toolResult: expected + '\n\n[Showing lines 23-25 of 375. Use offset=26 to continue.]' },
      { toolName: 'Bash' },
      { toolExecuted: false },
      { toolInput: { path: '/tmp/other.txt', offset: 23, limit: 3 } },
    ] satisfies Array<Partial<Message>>) {
      expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...result, ...changed }], checkReceipt))
        .toContain('Business criterion lacks matching post-action evidence: bounded-read');
    }
  });

  it('reads a frozen text predicate from a successful trusted SSH stdout envelope', () => {
    const command = 'test -r /srv/app/status && printf READY';
    const sshCriterion: ObjectiveAcceptanceCriterion = {
      id: 'ssh-status', description: 'The exact remote status file is readable.',
      toolName: 'mcp__rbw-servers__ssh_execute',
      input: { server: 'interne', cwd: '/srv/app', command },
      checks: [{ path: '$text', equals: 'READY' }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [sshCriterion], 2,
    );
    const envelope = {
      server: 'interne', command: 'cd /srv/app && ' + command,
      stdout: 'READY', stderr: '', code: 0, success: true,
    };
    const observed: Message = {
      ...observation, id: 'ssh-status-result', toolUseId: 'ssh-status-call',
      toolName: sshCriterion.toolName, toolInput: sshCriterion.input,
      toolResult: JSON.stringify(envelope),
    };
    const claim: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [{ id: sshCriterion.id, satisfied: true, evidence: [observed.id] }],
    };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, observed], claim)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, observed]))
      .toMatchObject([{ criterionId: sshCriterion.id, passed: true }]);
    expect(registered.acceptanceCriteria?.[0]?.checks).toEqual([{ path: '$text', equals: 'READY' }]);

    for (const invalid of [
      { ...envelope, stdout: 'OTHER' },
      { ...envelope, stderr: 'warning' },
      { ...envelope, code: 1 },
      { ...envelope, success: false },
    ]) {
      const changed = { ...observed, toolResult: JSON.stringify(invalid) };
      expect(collectObjectiveAcceptanceObservations(registered, [root, changed]))
        .toMatchObject([{ criterionId: sshCriterion.id, passed: false }]);
    }
    expect(collectObjectiveAcceptanceObservations(registered, [root, {
      ...observed, toolName: 'mcp__other__ssh_execute',
    }])).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, {
      ...observed, toolInput: { ...sshCriterion.input, command: 'cat /srv/app/status' },
    }])).toEqual([]);
  });

  it('accepts the rbw SSH connector code as exitCode without accepting another target or failed execution', () => {
    const input = {
      server: 'dev', cwd: '/opt/ia-webdev/agent-dev/worktrees/orion/campaign',
      command: "sed -n '1,220p' docs/orion/activation.md deploy/orion/README.md",
    };
    const sshCriterion: ObjectiveAcceptanceCriterion = {
      id: 'orion-docs-read', description: 'The requested remote documents were read successfully.',
      toolName: 'mcp__rbw-servers__ssh_execute', input,
      checks: [{ path: '$.exitCode', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [sshCriterion], 2,
    );
    const envelope = {
      server: input.server, command: `cd ${input.cwd} && ${input.command}`,
      stdout: 'document contents', stderr: '', code: 0, success: true,
    };
    const result: Message = {
      ...observation, id: 'orion-read', toolUseId: 'orion-read-call',
      toolName: sshCriterion.toolName, toolInput: input, toolResult: JSON.stringify(envelope),
    };
    expect(isObjectiveMutationTool(result)).toBe(false);
    expect(isObjectiveMutationTool({
      ...result, toolInput: { ...input, command: "sed -i '' 's/old/new/' docs/orion/activation.md" },
    })).toBe(true);
    const claim: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        { id: sshCriterion.id, satisfied: true, evidence: [result.toolUseId!] },
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true,
          evidence: [id === 'relevant-checks-passed' ? result.toolUseId! : 'assistant-final'],
        })),
      ],
    };
    expect(validateObjectiveOutcome(claim, { objective: registered, messages: withScopeReview(registered, [root, result]) }))
      .toMatchObject({ state: 'complete_verified', valid: true, gaps: [] });
    for (const changed of [
      { toolExecuted: false }, { toolStatus: 'error' as const },
      { toolResult: JSON.stringify({ ...envelope, server: 'prod' }) },
      { toolResult: JSON.stringify({ ...envelope, command: 'cd /elsewhere && ' + input.command }) },
      { toolResult: JSON.stringify({ ...envelope, code: 1, success: false }) },
      { toolResult: JSON.stringify({ ...envelope, code: '0' }) },
    ] satisfies Array<Partial<Message>>) {
      expect(validateObjectiveOutcome(claim, {
        objective: registered, messages: withScopeReview(registered, [root, { ...result, ...changed }]),
      }).valid).toBe(false);
    }
  });

  it('requires exact target, real invocation and post-mutation evidence for a registered validation script', () => {
    const command = 'python3 /tmp/validate_campaign.py >/dev/null && printf \'{"ok":true}\\n\'';
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, toolName: 'Bash', input: { command }, checks: [{ path: '$text', equals: '{"ok":true}' }] }], 2,
    );
    const result = { ...observation, toolName: 'Bash', toolInput: { command }, toolResult: '{"ok":true}\n' };
    expect(validateObjectiveOutcome(receipt, { objective: registered, messages: withScopeReview(registered, [root, result]) }).valid).toBe(true);
    for (const changes of [
      { toolInput: { command: 'python3 /tmp/validate_other_campaign.py' } },
      { timestamp: 0 }, { toolUseId: 'different-call', id: 'different-message' },
      { toolExecuted: false }, { toolStatus: 'error' as const }, { isError: true },
      { toolResult: '{"ok":false}\n' }, { toolResult: '{"ok":true}\nERROR' },
    ]) expect(validateObjectiveOutcome(receipt, { objective: registered, messages: withScopeReview(registered, [root, { ...result, ...changes }]) }).valid).toBe(false);
    const mutation: Message = { ...observation, id: 'later-write', toolUseId: 'later-write', toolName: 'Write', toolInput: { file_path: '/tmp/campaign' }, timestamp: 5 };
    expect(validateObjectiveOutcome(receipt, { objective: registered, messages: withScopeReview(registered, [root, result, mutation]) }).valid).toBe(false);
    const otherRoot: Message = { ...root, id: 'other-objective', timestamp: 6 };
    expect(validateObjectiveOutcome(receipt, { objective: { ...registered, userMessageId: otherRoot.id }, messages: [root, result, otherRoot] }).valid).toBe(false);
    const invented = { ...receipt, criteria: receipt.criteria.map(item => ({ ...item, evidence: ['t_invented'] })) };
    expect(validateObjectiveOutcome(invented, { objective: registered, messages: withScopeReview(registered, [root, result]) }).valid).toBe(false);
  });

  it('preserves sequential sibling observations from exact bounded registered inspections', () => {
    const fields = ['state', 'mergeStateStatus', 'statusCheckRollup'];
    const criteria: ObjectiveAcceptanceCriterion[] = fields.map(field => ({
      id: `pr20-${field.toLowerCase()}`, description: `PR 20 ${field} is verified`,
      toolName: 'Bash',
      input: { command: `gh pr view 20 --repo craft-ai-agents/craft-agents-oss --json ${field}` },
      checks: [{ path: '$.success', equals: true }],
    }));
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      criteria,
      2,
    );
    const observations: Message[] = criteria.map((item, index) => ({
      ...observation,
      id: `pr20-observation-${index}`,
      toolUseId: `pr20-call-${index}`,
      timestamp: 3 + index,
      toolName: item.toolName,
      toolInput: item.input,
      toolResult: '{"success":true}',
    }));
    const claimed: ObjectiveOutcomeDeclaration = {
      state: 'complete_verified', blocker: null, remainingWork: [],
      criteria: [
        ...criteria.map((item, index) => ({
          id: item.id, satisfied: true, evidence: [observations[index]!.toolUseId!],
        })),
        ...registered.completionCriteria.map(id => ({
          id, satisfied: true,
          evidence: [id === 'relevant-checks-passed'
            ? observations[observations.length - 1]!.toolUseId! : 'assistant-final'],
        })),
      ],
    };
    expect(validateObjectiveOutcome(claimed, {
      objective: registered, messages: withScopeReview(registered, [root, ...observations]),
    })).toMatchObject({ state: 'complete_verified', valid: true, gaps: [] });

    const laterMutation: Message = {
      ...observation, id: 'pr20-later-mutation', toolUseId: 'pr20-later-mutation', timestamp: 9,
      toolName: 'Bash', toolInput: { command: 'git checkout main' }, toolResult: 'Switched to main',
    };
    expect(validateObjectiveOutcome(claimed, {
      objective: registered, messages: withScopeReview(registered, [root, ...observations, laterMutation]),
    }).valid).toBe(false);
  });

  it('rejects mutually invalidating opaque validators before freezing an impossible contract', () => {
    const criteria: ObjectiveAcceptanceCriterion[] = ['merged', 'ci'].map(mode => ({
      id: `pr20-${mode}`, description: `PR 20 ${mode} state is verified`,
      toolName: 'mcp__ops__ssh_execute',
      input: { server: 'dev', command: `/tmp/pr20/verify-pr20.sh ${mode}` },
      checks: [{ path: '$.success', equals: true }],
    }));
    const base = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
    expect(() => registerObjectiveAcceptanceCriteria(
      base,
      criteria,
      2,
    )).toThrow('Consolidate them into one read-only invocation');
    expect(base.acceptanceCriteria).toBeUndefined();

    const sharedCommand = '/tmp/pr20/verify-pr20.sh all';
    expect(() => registerObjectiveAcceptanceCriteria(base, criteria.map((item, index) => ({
      ...item,
      input: { server: 'dev', command: sharedCommand },
      checks: [{ path: index === 0 ? '$.merged' : '$.ci', equals: true }],
    })), 3)).not.toThrow();

    expect(() => registerObjectiveAcceptanceCriteria(base, criteria.map((item, index) => ({
      ...item,
      input: { server: 'dev', projectId: `project-${index}`, command: String(item.input["command"]) },
    })), 4)).not.toThrow();
  });

  it('accepts equivalent dotted/indexed registration without changing frozen criteria or review binding', () => {
    const indexed = { ...criterion, toolName: 'functions.bash', input: { command: 'cat /tmp/verified.json', 'target.ids.0': 17 }, checks: [
      { path: '$.items[0].status', equals: 'ready' }, { path: '$.ok', equals: true },
    ] };
    const initial = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [indexed], 2,
    );
    const equivalent = { ...indexed, toolName: 'Bash', input: { '$.target.ids[0]': 17, '$.command': 'cat /tmp/verified.json' }, checks: [
      { path: 'ok', equals: true }, { path: 'items.0.status', equals: 'ready' },
    ] };
    const repeated = registerObjectiveAcceptanceCriteria(initial, [equivalent], 99);
    expect(repeated).toEqual(initial);
    expect(objectiveReviewBinding(repeated)).toEqual(objectiveReviewBinding(initial));
    for (const changed of [
      { ...equivalent, input: { command: 'cat /tmp/another-target.json', 'target.ids.0': 17 } },
      { ...equivalent, checks: [{ path: 'ok', equals: true }] },
      { ...equivalent, checks: [{ path: 'ok', equals: false }, { path: 'items.0.status', equals: 'ready' }] },
      { ...equivalent, checks: [{ path: 'ok', equals: true }, { path: 'items.1.status', equals: 'ready' }] },
      { ...equivalent, toolName: 'mcp__other__bash' },
    ]) expect(() => registerObjectiveAcceptanceCriteria(initial, [changed], 100)).toThrow('cannot be weakened');
  });

  it('recognizes native callable names while keeping MCP namespaces and inputs exact', () => {
    const bashCriterion = { ...criterion, toolName: 'functions.bash', input: { command: 'cat /tmp/state.json' }, checks: [{ path: '$.ok', equals: true }] };
    const bashObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [bashCriterion], 2,
    );
    const bashObservation = { ...observation, toolName: 'Bash', toolInput: { command: 'cat /tmp/state.json' }, toolResult: '{"ok":true}' };
    for (const toolName of ['Bash', 'bash', 'functions.bash']) {
      expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, { ...bashObservation, toolName }], receipt)).toEqual([]);
    }
    for (const changed of [
      { toolName: 'mcp__other__bash' }, { toolName: 'other.bash' }, { toolName: 'functions_bash' },
      { toolInput: { command: 'cat ./tmp/state.json' } },
      { toolInput: { command: 'cat /tmp/other-state.json' } },
      { toolResult: 'SUCCESS: {"ok":true}' },
    ]) expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, { ...bashObservation, ...changed }], receipt)).toHaveLength(1);
    const namespaced = { ...criterion, toolName: `functions.${criterion.toolName}` };
    const namespacedObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [namespaced], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(namespacedObjective, [root, observation], receipt)).toHaveLength(1);
    for (const ref of ['tool:Bash', 'tool:bash', 'tool:functions.bash']) {
      expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation], {
        ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: [ref] }],
      })).toEqual([]);
    }
    expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation], {
      ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['tool:BASH'] }],
    })).toHaveLength(1);
    const repeatedBash = { ...bashObservation, id: 'bash-second', toolUseId: 'bash-second',
      toolName: 'functions.bash', timestamp: 5 };
    expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation, repeatedBash], {
      ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['tool:bash'] }],
    })).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(bashObjective, [root, bashObservation, repeatedBash], {
      ...receipt, criteria: [{ id: criterion.id, satisfied: true, evidence: ['bash-second'] }],
    })).toEqual([]);
  });

  it('reconciles only persisted MCP path fields under bounded workspace roots', () => {
    const validatePath = (
      inputPath: string,
      observedPath: string,
      inputKey = 'path',
      toolName = 'mcp__ops__read_file',
    ): string[] => {
      const pathCriterion: ObjectiveAcceptanceCriterion = {
        id: 'workspace-state', description: 'The exact workspace state is ready.',
        toolName, input: { [inputKey]: inputPath }, checks: [{ path: '$.status', equals: 'ready' }],
      };
      const registered = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
        [pathCriterion],
        2,
      );
      const pathObservation: Message = {
        ...observation, id: 'workspace-path-observation', toolUseId: 'workspace-path-observation',
        toolName, toolInput: { [inputKey]: observedPath }, toolResult: '{"status":"ready"}',
      };
      const pathReceipt: ObjectiveOutcomeDeclaration = {
        state: 'complete_verified', blocker: null, remainingWork: [],
        criteria: [{ id: pathCriterion.id, satisfied: true, evidence: [pathObservation.toolUseId!] }],
      };
      return validateObjectiveAcceptanceCriteria(registered, [root, pathObservation], pathReceipt);
    };

    for (const [inputPath, observedPath, inputKey] of [
      ['/Users/example/project/state.json', './Users/example/project/state.json', 'path'],
      ['./home/craft/project/state.json', '/home/craft/project/state.json', 'file_path'],
      ['/srv/release/state.json', './srv/release/state.json', 'remotePath'],
    ] as const) {
      expect(validatePath(inputPath, observedPath, inputKey)).toEqual([]);
    }

    for (const [inputPath, observedPath, inputKey, toolName] of [
      ['/etc/state.json', './etc/state.json', 'path', 'mcp__ops__read_file'],
      ['/Users/example/project/state.json', './Users/example/project/other.json', 'path', 'mcp__ops__read_file'],
      ['/home/craft/project/state.json', './srv/craft/project/state.json', 'path', 'mcp__ops__read_file'],
      ['/srv/release/../secret.json', './srv/release/../secret.json', 'path', 'mcp__ops__read_file'],
      ['/home/craft/./state.json', './home/craft/./state.json', 'path', 'mcp__ops__read_file'],
      ['/Users/example/project/state.json', './Users/example/project/state.json', 'target', 'mcp__ops__read_file'],
      ['/Users/example/project/state.json', './Users/example/project/state.json', 'path', 'Read'],
    ] as const) {
      expect(validatePath(inputPath, observedPath, inputKey, toolName)).toHaveLength(1);
    }
  });

  it('rejects unsupported or dangerous selectors before freezing an objective', () => {
    for (const path of [
      '', '$.', '$foo', 'foo.', 'foo..id', '$..id', 'foo.[0]', 'foo[0]id',
      '$[*]', '$[-1]', '$[01]', '$[0:2]', '$[?(@.ok)]', '$["ok"]',
      'foo.*', 'foo[0].constructor', '$.__proto__.ok', 'foo.prototype.ok', 'foo[0].__proto__',
      'foo[0', 'foo]0', 'foo bar', 'foo;ok', 'foo()','a'.repeat(257),
    ]) {
      expect(() => registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, checks: [{ path, equals: true }] }], 2,
      )).toThrow('Invalid JSON selector');
    }
    const invalidInputs: ObjectiveAcceptanceCriterion['input'][] = [{ '$text': 'ok' }, { '$': 'ok' }, { id: 1, '$.id': 1 }];
    for (const input of invalidInputs) {
      expect(() => registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [{ ...criterion, input }], 2,
      )).toThrow('Invalid JSON selector');
    }
    expect(() => registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, checks: [{ path: 'ok', equals: true }, { path: '$.ok', equals: true }] }], 2,
    )).toThrow('Invalid JSON selector');
    for (const equals of [true, false, 0, null]) {
      expect(() => registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, checks: [{ path: '$text', equals }] }], 2,
      )).toThrow('Invalid JSON selector');
    }
    expect(objective.acceptanceCriteria).toEqual([criterion]);
  });
});
