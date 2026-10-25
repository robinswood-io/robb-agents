import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, Type, createAssistantMessageEventStream,
  type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAuthenticatedModelRuntime } from './authenticated-model-runtime.ts';
import { createSystemPromptController } from './system-prompt-override.ts';
import { abortSessionWithPendingApprovals, type PendingToolApproval,
  type ToolApprovalResponse } from './tool-approval-abort.ts';

it('cancels a blocked permission before SDK abort waits for the tool, then accepts the next request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'robb-abort-approval-'));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const { modelRuntime, modelRegistry } = await createAuthenticatedModelRuntime(new InMemoryCredentialStore(), {
    provider: 'openai', credential: { type: 'api_key', key: 'offline-fixture' },
  });
  const controller = await createSystemPromptController({
    cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  const model = modelRegistry.find('openai', 'gpt-5.5')!;
  const pending = new Map<string, PendingToolApproval>();
  const entered = Promise.withResolvers<void>();
  let effects = 0;
  const { session } = await createAgentSession({
    cwd: directory, agentDir: directory, modelRuntime, model, settingsManager,
    sessionManager: SessionManager.inMemory(directory), resourceLoader: controller.resourceLoader,
    tools: ['mcp__fixture__approval'], customTools: [{
      name: 'mcp__fixture__approval', label: 'Permission fixture', description: 'Offline fixture',
      parameters: Type.Object({}),
      execute: async id => {
        const decision = await new Promise<ToolApprovalResponse>(resolve => {
          pending.set(id, { resolve });
          entered.resolve();
        });
        if (decision.action === 'block') throw new Error(decision.reason);
        effects += 1;
        return { content: [{ type: 'text', text: 'executed' }], details: {} };
      },
    }],
  });
  expect(session.getActiveToolNames()).toContain('mcp__fixture__approval');
  let answerNextRequest = false;
  let modelCalls = 0;
  session.agent.streamFunction = () => {
    modelCalls += 1;
    const returnAnswer = answerNextRequest || modelCalls > 1;
    const reason = returnAnswer ? 'stop' : 'toolUse';
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: returnAnswer ? [{ type: 'text', text: 'NEXT_REQUEST_DONE' }]
        : [{ type: 'toolCall', id: 'approval-1', name: 'mcp__fixture__approval', arguments: {} }],
      stopReason: reason, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason, message });
    stream.end();
    return stream;
  };
  const running = session.prompt('Wait for permission');
  let stopping: Promise<void> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('Tool did not request permission'); })]);
    expect(pending.size).toBe(1);
    stopping = abortSessionWithPendingApprovals(session, pending);
    const stopped = await Promise.race([
      stopping.then(() => 'settled'),
      new Promise<string>(resolve => { timeout = setTimeout(() => resolve('blocked'), 500); }),
    ]);
    expect(stopped).toBe('settled');
    await running;
    expect(session.isIdle).toBe(true);
    expect(effects).toBe(0);
    expect(pending.size).toBe(0);
    answerNextRequest = true;
    await session.prompt('A new request');
    expect(session.getLastAssistantText()).toBe('NEXT_REQUEST_DONE');
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const request of pending.values()) request.resolve({ action: 'block', reason: 'Fixture cleanup' });
    pending.clear();
    await session.abort();
    await running;
    await stopping;
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
