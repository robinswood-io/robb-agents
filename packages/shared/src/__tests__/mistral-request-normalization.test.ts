import { describe, expect, it } from 'bun:test';
import { normalizeMistralChatRequest } from '../interceptor-request-utils.ts';

const endpoint = 'https://api.mistral.ai/v1/chat/completions';

describe('Mistral Medium 3.5 request compatibility', () => {
  it('translates the SDK legacy prompt mode without changing the selected snapshot or history', () => {
    for (const model of ['mistral-medium-3-5', 'mistral-medium-2604']) {
      const messages = [{ role: 'assistant', content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Earlier reasoning' }] }] }];
      const body = { model, prompt_mode: 'reasoning', prompt_cache_key: 'conversation-42', messages };
      expect(normalizeMistralChatRequest(endpoint, body)).toEqual({
        model,
        reasoning_effort: 'high',
        prompt_cache_key: 'conversation-42',
        messages,
      });
      expect(body.messages).toBe(messages);
    }
  });

  it('preserves explicit effort and leaves disabled thinking disabled', () => {
    expect(normalizeMistralChatRequest(endpoint, {
      model: 'mistral-medium-3-5', prompt_mode: 'reasoning', reasoning_effort: 'none',
    })).toEqual({ model: 'mistral-medium-3-5', reasoning_effort: 'none' });
    expect(normalizeMistralChatRequest(endpoint, { model: 'mistral-medium-3-5' }))
      .toEqual({ model: 'mistral-medium-3-5' });
  });

  it('leaves other providers, custom endpoints and native Magistral requests unchanged', () => {
    for (const url of ['https://proxy.example/v1/chat/completions', 'https://api.mistral.ai.example/v1/chat/completions', 'invalid', 'https://api.mistral.ai/v1/conversations']) {
      const body = { model: 'mistral-medium-3-5', prompt_mode: 'reasoning' };
      expect(normalizeMistralChatRequest(url, body)).toEqual(body);
      expect(body).toHaveProperty('prompt_mode', 'reasoning');
      expect(body).not.toHaveProperty('reasoning_effort');
    }
    const magistral = { model: 'magistral-medium-latest', prompt_mode: 'reasoning' };
    expect(normalizeMistralChatRequest(endpoint, magistral)).toEqual(magistral);
    expect(magistral).toHaveProperty('prompt_mode', 'reasoning');
  });
});
