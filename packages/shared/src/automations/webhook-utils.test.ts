/**
 * Tests for webhook utility functions (expandWebhookAction, etc.)
 */

import { describe, it, expect, mock } from 'bun:test';
import {
  executeWebhookRequest,
  expandWebhookAction,
  prepareWebhookActionForDeferredRetry,
} from './webhook-utils.ts';
import type { WebhookAction } from './types.ts';

const env = {
  CRAFT_WH_SESSION_ID: 'sess-123',
  CRAFT_WH_EVENT: 'LabelAdd',
  API_TOKEN: 'tok-secret',
};

describe('expandWebhookAction', () => {
  it('expands URL templates', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com/hook/${CRAFT_WH_SESSION_ID}',
    };
    const result = expandWebhookAction(action, env);
    expect(result.url).toBe('https://api.example.com/hook/sess-123');
  });

  it('expands header values', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      headers: { 'X-Event': '${CRAFT_WH_EVENT}', 'X-Static': 'unchanged' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.headers).toEqual({ 'X-Event': 'LabelAdd', 'X-Static': 'unchanged' });
  });

  it('expands string body', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      body: 'session=${CRAFT_WH_SESSION_ID}',
      bodyFormat: 'raw',
    };
    const result = expandWebhookAction(action, env);
    expect(result.body).toBe('session=sess-123');
  });

  it('expands object body (JSON)', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      body: { id: '${CRAFT_WH_SESSION_ID}', event: '${CRAFT_WH_EVENT}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.body).toEqual({ id: 'sess-123', event: 'LabelAdd' });
  });

  it('expands basic auth credentials', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      auth: { type: 'basic', username: '${CRAFT_WH_SESSION_ID}', password: '${API_TOKEN}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.auth).toEqual({ type: 'basic', username: 'sess-123', password: 'tok-secret' });
  });

  it('expands bearer auth token', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com',
      auth: { type: 'bearer', token: '${API_TOKEN}' },
    };
    const result = expandWebhookAction(action, env);
    expect(result.auth).toEqual({ type: 'bearer', token: 'tok-secret' });
  });

  it('passes through fields without templates unchanged', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com/static',
      method: 'PUT',
      bodyFormat: 'json',
      captureResponse: true,
    };
    const result = expandWebhookAction(action, env);
    expect(result.url).toBe('https://api.example.com/static');
    expect(result.method).toBe('PUT');
    expect(result.bodyFormat).toBe('json');
    expect(result.captureResponse).toBe(true);
  });
});

describe('prepareWebhookActionForDeferredRetry', () => {
  it('expands event values but keeps scoped secret references out of persisted JSON', () => {
    const action: WebhookAction = {
      type: 'webhook',
      url: 'https://api.example.com/hook/${CRAFT_EVENT_ID}',
      headers: { Authorization: 'Bearer ${CRAFT_WH_API_TOKEN}' },
      body: { event: '${CRAFT_EVENT_ID}', secret: '${CRAFT_WH_API_TOKEN}' },
      auth: { type: 'bearer', token: '${CRAFT_WH_API_TOKEN}' },
    };
    const prepared = prepareWebhookActionForDeferredRetry(action, {
      CRAFT_EVENT_ID: 'event-123',
      CRAFT_WH_API_TOKEN: 'super-secret-value',
    });
    const serialized = JSON.stringify(prepared);

    expect(prepared.url).toBe('https://api.example.com/hook/event-123');
    expect(serialized).toContain('${CRAFT_WH_API_TOKEN}');
    expect(serialized).not.toContain('super-secret-value');
  });

  it('rejects literal bearer tokens and sensitive headers', () => {
    expect(() => prepareWebhookActionForDeferredRetry({
      type: 'webhook',
      url: 'https://api.example.com',
      auth: { type: 'bearer', token: 'literal-secret' },
    }, {})).toThrow('must reference a CRAFT_WH_* variable');
    expect(() => prepareWebhookActionForDeferredRetry({
      type: 'webhook',
      url: 'https://api.example.com',
      headers: { 'X-API-Key': 'literal-secret' },
    }, {})).toThrow('must reference a CRAFT_WH_* variable');
  });
});

describe('executeWebhookRequest destination policy', () => {
  it.each([
    'http://127.0.0.1/admin',
    'http://10.0.0.12/internal',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/admin',
  ])('blocks private address %s before fetch', async (url) => {
    const fetchStub = mock(async () => new Response(null, { status: 204 }));
    const result = await executeWebhookRequest(
      { type: 'webhook', url },
      { fetch: fetchStub },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('private-network policy');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    const fetchStub = mock(async () => new Response(null, { status: 204 }));
    const result = await executeWebhookRequest(
      { type: 'webhook', url: 'https://hooks.example.com' },
      {
        fetch: fetchStub,
        resolveHostname: async () => ['192.168.1.10'],
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('private-network policy');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects embedded URL credentials', async () => {
    const fetchStub = mock(async () => new Response(null, { status: 204 }));
    const result = await executeWebhookRequest(
      { type: 'webhook', url: 'https://user:password@hooks.example.com' },
      {
        fetch: fetchStub,
        resolveHostname: async () => ['93.184.216.34'],
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Webhook URL credentials are not allowed');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('allows public destinations and refuses redirects', async () => {
    const fetchStub = mock(async () => new Response(null, { status: 204 }));
    const result = await executeWebhookRequest(
      { type: 'webhook', url: 'https://hooks.example.com/events' },
      {
        fetch: fetchStub,
        resolveHostname: async () => ['93.184.216.34'],
      },
    );

    expect(result.success).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
});
