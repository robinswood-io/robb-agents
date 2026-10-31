import { UNSTABLE_PROVIDER_CONTRACTS, type ProviderContractEnvironment } from "../packages/core/src/provider-contracts.ts";

import { runChatGptCanaries } from './robb-provider-canaries/chatgpt.ts';
import type { ProviderCanaryOptions, ProviderCanaryReport } from './robb-provider-canaries/contracts.ts';
import { SECRET_ENVIRONMENT_NAMES, configuredSecret } from './robb-provider-canaries/contracts.ts';
import { defaultCopilotTokenExchange, runCopilotCanaries } from './robb-provider-canaries/copilot.ts';
import { runGoogleCanaries } from './robb-provider-canaries/google.ts';

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
  const requireConfigured = environment["ROBB_PROVIDER_CANARIES_REQUIRED"] === '1'
    || environment["ROBB_PROVIDER_CANARIES_REQUIRED"] === 'true';
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

  const reportPath = process.env["ROBB_PROVIDER_CANARY_REPORT"]?.trim();
  if (reportPath) await Bun.write(reportPath, serialized);
  process.stdout.write(serialized);
  if (!report.summary.ok) process.exitCode = 1;
}

/** Native responsibilities with unchanged entry points and side effects. */
export type { ProviderCanaryResult, ProviderCanaryReport, ProviderCanaryOptions } from './robb-provider-canaries/contracts.ts';
