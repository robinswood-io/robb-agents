import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAuthenticatedModelRuntime } from './authenticated-model-runtime.ts';
import { createSystemPromptController } from './system-prompt-override.ts';

it('keeps current Robb instructions across native turns and tool changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'robb-prompt-'));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const { modelRuntime, modelRegistry } = await createAuthenticatedModelRuntime(new InMemoryCredentialStore(), {
    provider: 'openai', credential: { type: 'api_key', key: 'offline-fixture' },
  });
  const controller = await createSystemPromptController({
    cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  const model = modelRegistry.find('openai', 'gpt-5.5')!;
  const { session } = await createAgentSession({
    cwd: directory, agentDir: directory, modelRuntime, model, settingsManager,
    sessionManager: SessionManager.inMemory(directory), resourceLoader: controller.resourceLoader, tools: [],
  });
  const prompts: string[] = [];
  session.agent.streamFunction = (_model, context) => {
    const system = context.messages.find(message => message.role === 'system');
    prompts.push(system?.role === 'system'
      ? typeof system.content === 'string' ? system.content : system.content.map(part => part.text).join('\n')
      : '');
    const message: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'fixture complete' }], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
    return stream;
  };
  try {
    controller.setPrompt('ROBB FIRST INSTRUCTIONS');
    await session.prompt('First fixture');
    session.setActiveToolsByName([]);
    await session.prompt('Second fixture');
    controller.setPrompt('ROBB UPDATED INSTRUCTIONS');
    await session.prompt('Third fixture');
    expect(prompts).toEqual(['ROBB FIRST INSTRUCTIONS', 'ROBB FIRST INSTRUCTIONS', 'ROBB UPDATED INSTRUCTIONS']);
  } finally {
    session.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
