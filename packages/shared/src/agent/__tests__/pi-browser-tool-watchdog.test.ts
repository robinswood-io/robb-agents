import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { BrowserPaneFns } from '../browser-tools.ts';
import {
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts';

function createConfig(sessionId: string): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'browser-watchdog-workspace',
      name: 'Browser watchdog workspace',
      rootPath: '/tmp/browser-watchdog-workspace',
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/browser-watchdog-workspace',
      workingDirectory: '/tmp/browser-watchdog-workspace',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as never,
    isHeadless: true,
  };
}

describe('Pi browser_tool watchdog bridge', () => {
  it('returns exactly one error response so the subprocess can emit tool_execution_end', async () => {
    const sessionId = `pi-browser-watchdog-${Date.now()}`;
    const agent = new PiAgent(createConfig(sessionId));
    const runtime = { runtimeId: 'pi-browser-watchdog-runtime', sessionId };
    const sent: Array<Record<string, unknown>> = [];
    let resolveLateEvaluation: ((value: unknown) => void) | undefined;

    (agent as any).send = (message: Record<string, unknown>) => sent.push(message);
    (agent as any).subprocessRuntimeContext = runtime;
    (agent as any).prerequisiteManager = {
      checkPrerequisites: () => ({ allowed: true }),
    };
    registerSessionScopedToolCallbacks(sessionId, {
      browserPaneFns: {
        evaluate: async () => new Promise(resolve => {
          resolveLateEvaluation = resolve;
        }),
      } as unknown as BrowserPaneFns,
    });

    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = ((callback: (...args: any[]) => void) => (
      originalSetTimeout(callback, 1)
    )) as typeof setTimeout;

    try {
      expect((agent as any).admitToolExecution({
        toolUseId: 'browser-timeout-tool',
        toolName: 'mcp__session__browser_tool',
        toolInput: {
          command: ['evaluate', '(async () => { location.href = "/next"; await new Promise(() => {}); })()'],
        },
        sessionId,
        runtimeId: runtime.runtimeId,
        authorizationEpoch: 0,
      })).toBe(true);
      await (agent as any).handleToolExecuteRequest({
        requestId: 'browser-timeout-request',
        toolName: 'mcp__session__browser_tool',
        toolCallId: 'browser-timeout-tool',
        args: {
          command: ['evaluate', '(async () => { location.href = "/next"; await new Promise(() => {}); })()'],
        },
      }, runtime);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'tool_execute_response',
        requestId: 'browser-timeout-request',
        result: { isError: true },
      });
      const content = String((sent[0]!.result as { content: string }).content);
      expect(content).toContain('Browser operation timed out');
      expect(content).toContain('may have completed');

      // A late CDP result cannot produce a second protocol response.
      resolveLateEvaluation?.('late result');
      await Promise.resolve();
      await Promise.resolve();
      expect(sent).toHaveLength(1);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
      unregisterSessionScopedToolCallbacks(sessionId);
      agent.destroy();
    }
  });
});
