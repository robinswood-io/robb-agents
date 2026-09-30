import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { AuthStorage, ModelRegistry, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { AgentEvent, Message } from '@craft-agent/core/types';
import { PiAgent } from '../../shared/src/agent/pi-agent.ts';
import { registerSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from '../../shared/src/agent/session-scoped-tool-callback-registry.ts';
import type { BrowserPaneFns } from '../../shared/src/agent/browser-tools.ts';
import { PiEventAdapter } from '../../shared/src/agent/backend/pi/event-adapter.ts';
import { hasObjectiveSubstantiveToolResult, isObjectiveToolExecutedSuccessfully } from '../../server-core/src/sessions/objective-contract.ts';
import { installStructuredToolErrors } from './structured-tool-errors.ts';

const captureError = 'Canvas capture unavailable: selector, visibility, transform, clipping, origin or bitmap limit was not satisfied. No page screenshot was substituted.';

it('real browser backend failure remains an error through the real Pi loop, model context and host adapter', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-capture-error-'));
  const sessionId = 'proxy-capture-error-fixture';
  let session: AgentSession | undefined;
  let captures = 0;
  try {
    // The real backend branch uses only these callbacks on the error path.
    // Avoid constructing providers, watchers or a production-profile backend.
    const backend = Object.assign(Object.create(PiAgent.prototype), { _sessionId: sessionId }) as {
      executeSessionTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
    };
    registerSessionScopedToolCallbacks(sessionId, { browserPaneFns: {
      screenshotRegion: async () => { captures++; throw new Error(captureError); },
    } as unknown as BrowserPaneFns });
    const authStorage = AuthStorage.inMemory(); authStorage.set('openai', { type: 'api_key', key: 'fixture-no-network' });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const sessionManager = SessionManager.inMemory(directory);
    const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const model = modelRegistry.find('openai', 'gpt-5.5')!;
    const adapter = new PiEventAdapter(); const adapted: AgentEvent[] = [];
    const toolName = 'mcp__session__browser_tool';
    let backendResponse: { content: string; isError: boolean } | undefined;
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, authStorage, modelRegistry,
      settingsManager, sessionManager, resourceLoader, model, tools: [toolName], customTools: [{
        name: toolName, label: 'Capture fixture', description: 'Read-only canvas capture fixture',
        parameters: Type.Object({ command: Type.Array(Type.String()) }),
        execute: async (_id, input) => {
          backendResponse = await backend.executeSessionTool('browser_tool', input);
          // Exact result envelope emitted by both buildProxyTools paths.
          return { content: [{ type: 'text', text: backendResponse.content }], details: { isError: backendResponse.isError } };
        },
      }] }));
    installStructuredToolErrors(session);
    let requests = 0; let modelError: boolean | undefined; let modelContent: unknown;
    session.agent.streamFn = (_model, context) => {
      const receipt = context.messages.find(message => message.role === 'toolResult');
      if (receipt?.role === 'toolResult') { modelError = receipt.isError; modelContent = receipt.content; }
      const reason = ++requests === 1 ? 'toolUse' : 'stop';
      const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: reason === 'toolUse' ? [{ type: 'toolCall', id: 'capture', name: toolName,
          arguments: { command: ['screenshot-region', '--canvas', '--selector', 'canvas[width="1216"][height="896"]'] } }]
          : [{ type: 'text', text: 'Capture could not be obtained.' }],
        stopReason: reason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
          totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason, message }); stream.end(); return stream;
    };
    session.subscribe(event => adapted.push(...adapter.adaptEvent(event)));
    await session.prompt('Read this canvas once. Report an unavailable image without fabricating evidence.');
    const result = adapted.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
    expect(captures).toBe(1); expect(requests).toBe(2);
    expect(backendResponse).toEqual({ content: captureError, isError: true });
    expect(result?.result).toBe(captureError);
    expect(modelContent).toEqual([{ type: 'text', text: captureError }]);
    expect(result?.executed).not.toBe(false); // A failed observation was attempted; not a checkpoint.
    expect(modelError).toBe(true);
    expect(result?.isError).toBe(true);
    const persisted: Message = { id: 'r', role: 'tool', content: '', timestamp: 1, toolUseId: 'capture', toolName,
      toolResult: result!.result, toolStatus: result!.isError ? 'error' : 'completed',
      isError: result!.isError, toolExecuted: result!.executed !== false };
    expect(persisted.toolExecuted).toBe(true);
    expect(isObjectiveToolExecutedSuccessfully(persisted)).toBe(false);
    expect(hasObjectiveSubstantiveToolResult(persisted)).toBe(false);
  } finally {
    session?.dispose(); unregisterSessionScopedToolCallbacks(sessionId); rmSync(directory, { recursive: true, force: true });
  }
});

