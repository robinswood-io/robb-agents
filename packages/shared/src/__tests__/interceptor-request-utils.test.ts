import { describe, expect, it } from 'bun:test';
import {
  normalizeGpt6AstraResponsesRequest,
  resolveRequestContext,
} from '../interceptor-request-utils.ts';

describe('interceptor-request-utils', () => {
  it('extracts JSON body from Request input when init.body is absent', async () => {
    const req = new Request('https://example.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' }),
    });

    const result = await resolveRequestContext(req, undefined);
    expect(result.bodyStr).toBe(JSON.stringify({ foo: 'bar' }));
    expect(result.normalizedInit.method).toBe('POST');
  });

  it('prefers init.body when provided', async () => {
    const req = new Request('https://example.com/messages', {
      method: 'POST',
      body: JSON.stringify({ old: true }),
    });

    const result = await resolveRequestContext(req, {
      method: 'POST',
      body: JSON.stringify({ new: true }),
    });

    expect(result.bodyStr).toBe(JSON.stringify({ new: true }));
  });

  it('normalizes unsupported GPT-6 Astra Responses API options', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-6-astra',
      temperature: 0.2,
      top_p: 0.9,
      top_logprobs: 4,
      logprobs: true,
      include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
      prompt_cache_retention: '24h',
      prompt_cache_options: { mode: 'explicit' },
    };

    expect(normalizeGpt6AstraResponsesRequest(body)).toEqual({
      model: 'gpt-6-astra',
      include: ['reasoning.encrypted_content'],
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    });
  });

  it('leaves non-Astra Responses API options unchanged', () => {
    const body: Record<string, unknown> = {
      model: 'gpt-5.6-sol',
      temperature: 0.2,
      prompt_cache_retention: '24h',
    };

    expect(normalizeGpt6AstraResponsesRequest(body)).toBe(body);
    expect(body).toEqual({
      model: 'gpt-5.6-sol',
      temperature: 0.2,
      prompt_cache_retention: '24h',
    });
  });
});
