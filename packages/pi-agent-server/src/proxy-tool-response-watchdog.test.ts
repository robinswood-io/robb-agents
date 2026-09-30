import { describe, expect, it } from 'bun:test';
import {
  PI_BROWSER_TOOL_RESPONSE_GRACE_MS,
  resolveProxyToolResponseWatchdogTimeoutMs,
  waitForProxyToolResponse,
  type PendingProxyToolExecution,
} from './proxy-tool-response-watchdog.ts';
import {
  DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS,
} from '../../shared/src/agent/browser-tool-execution-watchdog.ts';

describe('Pi proxy tool response watchdog', () => {
  it('tracks the main-process browser budget and keeps malformed inputs on the ordinary deadline', () => {
    const browserTool = 'mcp__session__browser_tool';
    expect(resolveProxyToolResponseWatchdogTimeoutMs(browserTool, { command: 'snapshot' }))
      .toBe(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS + PI_BROWSER_TOOL_RESPONSE_GRACE_MS);
    expect(resolveProxyToolResponseWatchdogTimeoutMs(browserTool, { command: 'wait text ready 90000' }))
      .toBe(110_000);
    expect(resolveProxyToolResponseWatchdogTimeoutMs(browserTool, {
      command: 'navigate https://example.com; wait text unreachable 300000',
    })).toBe(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS + PI_BROWSER_TOOL_RESPONSE_GRACE_MS);
    expect(resolveProxyToolResponseWatchdogTimeoutMs(browserTool, { command: 'wait text ready 999999999' }))
      .toBe(MAX_BROWSER_TOOL_EXECUTION_TIMEOUT_MS + PI_BROWSER_TOOL_RESPONSE_GRACE_MS);
    for (const args of [undefined, {}, { command: [] }, { command: 60_000 },
      { command: '' }, { command: 'evaluate "unterminated' }]) {
      expect(resolveProxyToolResponseWatchdogTimeoutMs(browserTool, args))
        .toBe(DEFAULT_BROWSER_TOOL_EXECUTION_TIMEOUT_MS + PI_BROWSER_TOOL_RESPONSE_GRACE_MS);
    }
    expect(resolveProxyToolResponseWatchdogTimeoutMs('mcp__other__read', { command: 'snapshot' }))
      .toBeUndefined();
  });

  it('registers before dispatch and removes a timed-out browser request', async () => {
    const pending = new Map<string, PendingProxyToolExecution>();
    let registeredAtDispatch = false;

    const result = await waitForProxyToolResponse({
      pending,
      requestId: 'lost-browser-response',
      toolName: 'mcp__session__browser_tool',
      watchdogTimeoutMs: 15,
      dispatch: () => {
        registeredAtDispatch = pending.has('lost-browser-response');
      },
    });

    expect(registeredAtDispatch).toBeTrue();
    expect(result.isError).toBeTrue();
    expect(result.content).toContain('Browser operation timed out');
    expect(result.content).toContain('may have completed');
    expect(pending.size).toBe(0);
  });

  it('settles once and removes a request when the main process replies', async () => {
    const pending = new Map<string, PendingProxyToolExecution>();
    const response = waitForProxyToolResponse({
      pending,
      requestId: 'browser-response',
      toolName: 'mcp__session__browser_tool',
      watchdogTimeoutMs: 1_000,
      dispatch: () => {},
    });

    pending.get('browser-response')!.resolve({
      content: 'snapshot receipt',
      isError: false,
      structuredContent: { receipt: 'snapshot receipt' },
    });

    await expect(response).resolves.toEqual({
      content: 'snapshot receipt',
      isError: false,
      structuredContent: { receipt: 'snapshot receipt' },
    });
    expect(pending.size).toBe(0);
  });

  it('cleans up if dispatch itself fails', async () => {
    const pending = new Map<string, PendingProxyToolExecution>();
    const response = waitForProxyToolResponse({
      pending,
      requestId: 'dispatch-failure',
      toolName: 'mcp__session__browser_tool',
      watchdogTimeoutMs: 1_000,
      dispatch: () => { throw new Error('broken stdout'); },
    });

    await expect(response).rejects.toThrow('broken stdout');
    expect(pending.size).toBe(0);
  });
});
