/**
 * ChatGPT backend search provider — for ChatGPT Plus / OpenAI OAuth users.
 *
 * Uses the same Responses API format as the public OpenAI API, but hits the
 * ChatGPT backend endpoint which accepts OAuth access tokens instead of API keys.
 *
 * Auth flow mirrors the Pi SDK's `openai-codex-responses.js`:
 *   - Bearer token: the OAuth access token
 *   - chatgpt-account-id: extracted from the JWT's claims
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';
import { parseResponsesApiResults, type ResponsesApiResponse } from './responses-api-parser.ts';
import {
  assertUnstableProviderContractEnabled,
  getUnstableProviderContract,
  redactProviderDiagnostic,
} from '@craft-agent/core';

/**
 * Codex backend request contract (search path):
 * - model: current provider-contract default (gpt-5.4-mini)
 * - store: false
 * - stream: true (backend may return JSON or SSE)
 * - instructions + tool_choice + text.verbosity
 * - OpenAI-Beta: responses=experimental header
 *
 * If this payload changes, update:
 *   - ./chatgpt.test.ts
 *   - ../SEARCH_PAYLOAD_CONTRACT.md
 */
const PROVIDER_CONTRACT = getUnstableProviderContract('chatgpt-codex-backend');
const DEFAULT_SEARCH_MODEL = PROVIDER_CONTRACT.defaultModel!;
const API_BASE = PROVIDER_CONTRACT.endpoint.origin!;
const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const ERROR_TEXT_LIMIT = 600;
const SEARCH_INSTRUCTIONS = 'You are a web search assistant. Return concise, factual search results with source citations when available.';
const SEARCH_TEXT_VERBOSITY = 'medium';

const SEARCH_TOOL_TYPE = 'web_search' as const;

/**
 * Extract the `chatgpt_account_id` from a ChatGPT OAuth access token (JWT).
 * Returns null if the token is malformed or the claim is missing.
 */
export function extractChatGptAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;

    const payload = JSON.parse(atob(parts[1]!));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;

    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
  } catch {
    return null;
  }
}

export class ChatGPTBackendSearchProvider implements WebSearchProvider {
  name = 'ChatGPT';

  constructor(
    private accessToken: string,
    private accountId: string,
    private options?: { model?: string },
  ) {}

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    assertUnstableProviderContractEnabled('chatgpt-codex-backend', process.env);
    const requestBody = {
      model: this.options?.model || DEFAULT_SEARCH_MODEL,
      store: false,
      stream: true,
      instructions: SEARCH_INSTRUCTIONS,
      tools: [{ type: SEARCH_TOOL_TYPE }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
      text: { verbosity: SEARCH_TEXT_VERBOSITY },
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Search the web for: ${query}\n\nReturn the top ${count} results with title, URL, and a brief description.`,
            },
          ],
        },
      ],
    };

    const requestFingerprint = buildRequestFingerprint(requestBody);
    const response = await fetch(`${API_BASE}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        'chatgpt-account-id': this.accountId,
        ...PROVIDER_CONTRACT.staticHeaders,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    });

    const contentType = response.headers.get('content-type') || 'unknown';

    if (response.ok) {
      try {
        const data = await parseResponsePayload(response);
        return parseResponsesApiResults(data, query, count);
      } catch (parseError) {
        const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
        throw new Error(
          `ChatGPT search failed: web_search parse failed [${requestFingerprint}, content-type=${contentType}]: ${compactErrorText(parseMessage, [this.accessToken])}`,
        );
      }
    }

    const errorText = await response.text();
    const compactError = compactErrorText(errorText, [this.accessToken]);
    throw new Error(
      `ChatGPT search failed: web_search failed (HTTP ${response.status}) [${requestFingerprint}, content-type=${contentType}]: ${compactError}`,
    );
  }
}

async function parseResponsePayload(response: Response): Promise<ResponsesApiResponse> {
  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();

  const looksLikeSse =
    contentType.includes('text/event-stream') ||
    raw.startsWith('event:') ||
    raw.includes('\ndata:') ||
    raw.includes('\n\nevent:');

  if (looksLikeSse) {
    return parseSseResponsePayload(raw);
  }

  try {
    return JSON.parse(raw) as ResponsesApiResponse;
  } catch {
    throw new Error(`ChatGPT search response parse failed: expected JSON or SSE payload, got: ${compactErrorText(raw)}`);
  }
}

function parseSseResponsePayload(sseText: string): ResponsesApiResponse {
  let completed: ResponsesApiResponse | null = null;

  for (const chunk of sseText.split('\n\n')) {
    const dataLines = chunk
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);

    for (const line of dataLines) {
      if (line === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (event?.type === 'response.completed' || event?.type === 'response.done') {
        if (event.response && typeof event.response === 'object') {
          completed = event.response as ResponsesApiResponse;
        }
      }
    }
  }

  if (!completed) {
    throw new Error('ChatGPT search stream returned no completed response payload');
  }

  return completed;
}

function buildRequestFingerprint(body: {
  model: string;
  store: boolean;
  stream: boolean;
  tools: Array<{ type: string }>;
  tool_choice: string;
  text?: { verbosity?: string };
}): string {
  const toolType = body.tools[0]?.type || 'unknown';
  const verbosity = body.text?.verbosity || 'unset';

  return `tool=${toolType}, model=${body.model}, store=${String(body.store)}, stream=${String(body.stream)}, tool_choice=${body.tool_choice}, text.verbosity=${verbosity}`;
}

function compactErrorText(text: string, secrets: readonly string[] = []): string {
  const normalized = redactProviderDiagnostic(text, secrets).replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Bad Request';
  return normalized.slice(0, ERROR_TEXT_LIMIT);
}
