import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSourceTest } from "./source-test.ts";
import type { SourceConfig } from "../types.ts";
import { createCtx, makeCredentialManager } from "./testing/source-test-fixture.ts";

describe('source_test basic-auth header (regression for #824)', () => {
  let tempDir: string;

  const origFetch = globalThis.fetch;

  let captured: { url: string; init: RequestInit } | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-basic-'));
    captured = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeBasicAuthSource(slug: string): void {
    const sourcePath = join(tempDir, 'sources', slug);
    mkdirSync(sourcePath, { recursive: true });
    const config = {
      id: slug,
      slug,
      name: `Test ${slug}`,
      enabled: true,
      provider: 'test',
      type: 'api',
      tagline: 'Basic auth API source',
      icon: '🧪',
      isAuthenticated: true,
      api: {
        baseUrl: 'https://api.example.test',
        authType: 'basic',
        testEndpoint: { method: 'GET', path: '/ping' },
      },
    } as unknown as SourceConfig;
    writeFileSync(join(sourcePath, 'config.json'), JSON.stringify(config, null, 2));
    writeFileSync(
      join(sourcePath, 'guide.md'),
      '# Guide\n\nThis is a longer guide with more than fifty words so the validator does not warn about the guide being too short for the readability criteria the tool enforces when evaluating source completeness for this test suite which is only here to exercise the basic-auth header path and not the completeness check.'
    );
  }

  function authHeader(): string | undefined {
    const h = captured?.init.headers as Record<string, string> | undefined;
    return h?.['Authorization'];
  }

  it('JSON {username,password} token → base64-encoded header', async () => {
    writeBasicAuthSource('json-basic');
    const cred = makeCredentialManager({
      cachedToken: JSON.stringify({ username: 'u', password: 'p' }),
    });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'json-basic', autoEnable: false });

    expect(authHeader()).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('already-base64 token → passed through unchanged', async () => {
    writeBasicAuthSource('legacy-basic');
    const encoded = Buffer.from('u:p').toString('base64');
    const cred = makeCredentialManager({ cachedToken: encoded });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'legacy-basic', autoEnable: false });

    expect(authHeader()).toBe(`Basic ${encoded}`);
  });

  it('non-JSON, non-base64 token → passed through unchanged (no throw)', async () => {
    writeBasicAuthSource('garbage-basic');
    const cred = makeCredentialManager({ cachedToken: 'not-json' });
    const ctx = createCtx(tempDir, { credentialManager: cred.manager });

    await handleSourceTest(ctx, { sourceSlug: 'garbage-basic', autoEnable: false });

    expect(authHeader()).toBe('Basic not-json');
  });
});
