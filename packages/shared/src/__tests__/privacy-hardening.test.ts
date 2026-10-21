import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
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
    }) as typeof fetch;

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
      { enabled: true, condensed: false },
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
    await import('../unified-network-interceptor.ts');
    process.env.CRAFT_STRICT_LOCAL_ENDPOINT = '1';
    delete process.env.ROBB_ALLOW_LOCAL_MODEL_WEB_TOOLS;

    await expect(
      globalThis.fetch('https://agents.craft.do/docs/mcp'),
    ).rejects.toThrow('[Privacy Guard] Blocked outbound network request');
  });
});
