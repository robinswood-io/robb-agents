import {
  UNSTABLE_PROVIDER_CONTRACTS,
  deriveGitHubCopilotApiBaseUrl,
  getUnstableProviderContract,
  getUnstableProviderContractStatus,
  redactProviderDiagnostic,
  type ProviderCanaryKind,
  type ProviderContractEnvironment,
  type UnstableProviderContractId,
} from '../packages/core/src/provider-contracts.ts';

type CanaryStatus = 'passed' | 'failed' | 'skipped' | 'not-applicable';

export interface ProviderCanaryResult {
  provider: UnstableProviderContractId;
  check: ProviderCanaryKind;
  required: boolean;
  status: CanaryStatus;
  durationMs: number;
  detail: string;
}

export interface ProviderCanaryReport {
  schemaVersion: 1;
  generatedAt: string;
  sdkContracts: Array<{ packageName: string; exactVersion: string }>;
  results: ProviderCanaryResult[];
  summary: Record<CanaryStatus, number> & { ok: boolean };
}

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;
type CopilotTokenExchange = (githubToken: string) => Promise<{ access: string }>;

export interface ProviderCanaryOptions {
  environment?: ProviderContractEnvironment;
  fetchImpl?: FetchLike;
  exchangeCopilotToken?: CopilotTokenExchange;
  now?: () => number;
}

const CHECK_ORDER: readonly ProviderCanaryKind[] = [
  'auth',
  'list-models',
  'search',
  'tool-call',
];
const TIMEOUT_MS = 30_000;
const DETAIL_LIMIT = 500;

const SECRET_ENVIRONMENT_NAMES = {
  chatgpt: 'ROBB_CANARY_CHATGPT_ACCESS_TOKEN',
  copilot: 'ROBB_CANARY_GITHUB_TOKEN',
  google: 'ROBB_CANARY_GOOGLE_CODE_ASSIST_ACCESS_TOKEN',
} as const;

function configuredSecret(environment: ProviderContractEnvironment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function safeDetail(value: unknown, secrets: readonly (string | undefined)[]): string {
  return redactProviderDiagnostic(value, secrets)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_LIMIT);
}

function result(
  provider: UnstableProviderContractId,
  check: ProviderCanaryKind,
  status: CanaryStatus,
  detail: string,
  durationMs = 0,
): ProviderCanaryResult {
  return {
    provider,
    check,
    required: UNSTABLE_PROVIDER_CONTRACTS[provider].canaries[check] === 'required',
    status,
    durationMs,
    detail,
  };
}

async function runProbe(
  provider: UnstableProviderContractId,
  check: ProviderCanaryKind,
  now: () => number,
  secrets: readonly (string | undefined)[],
  probe: () => Promise<string> | string,
): Promise<ProviderCanaryResult> {
  const startedAt = now();
  try {
    const detail = await probe();
    return result(provider, check, 'passed', safeDetail(detail, secrets), Math.max(0, now() - startedAt));
  } catch (error) {
    return result(provider, check, 'failed', safeDetail(error, secrets), Math.max(0, now() - startedAt));
  }
}

function unavailableResults(
  provider: UnstableProviderContractId,
  detail: string,
): ProviderCanaryResult[] {
  return CHECK_ORDER.map((check) => {
    const required = UNSTABLE_PROVIDER_CONTRACTS[provider].canaries[check] === 'required';
    return result(provider, check, required ? 'skipped' : 'not-applicable', required ? detail : 'not applicable');
  });
}

function base64UrlJson(segment: string): Record<string, unknown> | null {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const value = JSON.parse(atob(padded));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function chatGptIdentity(accessToken: string, nowMs: number): { accountId: string } {
  const parts = accessToken.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT access token is not a JWT');
  const payload = base64UrlJson(parts[1]!);
  const auth = payload?.['https://api.openai.com/auth'];
  const accountId = typeof auth === 'object' && auth !== null
    ? (auth as Record<string, unknown>).chatgpt_account_id
    : undefined;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('ChatGPT access token is missing chatgpt_account_id');
  }
  if (typeof payload?.exp === 'number' && payload.exp * 1000 <= nowMs) {
    throw new Error('ChatGPT access token is expired');
  }
  return { accountId };
}

