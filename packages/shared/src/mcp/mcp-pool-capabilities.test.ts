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
});