it('preserves prior hook payloads and only promotes explicit boolean errors', async () => {
  const payload = { content: [{ type: 'text' as const, text: '{"ok":false}' },
    { type: 'image' as const, data: 'image-data', mimeType: 'image/png' }],
    details: { executed: false, executionBlocker: { kind: 'permission' }, checkpoint: { kind: 'tool-call-budget' } }, terminate: true };
  for (const marker of [undefined, false, 'true', 1, true]) {
    let calls = 0;
    const prior = { ...payload, isError: false };
    const agent = { afterToolCall: async () => { calls++; return prior; } };
    installStructuredToolErrors({ agent } as unknown as Pick<AgentSession, 'agent'>);
    installStructuredToolErrors({ agent } as unknown as Pick<AgentSession, 'agent'>);
    const context = { isError: false, result: { content: [{ type: 'text', text: captureError }], details: { isError: marker } } };
    const result = await (agent.afterToolCall as Function)(context);
    expect(calls).toBe(1);
    expect(result).toEqual({ ...prior, isError: marker === true });
    expect(result.content).toBe(payload.content); expect(result.details).toBe(payload.details);
    expect(context.result.details.isError).toBe(marker);
  }
});

it('never clears SDK errors and preserves a non-error checkpoint without interpreting its text', async () => {
  for (const context of [
    { isError: true, result: { content: [{ type: 'text', text: '' }], details: {} } },
    { isError: false, result: { content: [{ type: 'text', text: captureError }], details: { executed: false, continuationRequired: true, checkpoint: { kind: 'tool-call-budget' } } } },
  ]) {
    const agent = { afterToolCall: async () => undefined };
    installStructuredToolErrors({ agent } as unknown as Pick<AgentSession, 'agent'>);
    expect(await (agent.afterToolCall as Function)(context)).toEqual(context.isError ? { isError: true } : undefined);
  }
});

it('preserves the original failure even if the previous hook mutates its details', async () => {
  const context = { isError: false, result: { content: [], details: { isError: true } } };
  const agent = { afterToolCall: async () => { context.result.details.isError = false; return { isError: false }; } };
  installStructuredToolErrors({ agent } as unknown as Pick<AgentSession, 'agent'>);
  expect(await (agent.afterToolCall as Function)(context)).toEqual({ isError: true });
});

it('propagates a failure added in place by the previous hook even without a returned override', async () => {
  for (const field of ['details', 'isError']) {
    const context = { isError: false, result: { content: [], details: { isError: false } } };
    const agent = { afterToolCall: async () => {
      if (field === 'details') context.result.details.isError = true;
      else context.isError = true;
      return undefined;
    } };
    installStructuredToolErrors({ agent } as unknown as Pick<AgentSession, 'agent'>);
    expect(await (agent.afterToolCall as Function)(context)).toEqual({ isError: true });
  }
});

it('direct adapter fallback preserves checkpoints and never infers an error from content alone', () => {
  for (const marker of [undefined, false, 'true', 1, true]) {
    const adapter = new PiEventAdapter();
    [...adapter.adaptEvent({ type: 'tool_execution_start', toolCallId: 'direct', toolName: 'mcp__session__browser_tool', args: {} })];
    const result = [...adapter.adaptEvent({ type: 'tool_execution_end', toolCallId: 'direct', toolName: 'mcp__session__browser_tool',
      isError: false, result: { content: [{ type: 'text', text: captureError }], details: {
        isError: marker, executed: false, continuationRequired: true,
        checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'fixture only' },
        executionBlocker: { kind: 'permission' },
      } } })].find(event => event.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', isError: marker === true, result: captureError,
      executed: false, continuationRequired: true, checkpoint: { schemaVersion: 1, kind: 'tool-call-budget', reason: 'fixture only' } });
  }
});