function responseHasCompletion(text: string): boolean {
  return text.includes('response.completed')
    || text.includes('response.done')
    || /"output"\s*:\s*\[/.test(text);
}

function responseHasToolCall(text: string, toolName: string): boolean {
  return responseHasCompletion(text)
    && text.includes(toolName)
    && (text.includes('function_call') || text.includes('tool_call'));
}

async function fetchText(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  secrets: readonly (string | undefined)[],
): Promise<string> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${safeDetail(text || response.statusText, secrets)}`);
  }
  return text;
}

function requestSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function runChatGptCanaries(
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

  const endpoint = `${contract.endpoint.origin}${contract.endpoint.operationPaths!.search}`;
  const model = environment.ROBB_CANARY_CHATGPT_MODEL?.trim() || contract.defaultModel;
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

function parseModelIds(text: string): string[] {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const values = Array.isArray(parsed.models) ? parsed.models : Array.isArray(parsed.data) ? parsed.data : [];
  return values.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const id = (entry as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  });
}

async function defaultCopilotTokenExchange(githubToken: string): Promise<{ access: string }> {
  const { refreshGitHubCopilotToken } = await import('@earendil-works/pi-ai/oauth');
  return refreshGitHubCopilotToken(githubToken);
}

async function runCopilotCanaries(
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
      `${baseUrl}${contract.endpoint.operationPaths!.listModels}`,
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
    const model = environment.ROBB_CANARY_COPILOT_MODEL?.trim() || 'gpt-5-mini';
    if (!modelIds.includes(model)) throw new Error(`configured canary model is unavailable: ${model}`);
    const toolName = 'provider_contract_healthcheck';
    const text = await fetchText(fetchImpl, `${baseUrl}${contract.endpoint.operationPaths!.toolCall}`, {
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

function googleCurrentProject(text: string): string | undefined {
  const parsed = JSON.parse(text) as Record<string, any>;
  if (!parsed.currentTier) {
    const reasons = (Array.isArray(parsed.ineligibleTiers) ? parsed.ineligibleTiers : [])
      .map((tier: Record<string, unknown>) => tier?.reasonMessage)
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

async function runGoogleCanaries(
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

export async function runProviderCanaries(
  options: ProviderCanaryOptions = {},
): Promise<ProviderCanaryReport> {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const exchangeCopilotToken = options.exchangeCopilotToken ?? defaultCopilotTokenExchange;
  const now = options.now ?? Date.now;
  const results = [
    ...await runChatGptCanaries(environment, fetchImpl, now),
    ...await runCopilotCanaries(environment, fetchImpl, exchangeCopilotToken, now),
    ...await runGoogleCanaries(environment, fetchImpl, now),
  ];
  const summary = {
    passed: results.filter(item => item.status === 'passed').length,
    failed: results.filter(item => item.status === 'failed').length,
    skipped: results.filter(item => item.status === 'skipped').length,
    'not-applicable': results.filter(item => item.status === 'not-applicable').length,
    ok: false,
  };
  const requireConfigured = environment.ROBB_PROVIDER_CANARIES_REQUIRED === '1'
    || environment.ROBB_PROVIDER_CANARIES_REQUIRED === 'true';
  summary.ok = summary.failed === 0
    && (!requireConfigured || results.every(item => !item.required || item.status !== 'skipped'));
  const sdkContracts = [...new Map(
    Object.values(UNSTABLE_PROVIDER_CONTRACTS)
      .map(contract => [`${contract.sdk.packageName}@${contract.sdk.exactVersion}`, contract.sdk] as const),
  ).values()];

  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    sdkContracts,
    results,
    summary,
  };
}

function allConfiguredSecrets(environment: ProviderContractEnvironment): string[] {
  return Object.values(SECRET_ENVIRONMENT_NAMES)
    .flatMap(name => configuredSecret(environment, name) ?? []);
}

if (import.meta.main) {
  const report = await runProviderCanaries();
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const leakedSecret = allConfiguredSecrets(process.env).find(secret => serialized.includes(secret));
  if (leakedSecret) {
    throw new Error('Provider canary report serialization contained a credential and was blocked');
  }

  const reportPath = process.env.ROBB_PROVIDER_CANARY_REPORT?.trim();
  if (reportPath) await Bun.write(reportPath, serialized);
  process.stdout.write(serialized);
  if (!report.summary.ok) process.exitCode = 1;
}
