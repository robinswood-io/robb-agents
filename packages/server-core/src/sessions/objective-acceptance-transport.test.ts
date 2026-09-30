import { describe, expect, it } from 'bun:test';
import { validateToolArguments, type Tool } from '@earendil-works/pi-ai';
import { getToolDefsAsJsonSchema, SESSION_TOOL_REGISTRY, type SessionToolContext } from '@craft-agent/session-tools-core';
import type { Message, ObjectiveAcceptanceCriterion, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import { transitionObjectiveContract } from './objective-contract.ts';
import { registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from './objective-acceptance-criteria.ts';

const root: Message = { id: 'root', role: 'user', content: 'Vérifie le résultat demandé.', timestamp: 1 };
const criterion: ObjectiveAcceptanceCriterion = {
  id: 'target-ready', description: 'The requested target returns the exact expected JSON state',
  toolName: 'Bash', input: { command: 'cat /tmp/target-state.json', timeout: 120 },
  checks: [
    { path: '$.count', equals: 1 },
    { path: '$.ready', equals: true },
    { path: '$.missing', equals: null },
    { path: '$.literal', equals: '1' },
  ],
};
const observation: Message = {
  id: 'observation', toolUseId: 'observed-call', role: 'tool', content: '',
  toolName: 'Bash', toolInput: { ...criterion.input },
  toolResult: '{"count":1,"ready":true,"missing":null,"literal":"1"}',
  timestamp: 4, toolStatus: 'completed', toolExecuted: true,
};
const receipt: ObjectiveOutcomeDeclaration = {
  state: 'complete_verified', remainingWork: [], blocker: null,
  criteria: [{ id: criterion.id, satisfied: true, evidence: [observation.toolUseId!] }],
};

async function registerThroughPi(criteria: ObjectiveAcceptanceCriterion[], prefix = 'mcp__session__') {
  const definition = getToolDefsAsJsonSchema({ prefix }).find(tool => tool.name === `${prefix}set_completion_criteria`)!;
  const args = { criteria: structuredClone(criteria) };
  // This is the actual SDK validation step before the proxy sends arguments
  // to the main process. No observation tool or provider is executed here.
  const validated = validateToolArguments({
    name: definition.name, description: definition.description, parameters: definition.inputSchema,
  } as Tool, { type: 'toolCall', id: 'registration', name: definition.name, arguments: args });
  let objective = transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 });
  const result = await SESSION_TOOL_REGISTRY.get('set_completion_criteria')!.handler!({
    sessionId: 'isolated-contract-test',
    setCompletionCriteria: async (received: ObjectiveAcceptanceCriterion[]) => {
      objective = registerObjectiveAcceptanceCriteria(objective, received, 2);
      return { objectiveId: objective.objectiveId, criteria: objective.acceptanceCriteria };
    },
  } as SessionToolContext, validated);
  return { args, validated, result, objective };
}

describe('typed acceptance criteria across Pi registration and evidence validation', () => {
  it.each(['', 'mcp__session__'])('preserves original scalar types through %s schema, SDK, host, ACK, and stored JSON', async (prefix) => {
    const { args, validated, result, objective } = await registerThroughPi([criterion], prefix);
    expect(args.criteria).toEqual([criterion]);
    expect(validated.criteria).toEqual([criterion]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text).criteria).toEqual([criterion]);
    const restored = JSON.parse(JSON.stringify(objective));
    expect(restored.acceptanceCriteria).toEqual([criterion]);
    expect(validateObjectiveAcceptanceCriteria(restored, [root, observation], receipt)).toEqual([]);
  });

  it('still rejects wrong types, wrong values, missing execution, and invented invocation IDs', async () => {
    const { objective } = await registerThroughPi([criterion]);
    for (const changed of [
      { toolInput: { ...criterion.input, timeout: '120' } },
      { toolInput: { ...criterion.input, command: 'cat /tmp/other-state.json' } },
      { toolResult: '{"count":"1","ready":true,"missing":null,"literal":"1"}' },
      { toolResult: '{"count":2,"ready":true,"missing":null,"literal":"1"}' },
      { toolResult: '{"count":1,"ready":"true","missing":null,"literal":"1"}' },
      { toolResult: '{"count":1,"ready":true,"missing":"","literal":"1"}' },
      { toolResult: '{"count":1,"ready":true,"missing":null,"literal":1}' },
      { toolExecuted: false }, { toolUseId: 'another-call' },
    ]) {
      expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...observation, ...changed }], receipt)).toHaveLength(1);
    }
  });

  it.each(['1', '001', 'true', 'false', ''])('keeps intentional string %j distinct from numeric, boolean, and null values', async (text) => {
    const strings: ObjectiveAcceptanceCriterion = {
      ...criterion, input: { command: criterion.input.command, literal: text }, checks: [{ path: '$.value', equals: text }],
    };
    const { objective, validated } = await registerThroughPi([strings]);
    expect(validated.criteria).toEqual([strings]);
    const message = { ...observation, toolInput: strings.input, toolResult: JSON.stringify({ value: text }) };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, message], receipt)).toEqual([]);
    for (const value of [1, true, false, null]) {
      expect(validateObjectiveAcceptanceCriteria(objective, [root, { ...message, toolResult: JSON.stringify({ value }) }], receipt)).toHaveLength(1);
    }
  });

  it('does not repair or weaken previously registered string criteria', async () => {
    const historical: ObjectiveAcceptanceCriterion = {
      ...criterion, input: { ...criterion.input, timeout: '120' }, checks: [{ path: '$.count', equals: '1' }],
    };
    const { objective } = await registerThroughPi([historical]);
    expect(objective.acceptanceCriteria).toEqual([historical]);
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation], receipt)).toHaveLength(1);
    expect(() => registerObjectiveAcceptanceCriteria(objective, [criterion], 5))
      .toThrow('Registered criteria cannot be weakened or replaced');
  });

  it('still rejects oversized strings at the authoritative host before registration', async () => {
    for (const invalid of [
      { ...criterion, input: { command: 'x'.repeat(2049) } },
      { ...criterion, checks: [{ path: '$.value', equals: 'x'.repeat(2049) }] },
    ]) {
      const { result, objective } = await registerThroughPi([invalid]);
      expect(result.isError).toBe(true);
      expect(objective.acceptanceCriteria).toBeUndefined();
    }
  });

  it('rejects nonscalar values before they can reach registration', async () => {
    for (const value of [{ nested: true }, [1]]) {
      await expect(registerThroughPi([{ ...criterion, checks: [{ path: '$.value', equals: value as never }] }]))
        .rejects.toThrow();
    }
  });
});
