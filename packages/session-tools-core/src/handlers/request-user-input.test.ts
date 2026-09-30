import { describe, expect, it } from 'bun:test';
import type { SessionToolContext } from '../context.ts';
import { getToolDefsAsJsonSchema, SESSION_TOOL_REGISTRY } from '../tool-defs.ts';
import { handleRequestUserInput } from './request-user-input.ts';

const question = { id: 'format', question: 'Which format?', options: [{ id: 'pdf', label: 'PDF', recommended: true }] };

function context(callback?: SessionToolContext['requestUserInput']): SessionToolContext {
  return { sessionId: 'conversation', requestUserInput: callback } as SessionToolContext;
}

describe('request_user_input', () => {
  it('returns the host request ID immediately without waiting for answers', async () => {
    const calls: unknown[] = [];
    const result = await handleRequestUserInput(context(async questions => {
      calls.push(questions);
      return { requestId: 'host-request', status: 'pending' };
    }), { questions: [question, { id: 'details', question: 'Any details?' }, { id: 'sections', question: 'Which sections?', options: [], multiSelect: true }] });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ requestId: 'host-request', status: 'pending' });
    expect(calls).toEqual([[question, { id: 'details', question: 'Any details?' }, { id: 'sections', question: 'Which sections?' }]]);
  });

  it('waits for host registration confirmation, not an invented local pending response', async () => {
    let confirm!: (value: { requestId: string; status: 'pending' }) => void;
    let resolved = false;
    const pending = handleRequestUserInput(context(() => new Promise(resolve => { confirm = resolve; })), { questions: [question] });
    void pending.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    confirm({ requestId: 'confirmed', status: 'pending' });
    expect(JSON.parse((await pending).content[0]!.text).requestId).toBe('confirmed');
  });

  it('fails closed without a host callback, including standalone MCP contexts', async () => {
    const result = await SESSION_TOOL_REGISTRY.get('request_user_input')!.handler!(context(), { questions: [question] });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('No question was submitted');
  });

  it('propagates registration failure and rejects malformed host acknowledgements', async () => {
    const failure = await handleRequestUserInput(context(async () => { throw new Error('Session is no longer active'); }), { questions: [question] });
    expect(failure.isError).toBe(true);
    expect(failure.content[0]!.text).toContain('Session is no longer active');
    for (const acknowledgement of [undefined, { requestId: '', status: 'pending' }, { requestId: 'r', status: 'answered' }]) {
      const result = await handleRequestUserInput(context(async () => acknowledgement as never), { questions: [question] });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('did not confirm');
    }
  });

  it('rejects invalid or ambiguous inputs before calling the host on proxy routes', async () => {
    let calls = 0;
    const ctx = context(async () => { calls++; return { requestId: 'unused', status: 'pending' }; });
    const invalid: unknown[] = [
      undefined, {}, { questions: [] }, { questions: Array.from({ length: 4 }, (_, index) => ({ ...question, id: String(index) })) },
      { questions: [{ ...question, id: ' ' }] }, { questions: [{ ...question, question: ' ' }] },
      { questions: [{ ...question, id: 'x'.repeat(81) }] }, { questions: [{ ...question, id: 'bad\u0000id' }] },
      { questions: [{ ...question, question: 'x'.repeat(2_001) }] },
      { questions: [{ ...question, question: ` ${'x'.repeat(2_000)} ` }] },
      { questions: [question, { ...question, id: ' format ' }] },
      { questions: [{ ...question, multiSelect: 'true' }] },
      { questions: [{ ...question, options: Array.from({ length: 9 }, (_, index) => ({ id: String(index), label: 'Choice' })) }] },
      ...[
        [{ id: '', label: 'Choice' }], [{ id: 'a', label: ' ' }], [{ id: 'a', label: 'x'.repeat(201) }],
        [{ id: 'bad\u0001id', label: 'Choice' }], [{ id: 'x'.repeat(81), label: 'Choice' }],
        [{ id: 'a', label: 'Choice', description: 'x'.repeat(501) }],
        [{ id: 'a', label: 'First' }, { id: ' a ', label: 'Second' }],
      ].map(options => ({ questions: [{ ...question, options }] })),
    ];
    for (const args of invalid) {
      const result = await SESSION_TOOL_REGISTRY.get('request_user_input')!.handler!(ctx, args);
      expect(result.isError).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('accepts maximum field bounds and separate question-local option IDs', async () => {
    const bounded = { id: ' first ', question: 'q'.repeat(2_000), multiSelect: true, options: Array.from({ length: 8 }, (_, index) => ({ id: `option-${index}`, label: 'l'.repeat(200), description: 'd'.repeat(500) })) };
    let received: unknown;
    const result = await handleRequestUserInput(context(async questions => {
      received = questions;
      return { requestId: 'max', status: 'pending' };
    }), { questions: [bounded, { ...bounded, id: 'second' }] });
    expect(result.isError).toBeFalsy();
    expect(received).toEqual([{ ...bounded, id: 'first' }, { ...bounded, id: 'second' }]);
  });

  it('advertises the same bounded schema to MCP and Pi', () => {
    const standalone = getToolDefsAsJsonSchema().find(tool => tool.name === 'request_user_input');
    const proxy = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).find(tool => tool.name === 'mcp__session__request_user_input');
    expect(proxy?.inputSchema).toEqual(standalone?.inputSchema);
    expect(standalone?.inputSchema).toMatchObject({ type: 'object', required: ['questions'], properties: { questions: { type: 'array', minItems: 1, maxItems: 3 } } });
    const properties = standalone?.inputSchema.properties as Record<string, { items: { required: string[]; properties: Record<string, unknown> } }>;
    expect(properties.questions!.items.required).toEqual(['id', 'question']);
    expect(properties.questions!.items.properties.options).toMatchObject({ type: 'array', maxItems: 8 });
    expect(properties.questions!.items.properties.multiSelect).toMatchObject({ type: 'boolean', default: false });
    expect(standalone?.description).toContain('pending from a named third party is not a missing user preference');
    expect(proxy?.description).toContain('finish independent safe work and report the exact external dependency');
    expect(standalone?.description).toContain('replacing the blocked provider or integration');
    expect(SESSION_TOOL_REGISTRY.get('request_user_input')?.executionMode).toBe('registry');
  });
});
