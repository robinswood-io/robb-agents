import { describe, expect, it } from 'bun:test';
import {
  BROWSER_TOOL_TIMEOUT_GRACE_MS,
  BrowserToolExecutionTimeoutError,
  DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS,
  executeBrowserToolCommand,
  resolveBrowserToolExecutionTimeoutMs,
  withBrowserToolExecutionWatchdog,
} from '../browser-tool-runtime.ts';
import { classifyAgentFailure } from '../failure-taxonomy.ts';

describe('browser_tool execution watchdog', () => {
  it('uses a short default for ordinary actions and preserves explicit waits with grace', () => {
    expect(resolveBrowserToolExecutionTimeoutMs(['evaluate', '(async () => {})()']))
      .toBe(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS);
    expect(resolveBrowserToolExecutionTimeoutMs('wait text ready 90000'))
      .toBe(90_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
    expect(resolveBrowserToolExecutionTimeoutMs('wait network-idle 80000'))
      .toBe(80_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
    expect(resolveBrowserToolExecutionTimeoutMs('click @e1 navigation 70000'))
      .toBe(70_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
    expect(resolveBrowserToolExecutionTimeoutMs('downloads wait 65000'))
      .toBe(65_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
    expect(resolveBrowserToolExecutionTimeoutMs('select @e1 CNAME --timeout 75000'))
      .toBe(75_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
    expect(resolveBrowserToolExecutionTimeoutMs('resume'))
      .toBe(120_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
  });

  it('caps excessive and malformed requested timeouts', () => {
    for (const command of [
      'resume 999999999',
      'wait selector body 999999999',
      'downloads wait 999999999',
    ]) {
      expect(resolveBrowserToolExecutionTimeoutMs(command))
        .toBe(MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS);
    }
    expect(resolveBrowserToolExecutionTimeoutMs('wait text ready Infinity'))
      .toBe(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS);
    expect(resolveBrowserToolExecutionTimeoutMs('evaluate "unterminated'))
      .toBe(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS);
  });

  it('clamps finite command timeouts before invoking browser callbacks and rejects non-finite values', async () => {
    const observed: Array<{ command: string; timeoutMs: number | undefined }> = [];
    const fns = {
      evaluate: async () => null,
      detectChallenge: async () => ({ detected: false, provider: '', signals: [] }),
      click: async (_ref: string, args: { timeoutMs?: number }) => {
        observed.push({ command: 'click', timeoutMs: args.timeoutMs });
      },
      waitFor: async (args: { timeoutMs?: number }) => {
        observed.push({ command: 'wait', timeoutMs: args.timeoutMs });
        return { ok: true as const, kind: 'text', elapsedMs: 0, detail: 'ready' };
      },
      select: async () => {},
      snapshot: async () => ({
        url: 'https://example.com',
        title: 'Fixture',
        nodes: [{ ref: '@e1', role: 'combobox', name: 'late', value: 'late' }],
      }),
      getDownloads: async (args: { timeoutMs?: number }) => {
        observed.push({ command: 'downloads wait', timeoutMs: args.timeoutMs });
        return [];
      },
    } as any;

    await executeBrowserToolCommand({
      command: 'click @e1 navigation 999999999',
      fns,
      sessionId: 'bounded-click',
    });
    await executeBrowserToolCommand({
      command: 'wait text ready 999999999',
      fns,
      sessionId: 'bounded-wait',
    });
    const select = await executeBrowserToolCommand({
      command: 'select @e1 late --timeout 999999999',
      fns,
      sessionId: 'bounded-select',
    });
    await executeBrowserToolCommand({
      command: 'downloads wait 999999999',
      fns,
      sessionId: 'bounded-downloads',
    });

    expect(observed).toEqual([
      { command: 'click', timeoutMs: MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS },
      { command: 'wait', timeoutMs: MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS },
      { command: 'downloads wait', timeoutMs: MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS },
    ]);
    expect(select.output).toContain(`timeout=${MAX_BROWSER_TOOL_REQUESTED_TIMEOUT_MS}ms`);
    await expect(executeBrowserToolCommand({
      command: 'wait text ready Infinity',
      fns,
      sessionId: 'non-finite-wait',
    })).rejects.toThrow('Expected a finite number');
    await expect(executeBrowserToolCommand({
      command: 'click @e1 navigation Infinity',
      fns,
      sessionId: 'non-finite-click',
    })).rejects.toThrow('Expected a finite number');
    await expect(executeBrowserToolCommand({
      command: 'select @e1 late --timeout Infinity',
      fns,
      sessionId: 'non-finite-select',
    })).rejects.toThrow('Expected a finite number');
    await expect(executeBrowserToolCommand({
      command: 'downloads wait Infinity',
      fns,
      sessionId: 'non-finite-downloads',
    })).rejects.toThrow('Expected a finite number');
    expect(observed).toHaveLength(3);
  });

  it('never continues a batch after the outer watchdog times out', async () => {
    let releaseWait: ((value: { ok: true; kind: string; elapsedMs: number; detail: string }) => void) | undefined;
    let fillCalls = 0;
    let evaluationCalls = 0;
    const fns = {
      waitFor: async () => new Promise<{ ok: true; kind: string; elapsedMs: number; detail: string }>(resolve => {
        releaseWait = resolve;
      }),
      evaluate: async () => {
        evaluationCalls += 1;
        return null;
      },
      fill: async () => { fillCalls += 1; },
    } as any;
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = ((callback: (...args: any[]) => void) => (
      originalSetTimeout(callback, 1)
    )) as typeof setTimeout;

    try {
      const execution = executeBrowserToolCommand({
        command: 'wait text ready 999999999; fill @e1 late',
        fns,
        sessionId: 'cancelled-batch',
      });
      await expect(execution).rejects.toBeInstanceOf(BrowserToolExecutionTimeoutError);
      releaseWait?.({ ok: true, kind: 'text', elapsedMs: 1, detail: 'late result' });
      await Promise.resolve();
      await Promise.resolve();
      expect(evaluationCalls).toBe(0);
      expect(fillCalls).toBe(0);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }
  });

  it('sums serial batch budgets, adds grace once, and keeps the absolute cap', () => {
    expect(resolveBrowserToolExecutionTimeoutMs(
      'wait text first 90000; wait text second 90000',
    )).toBe(180_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
    expect(resolveBrowserToolExecutionTimeoutMs(
      'wait text first 90000; snapshot',
    )).toBe(90_000 + 45_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
    expect(resolveBrowserToolExecutionTimeoutMs(
      'wait text first 200000; wait text second 200000',
    )).toBe(MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS);
  });

  it('does not reserve time for batch commands after the navigation stop boundary', () => {
    expect(resolveBrowserToolExecutionTimeoutMs(
      'navigate https://example.com; wait text unreachable 300000',
    )).toBe(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS);
    expect(resolveBrowserToolExecutionTimeoutMs(
      'wait text first 90000; click @e1 navigation 70000; wait text unreachable 300000',
    )).toBe(90_000 + 70_000 + BROWSER_TOOL_TIMEOUT_GRACE_MS);
  });

  it('rejects a lost callback with an uncertainty-safe structured error', async () => {
    const never = new Promise<void>(() => {});
    let caught: unknown;
    try {
      await withBrowserToolExecutionWatchdog(never, 15);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowserToolExecutionTimeoutError);
    expect((caught as BrowserToolExecutionTimeoutError).code).toBe('BROWSER_TOOL_EXECUTION_TIMEOUT');
    expect((caught as Error).message).toContain('may have completed');
    expect((caught as Error).message).toContain('Inspect the current browser state before retrying');
    expect(classifyAgentFailure({ message: (caught as Error).message })).toMatchObject({
      failureClass: 'timeout',
      retryability: 'safe',
      recovery: 'retry',
      confidence: 'heuristic',
    });
  });

  it('returns the original result and error before the deadline', async () => {
    await expect(withBrowserToolExecutionWatchdog(Promise.resolve('ok'), 1_000)).resolves.toBe('ok');
    await expect(withBrowserToolExecutionWatchdog(
      Promise.reject(new Error('original browser failure')),
      1_000,
    )).rejects.toThrow('original browser failure');
  });
});
