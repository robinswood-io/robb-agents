/**
 * Runtime contracts for provider integrations that rely on private or derived
 * endpoints. Keeping these values in one dependency-light module makes drift
 * visible and gives every caller the same emergency stop semantics.
 */

export type UnstableProviderContractId =
  | 'chatgpt-codex-backend'
  | 'github-copilot-proxy'
  | 'google-code-assist-v1internal';

export type ProviderCanaryKind = 'auth' | 'list-models' | 'search' | 'tool-call';

export interface UnstableProviderContract {
  id: UnstableProviderContractId;
  displayName: string;
  stability: 'private-fixed-endpoint' | 'private-derived-endpoint';
  endpoint: {
    origin?: string;
    path?: string;
    derivation?: string;
    operationPaths?: Readonly<Record<string, string>>;
  };
  sdk: {
    packageName: '@earendil-works/pi-ai';
    exactVersion: '0.80.3';
  };
  killSwitch: string;
  fallback: {
    kind: 'official-api-or-ddg' | 'sdk-static-catalog' | 'fail-closed';
    description: string;
  };
  canaries: Readonly<Record<ProviderCanaryKind, 'required' | 'not-applicable'>>;
  defaultModel?: string;
  requiredHeaders: readonly string[];
  staticHeaders: Readonly<Record<string, string>>;
}

export const UNSTABLE_PROVIDER_MASTER_KILL_SWITCH = 'ROBB_DISABLE_UNSTABLE_PROVIDERS';

export const UNSTABLE_PROVIDER_CONTRACTS: Readonly<
  Record<UnstableProviderContractId, UnstableProviderContract>
> = Object.freeze({
  'chatgpt-codex-backend': Object.freeze({
    id: 'chatgpt-codex-backend',
    displayName: 'ChatGPT Codex backend',
    stability: 'private-fixed-endpoint',
    endpoint: Object.freeze({
      origin: 'https://chatgpt.com/backend-api/codex',
      path: '/responses',
      operationPaths: Object.freeze({
        search: '/responses',
        toolCall: '/responses',
      }),
    }),
    sdk: Object.freeze({
      packageName: '@earendil-works/pi-ai',
      exactVersion: '0.80.3',
    }),
    killSwitch: 'ROBB_DISABLE_CHATGPT_CODEX_BACKEND',
    fallback: Object.freeze({
      kind: 'official-api-or-ddg',
      description: 'Use the official OpenAI Responses API when an API key exists; otherwise use DuckDuckGo for search.',
    }),
    canaries: Object.freeze({
      auth: 'required',
      'list-models': 'not-applicable',
      search: 'required',
      'tool-call': 'required',
    }),
    defaultModel: 'gpt-5.4-mini',
    requiredHeaders: Object.freeze([
      'Authorization',
      'chatgpt-account-id',
      'OpenAI-Beta',
    ]),
    staticHeaders: Object.freeze({
      'OpenAI-Beta': 'responses=experimental',
    }),
  }),
  'github-copilot-proxy': Object.freeze({
    id: 'github-copilot-proxy',
    displayName: 'GitHub Copilot proxy',
    stability: 'private-derived-endpoint',
    endpoint: Object.freeze({
      path: '/models',
      derivation: 'Exchange the GitHub OAuth token with @earendil-works/pi-ai, then map token proxy-ep from proxy.* to api.*.',
      operationPaths: Object.freeze({
        listModels: '/models',
        toolCall: '/responses',
      }),
    }),
    sdk: Object.freeze({
      packageName: '@earendil-works/pi-ai',
      exactVersion: '0.80.3',
    }),
    killSwitch: 'ROBB_DISABLE_GITHUB_COPILOT_PROXY',
    fallback: Object.freeze({
      kind: 'sdk-static-catalog',
      description: 'Model discovery uses the exact Pi SDK static catalog; inference remains fail-closed because it still requires the derived proxy endpoint.',
    }),
    canaries: Object.freeze({
      auth: 'required',
      'list-models': 'required',
      search: 'not-applicable',
      'tool-call': 'required',
    }),
    requiredHeaders: Object.freeze([
      'Authorization',
      'User-Agent',
      'Editor-Version',
      'Editor-Plugin-Version',
      'Copilot-Integration-Id',
      'X-GitHub-Api-Version',
    ]),
    staticHeaders: Object.freeze({
      'User-Agent': 'GitHubCopilotChat/0.35.0',
      'Editor-Version': 'vscode/1.107.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'X-GitHub-Api-Version': '2026-06-01',
    }),
  }),
  'google-code-assist-v1internal': Object.freeze({
    id: 'google-code-assist-v1internal',
    displayName: 'Google Gemini Code Assist v1internal',
    stability: 'private-fixed-endpoint',
    endpoint: Object.freeze({
      origin: 'https://cloudcode-pa.googleapis.com/v1internal',
      path: ':streamGenerateContent?alt=sse',
      operationPaths: Object.freeze({
        auth: ':loadCodeAssist',
        operation: '/',
        toolCall: ':streamGenerateContent?alt=sse',
      }),
    }),
    sdk: Object.freeze({
      packageName: '@earendil-works/pi-ai',
      exactVersion: '0.80.3',
    }),
    killSwitch: 'ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL',
    fallback: Object.freeze({
      kind: 'fail-closed',
      description: 'No equivalent official subscription endpoint accepts this OAuth credential; require a separate official Gemini API connection.',
    }),
    canaries: Object.freeze({
      auth: 'required',
      'list-models': 'not-applicable',
      search: 'not-applicable',
      'tool-call': 'required',
    }),
    requiredHeaders: Object.freeze(['Authorization', 'User-Agent']),
    staticHeaders: Object.freeze({
      'User-Agent': 'RobinswoodAgents/1.0 (gemini-code-assist)',
    }),
  }),
});

