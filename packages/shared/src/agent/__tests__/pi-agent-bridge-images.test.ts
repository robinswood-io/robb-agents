import { describe, expect, it, mock } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { FileAttachment } from '../../utils/files.ts';
import { i18n, setupI18n } from '../../i18n/index.ts';

setupI18n();

function agentFor(provider: string) {
  const agent = Object.create(PiAgent.prototype) as any;
  agent.config = { runtime: { piAuthProvider: provider } };
  agent.eventQueue = { reset: mock(() => {}) };
  agent.adapter = { startTurn: mock(() => {}) };
  agent.emitAutomationEvent = mock(() => {});
  agent.ensureSubprocess = mock(async () => { throw new Error('offline-subprocess-boundary'); });
  agent.send = mock(() => {});
  agent.debug = mock(() => {});
  agent.parsePiError = () => ({ code: 'unknown_error' });
  return agent;
}

async function runChat(provider: string, attachments: FileAttachment[]) {
  const agent = agentFor(provider);
  const events = [];
  for await (const event of agent.chatImpl('Inspect the attachment.', attachments)) events.push(event);
  return { agent, events };
}

const image: FileAttachment = {
  type: 'image', mimeType: 'image/png', base64: 'b2ZmbGluZQ==',
  name: 'example.png', path: '/offline/example.png', size: 7,
};

describe('external agent bridge image input', () => {
  for (const [provider, name] of [['google-antigravity', 'Antigravity'], ['mistral-vibe', 'Mistral Vibe']] as const) {
    for (const attachment of [
      image,
      { ...image, type: 'unknown' as const },
      { ...image, mimeType: 'application/octet-stream', base64: undefined },
    ]) {
      it(`rejects ${provider} images identified by ${attachment.type}/${attachment.mimeType} before subprocess creation`, async () => {
        const { agent, events } = await runChat(provider, [attachment]);
        expect(agent.ensureSubprocess).not.toHaveBeenCalled();
        expect(agent.send).not.toHaveBeenCalled();
        expect(agent._isProcessing).toBe(false);
        expect(events).toEqual([
          { type: 'error', message: i18n.t('errors.bridgeImagesUnsupported', { provider: name }) },
          { type: 'complete' },
        ]);
      });
    }

    it(`allows ${provider} text attachments to reach the subprocess boundary`, async () => {
      const { agent, events } = await runChat(provider, [{
        type: 'text', mimeType: 'text/plain', path: '/offline/example.txt', name: 'example.txt', size: 7,
      }]);
      expect(agent.ensureSubprocess).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual({ type: 'error', message: 'offline-subprocess-boundary' });
    });
  }

  it('preserves native Pi image delivery', async () => {
    const { agent, events } = await runChat('openai', [image]);
    expect(agent.ensureSubprocess).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: 'error', message: 'offline-subprocess-boundary' });
  });
});
