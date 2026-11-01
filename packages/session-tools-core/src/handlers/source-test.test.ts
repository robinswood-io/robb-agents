import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleSourceTest } from "./source-test.ts";
import type { SourceConfig } from "../types.ts";
import { createCtx, stubMcpFail, stubMcpOk, writeSource } from "./testing/source-test-fixture.ts";

describe('source_test auto-enable', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'source-test-auto-enable-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flips enabled: false → true and calls activation callback on clean run', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });

    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Source auto-enabled in config');
    expect(text).toContain('turn will auto-restart');
    expect(activated).toBe('craft-kb');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('already-enabled source still calls activation callback (session may be stale)', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: true });

    let activated: string | null = null as string | null;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async (slug) => {
        activated = slug;
        return { ok: true, availability: 'next-turn' };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    // No "auto-enabled in config" line because enabled was already true.
    expect(text).not.toContain('auto-enabled in config');
    expect(activated).toBe('craft-kb');
    expect(text).toContain('turn will auto-restart');
  });

  it('autoEnable: false skips both the flag flip and the activation callback', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    let activated = false;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    await handleSourceTest(ctx, { sourceSlug: 'craft-kb', autoEnable: false });

    expect(activated).toBe(false);
    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    // saveSourceConfig still runs (metadata update), but enabled flag must remain false.
    expect(persisted.enabled).toBe(false);
  });

  it('validation errors skip auto-enable entirely (even when autoEnable is default)', async () => {
    writeSource(tempDir, 'broken', { enabled: false });

    let activated = false;
    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpFail(),
      activateSourceInSession: async () => {
        activated = true;
        return { ok: true };
      },
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'broken' });
    const text = result.content[0]?.text ?? '';

    expect(result.isError).toBe(true);
    expect(activated).toBe(false);
    expect(text).not.toContain('auto-enabled in config');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'broken', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(false);
  });

  it('without activateSourceInSession, flag flip still happens with restart hint', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      // activateSourceInSession intentionally undefined
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('auto-enabled in config');
    expect(text).toContain('Restart session to load tools');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('activation failure shows warning but still persists enabled flag', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: false });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: false, reason: 'build failed' }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    expect(text).toContain('session activation failed: build failed');

    const persisted = JSON.parse(
      readFileSync(join(tempDir, 'sources', 'craft-kb', 'config.json'), 'utf-8')
    ) as SourceConfig;
    expect(persisted.enabled).toBe(true);
  });

  it('successful activation reports a single auto-restart message (backend-agnostic)', async () => {
    writeSource(tempDir, 'craft-kb', { enabled: true });

    const ctx = createCtx(tempDir, {
      validateStdioMcpConnection: stubMcpOk(),
      activateSourceInSession: async () => ({ ok: true, availability: 'next-turn' }),
    });

    const result = await handleSourceTest(ctx, { sourceSlug: 'craft-kb' });
    const text = result.content[0]?.text ?? '';

    // Both backends route through the same source_activated + auto_retry machinery
    // now, so the user-visible message is one line — no Claude vs Pi branching.
    expect(text).toContain('turn will auto-restart');
    expect(text).not.toContain('tools available now');
    expect(text).not.toContain('available on your next message');
  });
});
