import { getUnstableProviderContract, getUnstableProviderContractStatus, type ProviderContractEnvironment } from "../../packages/core/src/provider-contracts.ts";
import type { FetchLike, ProviderCanaryResult } from './contracts.ts';
import { SECRET_ENVIRONMENT_NAMES, configuredSecret, fetchText, requestSignal, result, runProbe, unavailableResults } from './contracts.ts';

function googleCurrentProject(text: string): string | undefined {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed.currentTier) {
    const reasons = (Array.isArray(parsed.ineligibleTiers) ? parsed.ineligibleTiers : [])
      .map((tier: unknown) => (tier && typeof tier === 'object' ? (tier as Record<string, unknown>).reasonMessage : undefined))
      .filter((reason: unknown): reason is string => typeof reason === 'string' && reason.trim().length > 0);
    if (reasons.some(reason => /no longer supported for Gemini Code Assist for individuals|Antigravity suite of products/i.test(reason))) {
      throw new Error(
        'Gemini Code Assist OAuth is unavailable for individual accounts; use a Google AI Studio API key. Organization OAuth requires an active Code Assist license and GOOGLE_CLOUD_PROJECT.',
      );
    }
    throw new Error(`Code Assist account has no active tier; canary will not perform onboarding mutations${reasons.length ? `: ${reasons.join(', ')}` : ''}`);
  }
  const project = parsed.cloudaicompanionProject;
  if (typeof project === 'string') return project;
  if (project && typeof project === 'object') {
    const id = (project as Record<string, unknown>).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

export async function runGoogleCanaries(
  environment: ProviderContractEnvironment,
  fetchImpl: FetchLike,
  now: () => number,
): Promise<ProviderCanaryResult[]> {
  const provider = 'google-code-assist-v1internal' as const;
  const contract = getUnstableProviderContract(provider);
  const status = getUnstableProviderContractStatus(provider, environment);
  if (!status.enabled) return unavailableResults(provider, `disabled by ${status.source ?? status.reason}`);

  const accessToken = configuredSecret(environment, SECRET_ENVIRONMENT_NAMES.google);
  if (!accessToken) return unavailableResults(provider, `${SECRET_ENVIRONMENT_NAMES.google} is not configured`);
  const secrets = [accessToken];
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    ...contract.staticHeaders,
  };
  let projectId: string | undefined;
  const auth = await runProbe(provider, 'auth', now, secrets, async () => {
    const text = await fetchText(
      fetchImpl,
      `${contract.endpoint.origin}${contract.endpoint.operationPaths!.auth}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
        signal: requestSignal(),
      },
      secrets,
    );
    projectId = googleCurrentProject(text);
    return 'OAuth token accepted and Code Assist tier is active';
  });
  const listModels = result(provider, 'list-models', 'not-applicable', 'not applicable');
  const search = result(provider, 'search', 'not-applicable', 'not applicable');
  if (auth.status !== 'passed') {
    return [auth, listModels, search, result(provider, 'tool-call', 'skipped', 'auth canary failed')];
  }

  const toolCall = await runProbe(provider, 'tool-call', now, secrets, async () => {
    const toolName = 'provider_contract_healthcheck';
    const model = environment.ROBB_CANARY_GOOGLE_CODE_ASSIST_MODEL?.trim() || 'gemini-2.5-flash';
    const text = await fetchText(
      fetchImpl,
      `${contract.endpoint.origin}${contract.endpoint.operationPaths!.toolCall}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          project: projectId,
          user_prompt_id: `provider-canary-${now()}`,
          request: {
            contents: [{ role: 'user', parts: [{ text: 'Call provider_contract_healthcheck now.' }] }],
            tools: [{
              functionDeclarations: [{
                name: toolName,
                description: 'Return provider contract health.',
                parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
              }],
            }],
            toolConfig: {
              functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolName] },
            },
          },
        }),
        signal: requestSignal(),
      },
      secrets,
    );
    if (!text.includes(toolName) || !text.includes('functionCall')) {
      throw new Error('SSE response did not contain the required function call');
    }
    return `tool-call completed with ${model}`;
  });

  return [auth, listModels, search, toolCall];
}
