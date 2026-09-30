import { describe, expect, it } from 'bun:test';
import {
  UNSTABLE_PROVIDER_CONTRACTS,
  assertUnstableProviderContractEnabled,
  deriveGitHubCopilotApiBaseUrl,
  getUnstableProviderContractStatus,
  redactProviderDiagnostic,
} from '../src/provider-contracts.ts';

describe('unstable provider contracts', () => {
  it('records the exact SDK and every required canary dimension', () => {
    for (const contract of Object.values(UNSTABLE_PROVIDER_CONTRACTS)) {
      expect(contract.sdk).toEqual({
        packageName: '@earendil-works/pi-ai',
        exactVersion: '0.80.3',
      });
      expect(Object.keys(contract.canaries).sort()).toEqual([
        'auth',
        'list-models',
        'search',
        'tool-call',
      ]);
      expect(contract.killSwitch).toMatch(/^ROBB_DISABLE_/);
    }
  });

  it('preserves default behavior while honoring scoped and master switches', () => {
    expect(getUnstableProviderContractStatus('chatgpt-codex-backend', {})).toEqual({
      enabled: true,
      reason: 'enabled-by-default',
    });
    expect(getUnstableProviderContractStatus('chatgpt-codex-backend', {
      ROBB_DISABLE_CHATGPT_CODEX_BACKEND: '1',
    })).toMatchObject({ enabled: false, reason: 'kill-switch' });
    expect(getUnstableProviderContractStatus('github-copilot-proxy', {
      ROBB_DISABLE_UNSTABLE_PROVIDERS: 'true',
    })).toMatchObject({ enabled: false, reason: 'kill-switch' });
    expect(getUnstableProviderContractStatus('google-code-assist-v1internal', {
      ROBB_DISABLE_GOOGLE_CODE_ASSIST_V1INTERNAL: '0',
    })).toMatchObject({ enabled: true, reason: 'explicitly-enabled' });
  });

  it('fails closed for malformed kill-switch values', () => {
    const environment = { ROBB_DISABLE_GITHUB_COPILOT_PROXY: 'tru' };
    expect(getUnstableProviderContractStatus('github-copilot-proxy', environment)).toMatchObject({
      enabled: false,
      reason: 'invalid-kill-switch',
    });
    expect(() => assertUnstableProviderContractEnabled('github-copilot-proxy', environment))
      .toThrow('invalid-kill-switch');
  });

  it('derives only GitHub Copilot API hosts from proxy-ep', () => {
    expect(deriveGitHubCopilotApiBaseUrl(
      'tid=1;proxy-ep=proxy.individual.githubcopilot.com;exp=2',
    )).toBe('https://api.individual.githubcopilot.com');
    expect(deriveGitHubCopilotApiBaseUrl(
      'tid=1;proxy-ep=proxy.enterprise.githubcopilot.com;exp=2',
    )).toBe('https://api.enterprise.githubcopilot.com');
    expect(deriveGitHubCopilotApiBaseUrl('proxy-ep=127.0.0.1')).toBeNull();
    expect(deriveGitHubCopilotApiBaseUrl('proxy-ep=githubcopilot.com.evil.test')).toBeNull();
    expect(deriveGitHubCopilotApiBaseUrl('proxy-ep=user@githubcopilot.com')).toBeNull();
  });

  it('redacts explicit and recognizable credentials from diagnostics', () => {
    const secret = 'opaque-super-secret';
    const diagnostic = redactProviderDiagnostic(
      `Authorization: Bearer ${secret}; api_key=sk-testcredential123; url=?access_token=${encodeURIComponent(secret)}`,
      [secret],
    );
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain(encodeURIComponent(secret));
    expect(diagnostic).not.toContain('sk-testcredential123');
    expect(diagnostic).toContain('[REDACTED]');
  });
});
