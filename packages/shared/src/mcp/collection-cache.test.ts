import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CollectionSummaryCache, createCollectionSummaryCallback, type CollectionCacheScope } from './collection-cache.ts';
import { McpClientPool } from './mcp-pool.ts';
import type { PoolClient } from './client.ts';

const scope: CollectionCacheScope = { workspace: 'test-workspace', audience: 'family-1', permissionRevision: 'safe/source-account-1', routeRevision: 'connection/utility-model-1' };

describe('collection synthesis cache', () => {
  it('allows the API and MCP layers to wrap the same callback without a self-await', async () => {
    let calls = 0;
    const callback = createCollectionSummaryCallback(() => scope, async () => { calls++; return 'wrapped'; });
    const twice = createCollectionSummaryCallback(() => scope, callback);
    expect(await twice('wrapped-prompt')).toBe('wrapped');
    expect(await twice('wrapped-prompt')).toBe('wrapped');
    expect(calls).toBe(1);
  });
  it('requires identical freshly observed content, audience, permissions and route', async () => {
    const cache = new CollectionSummaryCache();
    let calls = 0;
    const generate = async () => `summary-${++calls}`;
    expect(await cache.summarize(scope, 'observed-content', generate)).toBe('summary-1');
    expect(await cache.summarize(scope, 'observed-content', generate)).toBe('summary-1');
    for (const changed of [
      { ...scope, workspace: 'other' }, { ...scope, audience: 'other' },
      { ...scope, permissionRevision: 'other' }, { ...scope, routeRevision: 'other' },
    ]) await cache.summarize(changed, 'observed-content', generate);
    await cache.summarize(scope, 'changed-content', generate);
    expect(calls).toBe(6);
    await cache.summarize({ ...scope, freshEvidence: true }, 'observed-content', generate);
    await cache.summarize({ ...scope, permissionRevision: '' }, 'observed-content', generate);
    expect(calls).toBe(8);
  });

  it('coalesces simultaneous identical synthesis and never retains failures or empty output', async () => {
    const cache = new CollectionSummaryCache();
    let release!: (value: string) => void;
    let calls = 0;
    const generate = () => { calls++; return new Promise<string>(resolve => { release = resolve; }); };
    const first = cache.summarize(scope, 'same', generate);
    const second = cache.summarize(scope, 'same', generate);
    await Promise.resolve();
    release('ready');
    expect(await Promise.all([first, second])).toEqual(['ready', 'ready']);
    expect(calls).toBe(1);
    await expect(cache.summarize(scope, 'error', async () => { throw new Error('quota'); })).rejects.toThrow('quota');
    expect(await cache.summarize(scope, 'error', async () => 'recovered')).toBe('recovered');
    await cache.summarize(scope, 'empty', async () => null);
    expect(await cache.summarize(scope, 'empty', async () => 'valid')).toBe('valid');
  });

  it('invalidates pending work and bounds retained entries, bytes and age', async () => {
    let time = 0;
    const cache = new CollectionSummaryCache(1, 12, 10, () => time);
    let release!: (value: string) => void;
    const pending = cache.summarize(scope, 'pending', () => new Promise<string>(resolve => { release = resolve; }));
    await Promise.resolve();
    cache.invalidateWorkspace(scope.workspace);
    release('old');
    await pending;
    expect(await cache.summarize(scope, 'pending', async () => 'new')).toBe('new');
    await cache.summarize(scope, 'second', async () => 'second');
    expect(await cache.summarize(scope, 'pending', async () => 'evicted')).toBe('evicted');
    time = 11;
    expect(await cache.summarize(scope, 'pending', async () => 'expired')).toBe('expired');
    await cache.summarize(scope, 'large', async () => 'x'.repeat(13));
    expect(await cache.summarize(scope, 'large', async () => 'uncached')).toBe('uncached');
  });
});

class TestPool extends McpClientPool {
  add(client: PoolClient): Promise<void> { return this.registerClient('collection', client); }
}

it('MCP runtime refetches every source, shares only matching synthesis, and writes session-local evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collection-cache-runtime-'));
  try {
    let sourceCalls = 0;
    let synthesisCalls = 0;
    let content = 'current source content with ordinary words '.repeat(1000);
    const client = (): PoolClient => ({
      listTools: async () => ['read_records', 'update_record'].map(name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } })),
      callTool: async name => { sourceCalls++; return { content: [{ type: 'text', text: name === 'update_record' ? 'updated' : content }] }; },
      close: async () => {},
    });
    const pools = [new TestPool({ sessionPath: join(root, 'parent') }), new TestPool({ sessionPath: join(root, 'child') })];
    for (const pool of pools) {
      await pool.add(client());
      pool.setCollectionCacheScope({ ...scope, workspace: root });
      pool.setSummarizeCallback(async () => { synthesisCalls++; return 'summary of freshly observed collection'; });
    }
    const first = await pools[0]!.callTool('mcp__collection__read_records', { limit: 20 });
    const second = await pools[1]!.callTool('mcp__collection__read_records', { limit: 20 });
    expect(sourceCalls).toBe(2);
    expect(synthesisCalls).toBe(1);
    expect(first.content).toContain(join(root, 'parent'));
    expect(second.content).toContain(join(root, 'child'));
    expect(second.content).not.toContain(join(root, 'parent'));
    const saved = readdirSync(join(root, 'child', 'long_responses'))[0]!;
    expect(readFileSync(join(root, 'child', 'long_responses', saved), 'utf8')).toContain(content);
    content += 'source changed';
    await pools[1]!.callTool('mcp__collection__read_records', { limit: 20 });
    expect(synthesisCalls).toBe(2);
    await pools[0]!.callTool('mcp__collection__update_record', {});
    await pools[1]!.callTool('mcp__collection__read_records', { limit: 20 });
    expect(synthesisCalls).toBe(3);
    pools[1]!.setCollectionCacheScope({ ...scope, workspace: root, freshEvidence: true });
    await pools[1]!.callTool('mcp__collection__read_records', { limit: 20 });
    expect(synthesisCalls).toBe(4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
