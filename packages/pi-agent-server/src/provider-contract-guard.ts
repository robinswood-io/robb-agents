import {
  assertUnstableProviderContractEnabled,
  type ProviderContractEnvironment,
  type UnstableProviderContractId,
} from '@craft-agent/core';

const PI_PROVIDER_CONTRACTS: Readonly<Record<string, UnstableProviderContractId>> = Object.freeze({
  'openai-codex': 'chatgpt-codex-backend',
  'github-copilot': 'github-copilot-proxy',
  'google-gemini-code-assist': 'google-code-assist-v1internal',
});

export function contractIdForPiAuthProvider(
  provider: string | undefined,
): UnstableProviderContractId | undefined {
  return provider ? PI_PROVIDER_CONTRACTS[provider] : undefined;
}

/** Block inference before the Pi SDK can contact a disabled private endpoint. */
export function assertPiAuthProviderContractEnabled(
  provider: string | undefined,
  environment: ProviderContractEnvironment,
): void {
  const contractId = contractIdForPiAuthProvider(provider);
  if (contractId) assertUnstableProviderContractEnabled(contractId, environment);
}
