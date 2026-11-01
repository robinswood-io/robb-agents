import { UNSTABLE_PROVIDER_CONTRACTS, redactProviderDiagnostic, type ProviderCanaryKind, type ProviderContractEnvironment, type UnstableProviderContractId } from "../../packages/core/src/provider-contracts.ts";

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

export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export type CopilotTokenExchange = (githubToken: string) => Promise<{ access: string }>;

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

export const SECRET_ENVIRONMENT_NAMES = {
  chatgpt: 'ROBB_CANARY_CHATGPT_ACCESS_TOKEN',
  copilot: 'ROBB_CANARY_GITHUB_TOKEN',
  google: 'ROBB_CANARY_GOOGLE_CODE_ASSIST_ACCESS_TOKEN',
} as const;

export function configuredSecret(environment: ProviderContractEnvironment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function safeDetail(value: unknown, secrets: readonly (string | undefined)[]): string {
  return redactProviderDiagnostic(value, secrets)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DETAIL_LIMIT);
}

export function result(
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

export async function runProbe(
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

export function unavailableResults(
  provider: UnstableProviderContractId,
  detail: string,
): ProviderCanaryResult[] {
  return CHECK_ORDER.map((check) => {
    const required = UNSTABLE_PROVIDER_CONTRACTS[provider].canaries[check] === 'required';
    return result(provider, check, required ? 'skipped' : 'not-applicable', required ? detail : 'not applicable');
  });
}

export async function fetchText(
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

export function requestSignal(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}
