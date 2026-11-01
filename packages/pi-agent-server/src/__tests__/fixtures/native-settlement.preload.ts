import { mock } from 'bun:test';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import * as promptController from '../../system-prompt-override.ts';

const createSession = sdk.createAgentSession;
const createController = promptController.createSystemPromptController;
let session: sdk.AgentSession | undefined;
let requestCount = 0;
let boundaryCount = 0;
let deferred = false;
let releaseAll = false;
const gates = new Map<number, () => void>();

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const control = message as Record<string, unknown>;
  if (control["type"] === 'fixture_release_all') {
    releaseAll = true;
    for (const release of gates.values()) release();
    gates.clear();
  } else if (control["type"] === 'fixture_release' && typeof control["stage"] === 'number') {
    gates.get(control["stage"])?.();
    gates.delete(control["stage"]);
  }
});

mock.module('../../system-prompt-override.ts', () => ({
  createSystemPromptController: (options: Parameters<typeof createController>[0]) => createController({
    ...options,
    extensionFactories: [...(options.extensionFactories ?? []), pi => {
      pi.on('agent_before_settle', async () => {
        const stage = ++boundaryCount;
        if (stage > 2 || releaseAll) return;
        const released = new Promise<void>(resolve => { gates.set(stage, resolve); });
        process.stdout.write(JSON.stringify({ type: 'fixture_boundary', stage }) + '\n');
        await released;
      });
      pi.on('agent_settled', async () => {
        if (!deferred) {
          deferred = true;
          await session!.prompt('Complete the remaining deferred step');
        }
      });
    }],
  }),
}));

mock.module('@earendil-works/pi-coding-agent', () => ({
  ...sdk,
  createAgentSession: async (...args: Parameters<typeof createSession>) => {
    const created = await createSession(...args);
    session = created.session;
    session.subscribe(event => {
      if (event.type === 'agent_settled') {
        const ids = created.session.sessionManager.getEntries()
          .filter(entry => entry.type === 'message' && entry.message.role === 'assistant')
          .map(entry => entry.id);
        process.stdout.write(JSON.stringify({ type: 'fixture_assistant_entries', ids }) + '\n');
      }
    });
    session.agent.streamFunction = model => {
      const text = ++requestCount === 1 ? 'FIRST_PHASE'
        : requestCount === 2 ? 'DEFERRED_PHASE_DONE' : 'NEXT_REQUEST_DONE';
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        responseId: 'offline-response-' + requestCount,
        content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    };
    return created;
  },
}));
