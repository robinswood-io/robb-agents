import { describe, expect, it } from 'bun:test';
import {
  assertPiAuthProviderContractEnabled,
  contractIdForPiAuthProvider,
} from './provider-contract-guard.ts';

describe('Pi provider contract guard', () => {
  it('maps only private provider transports', () => {
    expect(contractIdForPiAuthProvider('openai-codex')).toBe('chatgpt-codex-backend');
    expect(contractIdForPiAuthProvider('github-copilot')).toBe('github-copilot-proxy');
    expect(contractIdForPiAuthProvider('google-gemini-code-assist')).toBe('google-code-assist-v1internal');
    expect(contractIdForPiAuthProvider('openai')).toBeUndefined();
    expect(contractIdForPiAuthProvider(undefined)).toBeUndefined();
  });

  it('blocks private inference while leaving official providers available', () => {
    expect(() => assertPiAuthProviderContractEnabled('openai', {
      ROBB_DISABLE_UNSTABLE_PROVIDERS: '1',
    })).not.toThrow();
    expect(() => assertPiAuthProviderContractEnabled('github-copilot', {
      ROBB_DISABLE_GITHUB_COPILOT_PROXY: '1',
    })).toThrow('GitHub Copilot proxy is disabled by provider contract');
    expect(() => assertPiAuthProviderContractEnabled('google-gemini-code-assist', {
      ROBB_DISABLE_UNSTABLE_PROVIDERS: 'invalid',
    })).toThrow('invalid-kill-switch');
  });
});
