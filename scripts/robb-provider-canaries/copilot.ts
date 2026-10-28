import { deriveGitHubCopilotApiBaseUrl, getUnstableProviderContract, getUnstableProviderContractStatus, type ProviderContractEnvironment } from "../../packages/core/src/provider-contracts.ts";
import { responseHasToolCall } from './chatgpt.ts';
import type { CopilotTokenExchange, FetchLike, ProviderCanaryResult } from './contracts.ts';
import { SECRET_ENVIRONMENT_NAMES, configuredSecret, fetchText, requestSignal, result, runProbe, unavailableResults } from './contracts.ts';

function parseModelIds(text: string): string[] {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const values = Array.isArray(parsed["models"]) ? parsed["models"] : Array.isArray(parsed["data"]) ? parsed["data"] : [];
  return values.flatMap((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return [];
    const id = (entry as Record<string, unknown>)["id"];
    return typeof id === 'string' && id ? [id] : [];
  });
}

export async function defaultCopilotTokenExchange(githubToken: string): Promise<{ access: string }> {
  const { refreshGitHubCopilotToken } = await import("../../packages/shared/src/auth/copilot-oauth.ts");
  return refreshGitHubCopilotToken(githubToken);
}

export async function runCopilotCanaries(
  environment: ProviderContractEnvironment,
  fetchImpl: FetchLike,
  exchangeCopilotToken: CopilotTokenExchange,
  now: () => number,
): Promise<ProviderCanaryResult[]> {
  const provider = 'github-copilot-proxy' as const;
  const contract = getUnstableProviderContract(provider);
  const status = getUnstableProviderContractStatus(provider, environment);
  if (!status.enabled) return unavailableResults(provider, `disabled by ${status.source ?? status.reason}`);

  const githubToken = configuredSecret(environment, SECRET_ENVIRONMENT_NAMES.copilot);
  if (!githubToken) return unavailableResults(provider, `${SECRET_ENVIRONMENT_NAMES.copilot} is not configured`);
  const secrets: Array<string | undefined> = [githubToken];
  let copilotToken: string | undefined;
  let baseUrl: string | undefined;

  const auth = await runProbe(provider, 'auth', now, secrets, async () => {
    const credential = await exchangeCopilotToken(githubToken);
    if (!credential?.access) throw new Error('Pi SDK returned no Copilot access token');
    copilotToken = credential.access;
    secrets.push(copilotToken);
    baseUrl = deriveGitHubCopilotApiBaseUrl(copilotToken) ?? undefined;
    if (!baseUrl) throw new Error('Copilot token has no trusted proxy-ep host');
    return 'Pi SDK token exchange and proxy binding succeeded';
  });
  if (!copilotToken || !baseUrl) {
    return [
      auth,
      result(provider, 'list-models', 'skipped', 'auth canary failed'),
      result(provider, 'search', 'not-applicable', 'not applicable'),
      result(provider, 'tool-call', 'skipped', 'auth canary failed'),
    ];
  }

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${copilotToken}`,
    ...contract.staticHeaders,
  };
  let modelIds: string[] = [];
  const listModels = await runProbe(provider, 'list-models', now, secrets, async () => {
    const text = await fetchText(
      fetchImpl,
      `${baseUrl}${contract.endpoint.operationPaths!["listModels"]}`,
      { headers, signal: requestSignal() },
      secrets,
    );
    modelIds = parseModelIds(text);
    if (!modelIds.length) throw new Error('models response contains no model IDs');
    return `${modelIds.length} model IDs returned`;
  });
  const search = result(provider, 'search', 'not-applicable', 'not applicable');
  if (!modelIds.length) {
    return [auth, listModels, search, result(provider, 'tool-call', 'skipped', 'list-models canary failed')];
  }

  const toolCall = await runProbe(provider, 'tool-call', now, secrets, async () => {
    const model = environment["ROBB_CANARY_COPILOT_MODEL"]?.trim() || 'gpt-5-mini';
    if (!modelIds.includes(model)) throw new Error(`configured canary model is unavailable: ${model}`);
    const toolName = 'provider_contract_healthcheck';
    const text = await fetchText(fetchImpl, `${baseUrl}${contract.endpoint.operationPaths!["toolCall"]}`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'X-Initiator': 'user',
        'Openai-Intent': 'conversation-edits',
      },
      body: JSON.stringify({
        model,
        store: false,
        stream: true,
        input: 'Call the provider contract healthcheck function now.',
        tools: [{
          type: 'function',
          name: toolName,
          description: 'Return provider contract health.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          strict: true,
        }],
        tool_choice: { type: 'function', name: toolName },
      }),
      signal: requestSignal(),
    }, secrets);
    if (!responseHasToolCall(text, toolName)) throw new Error('response did not contain the required function call');
    return `tool-call completed with ${model}`;
  });

  return [auth, listModels, search, toolCall];
}
