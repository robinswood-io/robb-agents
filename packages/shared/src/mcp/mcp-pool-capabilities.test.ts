import { describe, expect, it } from 'bun:test';
import { McpClientPool } from './mcp-pool.ts';
import type { PoolClient } from './client.ts';

class TestPool extends McpClientPool {
  add(slug: string, client: PoolClient): Promise<void> {
    return this.registerClient(slug, client);
  }
}

describe('McpClientPool proxy capabilities', () => {
  it('propagates MCP read/idempotency hints and adds schema-aware output guidance', async () => {
    const pool = new TestPool();
    await pool.add('logs', {
      listTools: async () => [{
        name: 'search',
        description: 'Search logs.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number' }, since: { type: 'string' } },
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      }],
      callTool: async () => ({}),
      close: async () => {},
    });

    const [definition] = pool.getProxyToolDefs();
    expect(definition?.readOnly).toBe(true);
    expect(definition?.idempotent).toBe(true);
    expect(definition?.description).toContain('Output budget');
    expect(definition?.description).toContain('limit, since');
  });

  it('preserves absent and explicit-false hints instead of weakening conservative defaults', async () => {
    const pool = new TestPool();
    await pool.add('mixed', {
      listTools: async () => [{
        name: 'inspect',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: false, openWorldHint: false },
      }],
      callTool: async () => ({}),
      close: async () => {},
    });

    const [definition] = pool.getProxyToolDefs();
    expect(definition?.readOnly).toBe(false);
    expect(definition?.openWorld).toBe(false);
    expect(definition?.idempotent).toBeUndefined();
    expect(definition?.destructive).toBeUndefined();

    expect(pool.getProxyToolCapabilities('mcp__mixed__inspect')).toEqual({
      readOnly: false,
      idempotent: undefined,
      destructive: undefined,
      openWorld: false,
      trusted: false,
    });
  });

  it('validates arguments before every backend transport', async () => {
    const pool = new TestPool();
    const calls: Record<string, unknown>[] = [];
    await pool.add('strict', {
      listTools: async () => [{
        name: 'lookup',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      }],
      callTool: async (_name, args) => {
        calls.push(args);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      close: async () => {},
    });

    const missing = await pool.callTool('mcp__strict__lookup', {});
    const extra = await pool.callTool('mcp__strict__lookup', { value: 'ok', unexpected: true });
    const valid = await pool.callTool('mcp__strict__lookup', { value: 'ok' });

    expect(missing).toMatchObject({ isError: true, sourceSlug: 'strict' });
    expect(extra).toMatchObject({ isError: true, sourceSlug: 'strict' });
    expect(missing.content).toContain('blocked before execution');
    expect(calls).toEqual([{ value: 'ok' }]);
    expect(valid).toMatchObject({ content: 'ok', isError: false });
  });

  it('runs the host source-binding fence before the MCP client transport', async () => {
    const pool = new TestPool();
    let transportCalls = 0;
    await pool.add('sealed', {
      listTools: async () => [{ name: 'read', inputSchema: { type: 'object' } }],
      callTool: async () => {
        transportCalls += 1;
        return { content: [{ type: 'text', text: 'must not run' }] };
      },
      close: async () => {},
    });
    pool.setBeforeSourceToolExecution(async ({ sourceSlug, toolName, args, capabilities }) => {
      expect({ sourceSlug, toolName }).toEqual({ sourceSlug: 'sealed', toolName: 'read' });
      expect(args).toEqual({});
      expect(capabilities).toMatchObject({ trusted: false });
      throw new Error('source credential generation drifted');
    });

    const result = await pool.callTool('mcp__sealed__read', {});

    expect(result).toMatchObject({ isError: true, sourceSlug: 'sealed' });
    expect(result.content).toContain('source credential generation drifted');
    expect(transportCalls).toBe(0);
  });

  it('retains declared output schemas and structured tool results', async () => {
    const pool = new TestPool();
    await pool.add('typed', {
      listTools: async () => [{
        name: 'status',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
      }],
      callTool: async () => ({
        content: [{ type: 'text', text: 'ready' }],
        structuredContent: { status: 'ready' },
      }),
      close: async () => {},
    });

    expect(pool.getProxyToolDefs()[0]?.outputSchema).toEqual({
      type: 'object',
      properties: { status: { type: 'string' } },
      required: ['status'],
    });
    expect(await pool.callTool('mcp__typed__status', {})).toEqual({
      content: 'ready',
      isError: false,
      structuredContent: { status: 'ready' },
    });
  });

  it('rejects structured results that violate the source output contract', async () => {
    const pool = new TestPool();
    await pool.add('typed', {
      listTools: async () => [{
        name: 'status',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
          additionalProperties: false,
        },
      }],
      callTool: async () => ({
        content: [{ type: 'text', text: 'malformed' }],
        structuredContent: { status: 503 },
      }),
      close: async () => {},
    });

    const result = await pool.callTool('mcp__typed__status', {});

    expect(result).toMatchObject({ isError: true, sourceSlug: 'typed' });
    expect(result.content).toContain('does not match its declared schema');
    expect(result.structuredContent).toBeUndefined();
  });
});
