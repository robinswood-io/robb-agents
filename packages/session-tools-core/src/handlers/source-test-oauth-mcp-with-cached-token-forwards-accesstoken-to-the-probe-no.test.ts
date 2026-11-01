import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSourceTest } from "./source-test.ts";
import type { SourceConfig } from "../types.ts";
import { type ValidateMcpCall, createCtx, makeCredentialManager, writeHttpMcpSource } from "./testing/source-test-fixture.ts";

describe('source_test HTTP MCP probe credential forwarding (regression for #720)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-mcp-cred-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('OAuth MCP with cached token forwards accessToken to the probe (no refresh)', async () => {
    writeHttpMcpSource(tempDir, 'oauth-cached', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'oauth',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: 'cached-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true, toolCount: 2 };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'oauth-cached', autoEnable: false });

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('cached-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(0);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'oauth-cached', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('OAuth MCP without cached token falls back to refresh and forwards the fresh token', async () => {
    writeHttpMcpSource(tempDir, 'oauth-refresh', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'oauth',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: null, refreshedToken: 'fresh-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'oauth-refresh', autoEnable: false });

    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('fresh-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(1);
  });

  it('Bearer MCP without headerNames forwards accessToken (defense-in-depth)', async () => {
    writeHttpMcpSource(tempDir, 'bearer-cached', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'bearer',
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: 'bearer-tok' });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'bearer-cached', autoEnable: false });

    expect(calls.length).toBe(1);
    expect(calls[0]?.accessToken).toBe('bearer-tok');
    expect(cred.getTokenCalls).toBe(1);
    expect(cred.refreshCalls).toBe(0);
  });

  it('headerNames flow still merges credential headers, accessToken stays undefined', async () => {
    // Multi-header credential — credential value is a JSON object keyed by header name.
    writeHttpMcpSource(tempDir, 'header-style', {
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test',
        headerNames: ['X-Api-Key'],
      },
    } as Partial<SourceConfig>);

    const cred = makeCredentialManager({ cachedToken: JSON.stringify({ 'X-Api-Key': 'k1' }) });
    const calls: ValidateMcpCall[] = [];
    const ctx = createCtx(tempDir, {
      credentialManager: cred.manager,
      validateMcpConnection: async (config) => {
        calls.push(config);
        return { success: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'header-style', autoEnable: false });

    expect(calls.length).toBe(1);
    expect(calls[0]?.headers).toEqual({ 'X-Api-Key': 'k1' });
    expect(calls[0]?.accessToken).toBeUndefined();
    expect(cred.refreshCalls).toBe(0);
  });
});
