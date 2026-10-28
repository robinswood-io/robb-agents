import { createMockFns } from "./testing/browser-tools-fixture.ts";
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
    workspace: { slug: 'test-workspace', createdAt: 1,
      id: 'browser-watchdog-workspace',
      name: 'Browser watchdog workspace',
      rootPath: '/tmp/browser-watchdog-workspace',
    },
    session: {
      id: sessionId,
      workspaceRootPath: '/tmp/browser-watchdog-workspace',
      workingDirectory: '/tmp/browser-watchdog-workspace',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    },
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

    agent['send'] = (message: Record<string, unknown>) => { sent.push(message); return true; };
    agent['subprocessRuntimeContext'] = runtime;
    agent['prerequisiteManager'].checkPrerequisites = () => ({ allowed: true });
    registerSessionScopedToolCallbacks(sessionId, {
      browserPaneFns: Object.assign(createMockFns(), ({evaluate: async () => new Promise(resolve => {
          resolveLateEvaluation = resolve;
        })} satisfies Partial<BrowserPaneFns>)),
    });

    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => (
      originalSetTimeout(callback, 1)
    )) as typeof setTimeout;

    try {
      expect(agent['admitToolExecution']({
        toolUseId: 'browser-timeout-tool',
        toolName: 'mcp__session__browser_tool',
        toolInput: {
          command: ['evaluate', '(async () => { location.href = "/next"; await new Promise(() => {}); })()'],
        },
        sessionId,
        runtimeId: runtime.runtimeId,
        authorizationEpoch: 0,
      })).toBe(true);
      await agent.handleToolExecuteRequest({
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
      const content = String((sent[0]!["result"] as { content: string }).content);
      expect(content).toContain('Browser operation timed out');
      expect(content).toContain('may have completed');

      // A late CDP result cannot produce a second protocol response.
      resolveLateEvaluation?.('late result');
      await Promise.resolve();
      await Promise.resolve();
      expect(sent).toHaveLength(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      unregisterSessionScopedToolCallbacks(sessionId);
      agent.destroy();
    }
  });
});
