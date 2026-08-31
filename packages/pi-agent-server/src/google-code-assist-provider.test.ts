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

  it('onboards an allowed organization tier when the personal tier is ineligible', async () => {
    const originalFetch = globalThis.fetch;
    const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
    const originalProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({
          allowedTiers: [{
            id: 'standard-tier',
            isDefault: true,
            userDefinedCloudaicompanionProject: true,
          }],
          ineligibleTiers: [{
            reasonMessage: 'This client is no longer supported for Gemini Code Assist for individuals. Please migrate to the Antigravity suite of products.',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(':onboardUser')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          tierId: 'standard-tier',
          cloudaicompanionProject: 'organization-project',
          metadata: { duetProject: 'organization-project' },
        });
        return new Response(JSON.stringify({
          done: true,
          response: { cloudaicompanionProject: { id: 'organization-project' } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(':streamGenerateContent')) {
        return sseResponse([{
          response: {
            candidates: [{ content: { parts: [{ text: 'organization-ok' }] }, finishReason: 'STOP' }],
          },
        }]);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.GOOGLE_CLOUD_PROJECT = 'organization-project';
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;

    try {
      const auth = AuthStorage.inMemory({
        'google-gemini-code-assist': { type: 'api_key', key: 'organization-onboard-access-token' },
      });
      const registry = ModelRegistry.inMemory(auth);
      registerGoogleCodeAssistProvider(registry);
      const model = registry.find('google-gemini-code-assist', 'gemini-2.5-flash');
      const stream = streamGoogleCodeAssist(
        model!,
        { messages: [{ role: 'user', content: 'healthcheck', timestamp: Date.now() }] },
        { apiKey: 'organization-onboard-access-token' },
      );
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);

      const done = events.find(
        (event): event is Extract<AssistantMessageEvent, { type: 'done' }> => event.type === 'done',
      );
      expect(done?.message.content).toEqual([{ type: 'text', text: 'organization-ok' }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = originalProject;
      if (originalProjectId === undefined) delete process.env.GOOGLE_CLOUD_PROJECT_ID;
      else process.env.GOOGLE_CLOUD_PROJECT_ID = originalProjectId;
    }
  });

  it('requires a Google Cloud project before onboarding an organization tier', async () => {
    const originalFetch = globalThis.fetch;
    const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
    const originalProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({
          allowedTiers: [{
            id: 'standard-tier',
            isDefault: true,
            userDefinedCloudaicompanionProject: true,
          }],
          ineligibleTiers: [{
            reasonMessage: 'This client is no longer supported for Gemini Code Assist for individuals. Please migrate to the Antigravity suite of products.',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;

    try {
      const auth = AuthStorage.inMemory({
        'google-gemini-code-assist': { type: 'api_key', key: 'organization-missing-project-access-token' },
      });
      const registry = ModelRegistry.inMemory(auth);
      registerGoogleCodeAssistProvider(registry);
      const model = registry.find('google-gemini-code-assist', 'gemini-2.5-flash');
      const stream = streamGoogleCodeAssist(
        model!,
        { messages: [{ role: 'user', content: 'healthcheck', timestamp: Date.now() }] },
        { apiKey: 'organization-missing-project-access-token' },
      );
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);

      const error = events.find(
        (event): event is Extract<AssistantMessageEvent, { type: 'error' }> => event.type === 'error',
      );
      expect(error?.error.errorMessage).toContain('requires GOOGLE_CLOUD_PROJECT');
      expect(error?.error.errorMessage).toContain('Google AI Studio API key');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = originalProject;
      if (originalProjectId === undefined) delete process.env.GOOGLE_CLOUD_PROJECT_ID;
      else process.env.GOOGLE_CLOUD_PROJECT_ID = originalProjectId;
    }
  });

  it('fails closed with AI Studio guidance when no organization tier is available', async () => {
    const originalFetch = globalThis.fetch;
    const originalProject = process.env.GOOGLE_CLOUD_PROJECT;
    const originalProjectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({
          ineligibleTiers: [{
            reasonMessage: 'This client is no longer supported for Gemini Code Assist for individuals. Please migrate to the Antigravity suite of products.',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT_ID;

    try {
      const auth = AuthStorage.inMemory({
        'google-gemini-code-assist': { type: 'api_key', key: 'individual-access-token' },
      });
      const registry = ModelRegistry.inMemory(auth);
      registerGoogleCodeAssistProvider(registry);
      const model = registry.find('google-gemini-code-assist', 'gemini-2.5-flash');
      const stream = streamGoogleCodeAssist(
        model!,
        { messages: [{ role: 'user', content: 'healthcheck', timestamp: Date.now() }] },
        { apiKey: 'individual-access-token' },
      );
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);

      const error = events.find(
        (event): event is Extract<AssistantMessageEvent, { type: 'error' }> => event.type === 'error',
      );
      expect(error?.error.errorMessage).toContain('no longer available for individual accounts');
      expect(error?.error.errorMessage).toContain('Google AI Studio API key');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = originalProject;
      if (originalProjectId === undefined) delete process.env.GOOGLE_CLOUD_PROJECT_ID;
      else process.env.GOOGLE_CLOUD_PROJECT_ID = originalProjectId;
    }
  });

  it('maps a subscription-required generation response to actionable setup guidance', async () => {
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
        return new Response(JSON.stringify({
          error: {
            code: 403,
            message: 'You do not have a valid license to use Gemini Code Assist.',
            details: [{ reason: 'SUBSCRIPTION_REQUIRED' }],
          },
        }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const auth = AuthStorage.inMemory({
        'google-gemini-code-assist': { type: 'api_key', key: 'expired-license-token' },
      });
      const registry = ModelRegistry.inMemory(auth);
      registerGoogleCodeAssistProvider(registry);
      const model = registry.find('google-gemini-code-assist', 'gemini-2.5-flash');
      const stream = streamGoogleCodeAssist(
        model!,
        { messages: [{ role: 'user', content: 'healthcheck', timestamp: Date.now() }] },
        { apiKey: 'expired-license-token' },
      );
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);

      const error = events.find(
        (event): event is Extract<AssistantMessageEvent, { type: 'error' }> => event.type === 'error',
      );
      expect(error?.error.errorMessage).toContain('did not confirm an active Standard or Enterprise license');
      expect(error?.error.errorMessage).toContain('assign the license to the signed-in account');
      expect(error?.error.errorMessage).not.toContain('expired-license-token');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed before fetch when the v1internal kill switch is active', async () => {
    const originalFetch = globalThis.fetch;
    const originalKillSwitch = process.env.ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL;
    const fetchMock = mock(async () => new Response('{}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL = '1';

    try {
      const auth = AuthStorage.inMemory({
        'google-gemini-code-assist': { type: 'api_key', key: 'must-not-leak' },
      });
      const registry = ModelRegistry.inMemory(auth);
      registerGoogleCodeAssistProvider(registry);
      const model = registry.find('google-gemini-code-assist', 'gemini-2.5-flash');
      const stream = streamGoogleCodeAssist(
        model!,
        { messages: [{ role: 'user', content: 'healthcheck', timestamp: Date.now() }] },
        { apiKey: 'must-not-leak' },
      );
      const events: AssistantMessageEvent[] = [];
      for await (const event of stream) events.push(event);

      const error = events.find(
        (event): event is Extract<AssistantMessageEvent, { type: 'error' }> => event.type === 'error',
      );
      expect(error?.error.errorMessage).toContain('disabled by provider contract');
      expect(error?.error.errorMessage).not.toContain('must-not-leak');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKillSwitch === undefined) {
        delete process.env.ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL;
      } else {
        process.env.ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL = originalKillSwitch;
      }
    }
  });
});
