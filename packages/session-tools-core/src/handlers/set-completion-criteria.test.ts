import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { getToolDefsAsJsonSchema, SESSION_TOOL_REGISTRY, SetCompletionCriteriaSchema } from '../tool-defs.ts';
import { SET_COMPLETION_CRITERIA_EXAMPLE } from '../completion-criteria-schema.ts';
import { handleSetCompletionCriteria } from './set-completion-criteria.ts';

const example = JSON.parse(SET_COMPLETION_CRITERIA_EXAMPLE);
const criterion = example.criteria[0];
const context = (setCompletionCriteria?: SessionToolContext['setCompletionCriteria']) => (
  { sessionId: 'test', setCompletionCriteria } as SessionToolContext
);

describe('set_completion_criteria input contract', () => {
  it('advertises the complete nested schema to standalone MCP and prefixed Pi tools', () => {
    const standalone = getToolDefsAsJsonSchema().find(tool => tool.name === 'set_completion_criteria')!;
    const proxy = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).find(tool => tool.name === 'mcp__session__set_completion_criteria')!;
    expect(proxy.inputSchema).toEqual(standalone.inputSchema);
    expect(standalone.inputSchema).toMatchObject({
      type: 'object', required: ['criteria'], properties: {
        criteria: { type: 'array', minItems: 1, maxItems: 16, items: {
          type: 'object', required: ['id', 'description', 'toolName', 'input', 'checks'], additionalProperties: false,
          properties: {
            id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
            supersedes: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
            description: { type: 'string', maxLength: 1000 },
            toolName: { type: 'string', maxLength: 256 },
            input: { type: 'object', minProperties: 1, maxProperties: 16, additionalProperties: {
              type: ['string', 'number', 'boolean', 'null'],
            } },
            checks: { type: 'array', minItems: 1, maxItems: 16, items: {
              type: 'object', required: ['path', 'equals'], additionalProperties: false,
              properties: { path: { type: 'string', maxLength: 256 }, equals: {
                type: ['string', 'number', 'boolean', 'null'],
              } },
            } },
          },
        } },
      },
    });
    expect(standalone.description).toContain(SET_COMPLETION_CRITERIA_EXAMPLE);
    expect(standalone.description).toContain('may be reused even when it preceded registration');
    expect(standalone.description).toContain('a later relevant target mutation invalidates it');
    expect(standalone.description).toContain('Prefer its toolUseId or messageId');
    expect(standalone.description).toContain('one unique matching observation');
    expect(standalone.description).not.toContain('must cite a matching successful observation toolUseId');
    expect(standalone.description).not.toContain('Added criteria require observations after their own registration');
    expect(SetCompletionCriteriaSchema.parse(example)).toEqual(example);
  });

  it('returns exact field guidance for the malformed canary shapes without calling the host', async () => {
    let calls = 0;
    const ctx = context(async () => { calls++; return {}; });
    for (const args of [
      {},
      { criteria: [{ id: criterion.id, description: criterion.description, verificationTool: 'Bash', targetInputs: criterion.input, checks: criterion.checks }] },
      { criteria: [{ id: criterion.id, description: criterion.description, verification: { tool: 'Bash', input: criterion.input }, checks: criterion.checks }] },
    ]) {
      const result = await SESSION_TOOL_REGISTRY.get('set_completion_criteria')!.handler!(ctx, args);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Invalid set_completion_criteria arguments: criteria');
      expect(result.content[0]!.text).toContain(SET_COMPLETION_CRITERIA_EXAMPLE);
      expect(result.content[0]!.text).toContain('toolName/input/checks');
      expect(result.content[0]!.text).toContain('do not repeat external actions');
      expect(result.content[0]!.text.length).toBeLessThan(2500);
    }
    expect(calls).toBe(0);
  });

  it('validates proxy arguments with the same bounds before forwarding the exact contract', async () => {
    const calls: unknown[] = [];
    const ctx = context(async criteria => { calls.push(criteria); return { registered: criteria.length }; });
    const invalid = [
      undefined, { criteria: [] }, { criteria: Array.from({ length: 17 }, () => criterion) },
      { criteria: [{ ...criterion, id: 'Bad ID' }] },
      { criteria: [{ ...criterion, input: {} }] },
      { criteria: [{ ...criterion, input: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, i])) }] },
      { criteria: [{ ...criterion, input: { command: { nested: 'not scalar' } } }] },
      { criteria: [{ ...criterion, checks: [] }] },
      { criteria: [{ ...criterion, checks: [{ path: '$.ready', equals: ['not scalar'] }] }] },
      { criteria: [{ ...criterion, checks: [{ path: '$.ready', equals: true, ignored: true }] }] },
    ];
    for (const args of invalid) expect((await handleSetCompletionCriteria(ctx, args)).isError).toBe(true);
    expect(calls).toEqual([]);
    const result = await handleSetCompletionCriteria(ctx, example);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ registered: 1 });
    expect(calls).toEqual([example.criteria]);
  });

  it('rejects duplicate IDs, unsupported selectors and mismatched text scalars before forwarding', async () => {
    let calls = 0;
    const ctx = context(async () => { calls++; return {}; });
    const malformed = [
      { criteria: [criterion, criterion] },
      ...['$', '$text', 'target.*', '$.__proto__.ready', 'target[01]'].map(path => ({
        criteria: [{ ...criterion, input: { [path]: true } }],
      })),
      { criteria: [{ ...criterion, input: { target: 'one', '$.target': 'one' } }] },
      { criteria: [{ ...criterion, checks: [{ path: '$.ready', equals: true }, { path: 'ready', equals: true }] }] },
      { criteria: [{ ...criterion, checks: [{ path: '$text', equals: true }] }] },
      { criteria: [{ ...criterion, checks: [{ path: '$[?(@.ready)]', equals: true }] }] },
      { criteria: [{ ...criterion, description: '   ' }] },
      { criteria: [{ ...criterion, toolName: '   ' }] },
    ];
    for (const input of malformed) {
      const result = await handleSetCompletionCriteria(ctx, input);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Invalid set_completion_criteria arguments');
      expect(result.content[0]!.text).toContain('do not repeat external actions');
    }
    expect(calls).toBe(0);
    for (const checks of [[{ path: '$', equals: true }], [{ path: '$text', equals: 'true' }]]) {
      expect((await handleSetCompletionCriteria(ctx, { criteria: [{ ...criterion, checks }] })).isError).toBeFalsy();
    }
    expect(calls).toBe(2);
  });

  it('accepts raw MCP root UI metadata without relaxing criterion validation', async () => {
    const calls: unknown[] = [];
    const ctx = context(async criteria => { calls.push(criteria); return { registered: criteria.length }; });
    const metadata = { _intent: 'Register the observed target check', _displayName: 'Completion criteria' };
    const rawArgs = { ...example, ...metadata };
    const result = await SESSION_TOOL_REGISTRY.get('set_completion_criteria')!.handler!(ctx, rawArgs);
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([example.criteria]);
    expect(rawArgs).toEqual({ ...example, ...metadata });

    for (const args of [
      { ...rawArgs, ignored: true },
      metadata,
      { ...rawArgs, criteria: [{ ...criterion, _intent: 'Not a criterion field' }] },
      { ...rawArgs, criteria: [{ ...criterion, input: {} }] },
    ]) {
      expect((await SESSION_TOOL_REGISTRY.get('set_completion_criteria')!.handler!(ctx, args)).isError).toBe(true);
    }
    expect(calls).toEqual([example.criteria]);
  });

  it('keeps host immutability and selector rejections authoritative', async () => {
    for (const reason of ['Registered criteria cannot be weakened or replaced', 'Invalid JSON selector or scalar']) {
      const result = await handleSetCompletionCriteria(context(async () => { throw new Error(reason); }), example);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(reason);
      expect(result.content[0]!.text).toContain(SET_COMPLETION_CRITERIA_EXAMPLE);
    }
    expect((await handleSetCompletionCriteria(context(), example)).isError).toBe(true);
  });

  it('bounds malformed-argument diagnostics without echoing raw target values or unknown keys', async () => {
    const secret = 'PRIVATE_TARGET_SENTINEL';
    const result = await handleSetCompletionCriteria(context(async () => ({})), {
      criteria: [{ ...criterion, [secret]: secret, input: { [secret]: { value: secret } } }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain(secret);
    expect(result.content[0]!.text.length).toBeLessThan(2500);
  });
});
