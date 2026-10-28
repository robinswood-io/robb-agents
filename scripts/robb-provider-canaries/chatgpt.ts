import { isJsonObject, parseJsonObject } from '../../packages/shared/src/utils/json.ts';
import { getUnstableProviderContract, getUnstableProviderContractStatus, type ProviderContractEnvironment } from "../../packages/core/src/provider-contracts.ts";
import type { FetchLike, ProviderCanaryResult } from './contracts.ts';
import { SECRET_ENVIRONMENT_NAMES, configuredSecret, fetchText, requestSignal, result, runProbe, unavailableResults } from './contracts.ts';

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return parseJsonObject(atob(padded));
  } catch {
    return null;
  }
}

function chatGptIdentity(accessToken: string, nowMs: number): { accountId: string } {
  const parts = accessToken.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT access token is not a JWT');
  const payload = base64UrlJson(parts[1]!);
  const auth = payload?.['https://api.openai.com/auth'];
  const accountId = isJsonObject(auth)
    ? auth["chatgpt_account_id"]
    : undefined;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('ChatGPT access token is missing chatgpt_account_id');
  }
  if (typeof payload?.["exp"] === 'number' && payload["exp"] * 1000 <= nowMs) {
    throw new Error('ChatGPT access token is expired');
  }
  return { accountId };
}

function responseHasCompletion(text: string): boolean {
  return text.includes('response.completed')
    || text.includes('response.done')
    || /"output"\s*:\s*\[/.test(text);
}

export function responseHasToolCall(text: string, toolName: string): boolean {
  return responseHasCompletion(text)
    && text.includes(toolName)
    && (text.includes('function_call') || text.includes('tool_call'));
}

export async function runChatGptCanaries(
  environment: ProviderContractEnvironment,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<ProviderCanaryResult[]> {
  const provider = 'chatgpt-codex-backend' as const;
  const contract = getUnstableProviderContract(provider);
  const status = getUnstableProviderContractStatus(provider, environment);
  if (!status.enabled) {
    return unavailableResults(provider, `disabled by ${status.source ?? status.reason}`);
  }

  const accessToken = configuredSecret(environment, SECRET_ENVIRONMENT_NAMES.chatgpt);
  if (!accessToken) return unavailableResults(provider, `${SECRET_ENVIRONMENT_NAMES.chatgpt} is not configured`);
  const secrets = [accessToken];
  let identity: { accountId: string } | undefined;

  const auth = await runProbe(provider, 'auth', now, secrets, () => {
    identity = chatGptIdentity(accessToken, now());
    return 'JWT and account binding are valid';
  });
  const listModels = result(provider, 'list-models', 'not-applicable', 'not applicable');
  if (!identity) {
    return [
      auth,
      listModels,
      result(provider, 'search', 'skipped', 'auth canary failed'),
      result(provider, 'tool-call', 'skipped', 'auth canary failed'),
    ];
  }

  const endpoint = `${contract.endpoint.origin}${contract.endpoint.operationPaths!["search"]}`;
  const model = environment["ROBB_CANARY_CHATGPT_MODEL"]?.trim() || contract.defaultModel;
  const commonHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': identity.accountId,
    ...contract.staticHeaders,
  };
  const search = await runProbe(provider, 'search', now, secrets, async () => {
    const text = await fetchText(fetchImpl, endpoint, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        instructions: 'Provider contract canary. Return one current public result with a source URL.',
        tools: [{ type: 'web_search' }],
        tool_choice: 'auto',
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: 'Find the official OpenAI API documentation homepage.' }],
        }],
      }),
      signal: requestSignal(),
    }, secrets);
    if (!responseHasCompletion(text) || !(text.includes('url_citation') || text.includes('web_search_call') || text.includes('https://'))) {
      throw new Error('search response completed without observable search evidence');
    }
    return 'private search contract completed with source evidence';
  });

  const toolCall = await runProbe(provider, 'tool-call', now, secrets, async () => {
    const toolName = 'provider_contract_healthcheck';
    const text = await fetchText(fetchImpl, endpoint, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        tools: [{
          type: 'function',
          name: toolName,
          description: 'Return provider contract health.',
          parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
          strict: null,
        }],
        tool_choice: { type: 'function', name: toolName },
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: 'Call the healthcheck function now.' }],
        }],
      }),
      signal: requestSignal(),
    }, secrets);
    if (!responseHasToolCall(text, toolName)) throw new Error('response did not contain the required function call');
    return 'private tool-call contract completed';
  });

  return [auth, listModels, search, toolCall];
}
