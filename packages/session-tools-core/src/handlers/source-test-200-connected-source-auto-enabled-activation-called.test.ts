import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSourceTest } from "./source-test.ts";
import type { SourceConfig } from "../types.ts";
import { createCtx, ctx_for, installFetchStub, writeApiSource } from "./testing/source-test-fixture.ts";

describe('source_test API connection branches', () => {
  let tempDir: string;

  let restoreFetch: () => void = () => {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-api-conn-'));
  });

  afterEach(() => {
    restoreFetch();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('200 → connected, source auto-enabled, activation called', async () => {
    writeApiSource(tempDir, 'good-api', { connectionError: 'Previous authentication failure' });
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 200 })));

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'good-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed');
    expect(text).not.toContain('Skipping activation');
    expect(activated).toBe('good-api');

    const persisted: unknown = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'good-api', 'config.json'), 'utf-8')
    );
    expect(persisted).toMatchObject({ enabled: true, connectionStatus: 'connected' });
    expect(persisted).not.toHaveProperty('connectionError');
  });

  it('500 → disconnected, NOT auto-enabled, activation NOT called', async () => {
    writeApiSource(tempDir, 'flaky-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 500 })));

    let activated = false;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'flaky-api' });
    const text = result.content[0]?.text ?? '';

    // The summary line must not be "✓ Validation passed" alone — it must be
    // the warnings variant, because the probe got a non-2xx the probe couldn't
    // classify as healthy.
    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 500');
    expect(text).toContain('Skipping activation');

    expect(activated).toBe(false);

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'flaky-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    // The enabled flag must not be flipped on a failed probe.
    expect(persisted.enabled).toBe(false);
    expect(persisted.connectionStatus).toBe('disconnected');
  });

  it('404 → disconnected, NOT auto-enabled, activation NOT called', async () => {
    writeApiSource(tempDir, 'wrong-path-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 404 })));

    let activated = false;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'wrong-path-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('Validation passed with warnings');
    expect(text).toContain('API returned 404');
    expect(text).toContain('Skipping activation');
    expect(activated).toBe(false);
  });

  it('401 → connected (auth-required), auto-enabled (refresh path runs)', async () => {
    // 401 from an unauthenticated probe is mapped to "reachable, needs auth".
    // The token-refresh case in checkAuthStatus relies on this — gating on
    // connectionStatus must not break it.
    writeApiSource(tempDir, 'auth-needed-api');
    ({ restore: restoreFetch } = installFetchStub(() => new Response(null, { status: 401 })));

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'auth-needed-api' });
    const text = result.content[0]?.text ?? '';

    expect(text).not.toContain('Skipping activation');
    expect(activated).toBe('auth-needed-api');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'auth-needed-api', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
    expect(persisted.connectionStatus).toBe('connected');
  });

  it('basic probe honors testEndpoint.method (no HEAD→GET fallback dance)', async () => {
    // Regression for the HEAD→GET-on-405 fallback that silently passed POST-only
    // endpoints. With a configured method, the basic probe must call it directly.
    writeApiSource(tempDir, 'post-only-api', {
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'none',
        testEndpoint: { method: 'POST', path: '/v1/things' },
      },
    } as Partial<SourceConfig>);

    let stub: ReturnType<typeof installFetchStub>;
    stub = installFetchStub(() => new Response(null, { status: 200 }));
    restoreFetch = stub.restore;

    await handleSourceTest(ctx_for(tempDir), { sourceSlug: 'post-only-api' });

    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.init?.method).toBe('POST');
    expect(stub.calls[0]?.url).toBe('https://api.example.test/v1/things');
  });
});
