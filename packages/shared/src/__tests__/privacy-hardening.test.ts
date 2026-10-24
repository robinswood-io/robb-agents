import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLatestVersion, getManifest } from '../version/manifest.ts';
import { getSystemPrompt } from '../prompts/system.ts';

const REPO_ROOT = join(import.meta.dir, '../../../..');

const ORIGINAL_ENV = {
  ROBB_ALLOW_CRAFT_VERSION_MANIFEST: process.env.ROBB_ALLOW_CRAFT_VERSION_MANIFEST,
  CRAFT_DEBUG: process.env.CRAFT_DEBUG,
  CRAFT_FEATURE_DEVELOPER_FEEDBACK: process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK,
  CRAFT_STRICT_LOCAL_ENDPOINT: process.env.CRAFT_STRICT_LOCAL_ENDPOINT,
  ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS: process.env.ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS,
};

afterEach(() => {
  for (const [key, val] of Object.entries(ORIGINAL_ENV)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
});

describe('Robb Agent privacy & confidentiality hardening', () => {
  it('blocks external Craft version manifest phone-home by default', async () => {
    delete process.env.ROBB_ALLOW_CRAFT_VERSION_MANIFEST;
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const latest = await getLatestVersion();
      const manifest = await getManifest('0.11.4');
      expect(latest).toBeNull();
      expect(manifest).toBeNull();
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('removes external craft-agents-docs instructions and gates developer feedback prompt in system prompt', () => {
    process.env.CRAFT_DEBUG = '1';
    delete process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK;

    const prompt = getSystemPrompt(
      undefined,
      { enabled: true },
      '/tmp/test-workspace',
      '/tmp/test-workspace',
    );

    expect(prompt).not.toContain('Search `craft-agents-docs`');
    expect(prompt).not.toContain('send_developer_feedback');
  });

  it('removes Sentry telemetry from Electron renderer, preload, and event processor', () => {
    const rendererMain = readFileSync(join(REPO_ROOT, 'apps/electron/src/renderer/main.tsx'), 'utf8');
    const eventProcessor = readFileSync(join(REPO_ROOT, 'apps/electron/src/renderer/event-processor/useEventProcessor.ts'), 'utf8');
    const inputBoundary = readFileSync(join(REPO_ROOT, 'apps/electron/src/renderer/components/app-shell/input/InputErrorBoundary.tsx'), 'utf8');
    const preloadBootstrap = readFileSync(join(REPO_ROOT, 'apps/electron/src/preload/bootstrap.ts'), 'utf8');

    expect(rendererMain).not.toContain('@sentry/electron');
    expect(rendererMain).not.toContain('captureConsoleIntegration');
    expect(eventProcessor).not.toContain('@sentry/electron');
    expect(eventProcessor).not.toContain('Sentry.captureException');
    expect(inputBoundary).not.toContain('@sentry/electron');
    expect(inputBoundary).not.toContain('Sentry.captureException');
    expect(preloadBootstrap).not.toContain('@sentry/electron');
  });

  it('enforces loopback-only fetch guard in unified-network-interceptor when CRAFT_STRICT_LOCAL_ENDPOINT=1', async () => {
    // Auto-install is a process-start contract. Other suites intentionally disable
    // it or replace fetch, so exercise a fresh runtime with an offline transport.
    const moduleUrl = new URL('../unified-network-interceptor.ts', import.meta.url).href;
    const script = `
      let networkCalls = 0;
      globalThis.fetch = async () => { networkCalls += 1; return new Response('offline fixture'); };
      await import(${JSON.stringify(moduleUrl)});
      try {
        await globalThis.fetch('https://agents.craft.do/docs/mcp');
        console.log(JSON.stringify({ blocked: false, networkCalls }));
      } catch (error) {
        console.log(JSON.stringify({ blocked: true, networkCalls, message: error.message }));
      }
    `;
    const directory = mkdtempSync(join(tmpdir(), 'robb-fetch-guard-'));
    const config = join(directory, 'bunfig.toml');
    writeFileSync(config, '');
    try {
      const child = Bun.spawnSync([process.execPath, `--config=${config}`, '--no-env-file', '--eval', script], {
        env: { ...process.env, CRAFT_DEBUG: '0', CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL: '0',
          CRAFT_STRICT_LOCAL_ENDPOINT: '1', ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS: '0' },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(child.exitCode).toBe(0);
      const result: { blocked: boolean; networkCalls: number; message?: string } = JSON.parse(child.stdout.toString());
      expect(result.blocked).toBe(true);
      expect(result.networkCalls).toBe(0);
      expect(result.message).toContain('[Privacy Guard] Blocked outbound network request');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
