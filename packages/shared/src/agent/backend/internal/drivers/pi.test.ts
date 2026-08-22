import { afterEach, describe, expect, it } from 'bun:test';
import { piDriver } from './pi.ts';

const originalCopilotKillSwitch = process.env.ROBB_DISABLE_GITHUB_COPILOT_PROXY;

afterEach(() => {
  if (originalCopilotKillSwitch === undefined) {
    delete process.env.ROBB_DISABLE_GITHUB_COPILOT_PROXY;
  } else {
    process.env.ROBB_DISABLE_GITHUB_COPILOT_PROXY = originalCopilotKillSwitch;
  }
});

describe('piDriver.buildRuntime custom endpoint models', () => {
  it('preserves explicit per-model supportsImages values', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key',
        resolvedModel: 'vision-model',
        capabilities: { needsHttpPoolServer: false },
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi',
          authType: 'api_key',
          baseUrl: 'http://127.0.0.1:11111/v1',
          customEndpoint: { api: 'anthropic-messages', supportsImages: true },
          models: [
            { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
            { id: 'text-only-model', supportsImages: false },
            { id: 'plain-model' },
          ],
          createdAt: Date.now(),
        } as any,
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      { id: 'text-only-model', supportsImages: false },
      'plain-model',
    ]);
  });
});

describe('piDriver GitHub Copilot contract', () => {
  it('uses the exact SDK static catalog without network when the proxy is disabled', async () => {
    process.env.ROBB_DISABLE_GITHUB_COPILOT_PROXY = '1';
    const result = await piDriver.fetchModels!({
      connection: {
        slug: 'github-copilot',
        name: 'GitHub Copilot',
        providerType: 'pi',
        authType: 'oauth',
        piAuthProvider: 'github-copilot',
        createdAt: Date.now(),
      } as any,
      credentials: { oauthRefreshToken: 'must-not-be-exchanged' },
      timeoutMs: 100,
      hostRuntime: {} as any,
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        vibeAcpServerPath: '/tmp/vibe-acp-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every(model => model.provider === 'pi')).toBe(true);
  });
});
