import { createHash } from "node:crypto";
import type { LiveEvalProvider, ProviderEvalClientConfig, ProviderEvalFetch, ProviderEvalResponse, ProviderPricing } from './contracts.ts';
import { arrayValue, finiteNumber, recordValue, stringValue } from './contracts.ts';

function defaultEndpoint(config: ProviderEvalClientConfig): string {
  switch (config.provider) {
    case 'anthropic-messages':
      return 'https://api.anthropic.com/v1/messages';
    case 'google-gemini':
      return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    case 'openai-chat':
      return 'https://api.openai.com/v1/chat/completions';
    case 'openai-responses':
      return 'https://api.openai.com/v1/responses';
  }
}

function validatedEndpoint(config: ProviderEvalClientConfig): string {
  const raw = config.endpoint?.trim() || defaultEndpoint(config);
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('Provider eval endpoints must use HTTPS outside loopback');
  }
  return url.toString();
}

function authHeaders(config: ProviderEvalClientConfig): Record<string, string> {
  switch (config.provider) {
    case 'anthropic-messages':
      return {
        'anthropic-version': '2023-06-01',
        'x-api-key': config.apiKey,
      };
    case 'google-gemini':
      return { 'x-goog-api-key': config.apiKey };
    case 'openai-chat':
    case 'openai-responses':
      return { authorization: `Bearer ${config.apiKey}` };
  }
}

function requestBody(
  config: ProviderEvalClientConfig,
  prompt: string,
): Record<string, unknown> {
  switch (config.provider) {
    case 'anthropic-messages':
      return {
        model: config.model,
        max_tokens: 1_200,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      };
    case 'google-gemini':
      return {
        generationConfig: {
          maxOutputTokens: 1_200,
          temperature: 0,
        },
        contents: [{
          role: 'user',
          parts: [{ text: prompt }],
        }],
      };
    case 'openai-chat':
      return {
        model: config.model,
        max_completion_tokens: 1_200,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      };
    case 'openai-responses':
      return {
        model: config.model,
        max_output_tokens: 1_200,
        temperature: 0,
        input: prompt,
      };
  }
}

function anthropicText(body: Record<string, unknown>): string {
  return arrayValue(body.content)
    .flatMap((item) => {
      const record = recordValue(item);
      return record?.type === 'text' ? [stringValue(record.text) ?? ''] : [];
    })
    .join('');
}

function geminiText(body: Record<string, unknown>): string {
  const candidate = recordValue(arrayValue(body.candidates)[0]);
  const content = recordValue(candidate?.content);
  return arrayValue(content?.parts)
    .flatMap((part) => {
      const record = recordValue(part);
      const text = record ? stringValue(record.text) : null;
      return text ? [text] : [];
    })
    .join('');
}

function openAiChatText(body: Record<string, unknown>): string {
  const choice = recordValue(arrayValue(body.choices)[0]);
  const message = recordValue(choice?.message);
  return stringValue(message?.content) ?? '';
}

function openAiResponsesText(body: Record<string, unknown>): string {
  const direct = stringValue(body.output_text);
  if (direct) return direct;
  return arrayValue(body.output)
    .flatMap((item) => {
      const record = recordValue(item);
      return arrayValue(record?.content);
    })
    .flatMap((item) => {
      const record = recordValue(item);
      return record?.type === 'output_text' ? [stringValue(record.text) ?? ''] : [];
    })
    .join('');
}

function responseText(
  provider: LiveEvalProvider,
  body: Record<string, unknown>,
): string {
  switch (provider) {
    case 'anthropic-messages':
      return anthropicText(body);
    case 'google-gemini':
      return geminiText(body);
    case 'openai-chat':
      return openAiChatText(body);
    case 'openai-responses':
      return openAiResponsesText(body);
  }
}

function responseUsage(
  provider: LiveEvalProvider,
  body: Record<string, unknown>,
): { inputTokens: number | null; outputTokens: number | null } {
  if (provider === 'google-gemini') {
    const usage = recordValue(body.usageMetadata);
    return {
      inputTokens: finiteNumber(usage?.promptTokenCount),
      outputTokens: finiteNumber(usage?.candidatesTokenCount),
    };
  }
  const usage = recordValue(body.usage);
  return {
    inputTokens: finiteNumber(
      provider === 'openai-chat' ? usage?.prompt_tokens : usage?.input_tokens,
    ),
    outputTokens: finiteNumber(
      provider === 'openai-chat' ? usage?.completion_tokens : usage?.output_tokens,
    ),
  };
}

function estimateCost(
  pricing: ProviderPricing | undefined,
  inputTokens: number | null,
  outputTokens: number | null,
): number | null {
  if (!pricing || inputTokens === null || outputTokens === null) return null;
  return (
    (inputTokens * pricing.inputUsdPerMillionTokens)
    + (outputTokens * pricing.outputUsdPerMillionTokens)
  ) / 1_000_000;
}

function responseRequestId(
  response: Response,
  body: Record<string, unknown>,
): string | undefined {
  const value = response.headers.get('request-id')
    ?? response.headers.get('x-request-id')
    ?? stringValue(body.id);
  return value?.trim() || undefined;
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class ProviderEvalHttpClient {
  private readonly fetchFn: ProviderEvalFetch;

  constructor(
    readonly config: ProviderEvalClientConfig,
    fetchFn: ProviderEvalFetch = fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  async generate(prompt: string): Promise<ProviderEvalResponse> {
    if (!this.config.apiKey.trim()) throw new Error('Provider eval API key is required');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 60_000,
    );
    const startedAt = performance.now();
    try {
      const response = await this.fetchFn(validatedEndpoint(this.config), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeaders(this.config),
        },
        body: JSON.stringify(requestBody(this.config, prompt)),
        signal: controller.signal,
      });
      const parsed: unknown = await response.json();
      const body = recordValue(parsed);
      if (!response.ok) {
        throw new Error(`Provider eval request failed with HTTP ${response.status}`);
      }
      if (!body) throw new Error('Provider eval response is not a JSON object');
      const outputText = responseText(this.config.provider, body).trim();
      if (!outputText) throw new Error('Provider eval response did not contain text');
      const usage = responseUsage(this.config.provider, body);
      return {
        provider: this.config.provider,
        model: this.config.model,
        ...(responseRequestId(response, body)
          ? { requestId: responseRequestId(response, body) }
          : {}),
        outputText,
        outputDigest: digest(outputText),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        latencyMs: Math.max(0, performance.now() - startedAt),
        costUsd: estimateCost(
          this.config.pricing,
          usage.inputTokens,
          usage.outputTokens,
        ),
        ...(this.config.pricing
          ? { pricingCatalogVersion: this.config.pricing.catalogVersion }
          : {}),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
