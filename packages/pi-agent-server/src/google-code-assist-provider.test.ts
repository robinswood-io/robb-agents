import { describe, expect, it, mock } from 'bun:test';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai';
import { registerGoogleCodeAssistProvider, streamGoogleCodeAssist } from './google-code-assist-provider.ts';

function sseResponse(payloads: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('');
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), { status: 200 });
}

describe('Google Code Assist provider', () => {
  it('registers Gemini models under the subscription OAuth provider', () => {
    const auth = AuthStorage.inMemory({
      'google-gemini-code-assist': { type: 'api_key', key: 'test-access-token' },
    });
    const registry = ModelRegistry.inMemory(auth);

    registerGoogleCodeAssistProvider(registry);

    const model = registry.find('google-gemini-code-assist', 'gemini-2.5-flash');
    expect(model).toBeDefined();
    expect(model?.api).toBe('google-code-assist');
    expect(model?.provider).toBe('google-gemini-code-assist');
    expect(registry.getAvailable().filter(m => m.provider === 'google-gemini-code-assist').map(m => m.id)).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3-flash-preview',
    ]);
  });

  it('streams text responses from the Code Assist SSE endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({
          currentTier: { id: 'STANDARD', name: 'Gemini Code Assist' },
          cloudaicompanionProject: 'test-project',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(':streamGenerateContent')) {
        return sseResponse([
          {
            traceId: 'trace-1',
            response: {
              candidates: [{ content: { parts: [{ text: 'Bonjour' }] } }],
              usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
            },
          },
          {
            response: {
              candidates: [{ content: { parts: [{ text: ' Gemini' }] }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
            },
          },
        ]);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const auth = AuthStorage.inMemory({
        'google-gemini-code-assist': { type: 'api_key', key: 'test-access-token' },
      });
      const registry = ModelRegistry.inMemory(auth);
      registerGoogleCodeAssistProvider(registry);
      const model = registry.find('google-gemini-code-assist', 'gemini-2.5-flash');
      expect(model).toBeDefined();

      const context: Context = {
        messages: [{ role: 'user', content: 'Dis bonjour', timestamp: Date.now() }],
      };
      const stream = streamGoogleCodeAssist(model!, context, { apiKey: 'test-access-token' });
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const done = events.find((event): event is Extract<AssistantMessageEvent, { type: 'done' }> => event.type === 'done');
      expect(done).toBeDefined();
      expect(done?.message.content).toEqual([{ type: 'text', text: 'Bonjour Gemini' }]);
      expect(done?.message.responseId).toBe('trace-1');
      expect(done?.message.usage.totalTokens).toBe(7);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