export type ProviderContractEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProviderContractStatus {
  enabled: boolean;
  reason: 'enabled-by-default' | 'explicitly-enabled' | 'kill-switch' | 'invalid-kill-switch';
  source?: string;
}

function evaluateKillSwitch(
  name: string,
  environment: ProviderContractEnvironment,
): ProviderContractStatus | undefined {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') return undefined;

  const value = raw.trim().toLowerCase();
  if (value === '0' || value === 'false') {
    return { enabled: true, reason: 'explicitly-enabled', source: name };
  }
  if (value === '1' || value === 'true') {
    return { enabled: false, reason: 'kill-switch', source: name };
  }

  // A misspelled emergency flag must never silently leave a private endpoint on.
  return { enabled: false, reason: 'invalid-kill-switch', source: name };
}

export function getUnstableProviderContract(
  id: UnstableProviderContractId,
): UnstableProviderContract {
  return UNSTABLE_PROVIDER_CONTRACTS[id];
}

/** Resolve the signed token's derived Copilot endpoint without accepting SSRF hosts. */
export function deriveGitHubCopilotApiBaseUrl(copilotToken: string): string | null {
  const match = copilotToken.match(/(?:^|;)proxy-ep=([^;]+)/);
  const proxyHost = match?.[1]?.trim().toLowerCase();
  if (
    !proxyHost
    || !/^[a-z0-9.-]+$/.test(proxyHost)
    || proxyHost.includes('..')
    || (proxyHost !== 'githubcopilot.com' && !proxyHost.endsWith('.githubcopilot.com'))
  ) {
    return null;
  }
  return `https://${proxyHost.replace(/^proxy\./, 'api.')}`;
}

/**
 * Unset flags preserve the current behavior. Explicit or malformed kill-switch
 * values stop the private path; malformed values intentionally fail closed.
 */
export function getUnstableProviderContractStatus(
  id: UnstableProviderContractId,
  environment: ProviderContractEnvironment,
): ProviderContractStatus {
  const master = evaluateKillSwitch(UNSTABLE_PROVIDER_MASTER_KILL_SWITCH, environment);
  if (master && !master.enabled) return master;

  const contract = getUnstableProviderContract(id);
  const scoped = evaluateKillSwitch(contract.killSwitch, environment);
  if (scoped) return scoped;

  if (master?.enabled) return master;
  return { enabled: true, reason: 'enabled-by-default' };
}

export function assertUnstableProviderContractEnabled(
  id: UnstableProviderContractId,
  environment: ProviderContractEnvironment,
): void {
  const status = getUnstableProviderContractStatus(id, environment);
  if (status.enabled) return;

  const contract = getUnstableProviderContract(id);
  const source = status.source ?? contract.killSwitch;
  throw new Error(
    `${contract.displayName} is disabled by provider contract (${source}; ${status.reason}). ${contract.fallback.description}`,
  );
}

/** Redact credentials before a provider diagnostic is written to logs or CI. */
export function redactProviderDiagnostic(
  value: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  let text = value instanceof Error ? value.message : String(value);

  for (const secret of secrets) {
    if (!secret) continue;
    const candidates = new Set([secret, encodeURIComponent(secret)]);
    for (const candidate of candidates) {
      if (candidate) text = text.split(candidate).join('[REDACTED]');
    }
  }

  return text
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/\b(Authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/([?&](?:access_token|api_key|key|token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|gh[opusr])[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}
