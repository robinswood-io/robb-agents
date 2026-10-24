import { afterEach, describe, expect, it, mock } from 'bun:test';
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

  it('forwards explicit per-model supportsThinking and maxOutputTokens values for local reasoning models', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'none',
        resolvedModel: 'deepseek-r1-local',
        capabilities: { needsHttpPoolServer: false },
        connection: {
          slug: 'ollama-local',
          name: 'Ollama (Local)',
          providerType: 'pi_compat',
          authType: 'none',
          baseUrl: 'http://127.0.0.1:11434/v1',
          customEndpoint: { api: 'openai-completions' },
          models: [
            { id: 'deepseek-r1-local', contextWindow: 131_072, supportsThinking: true, maxOutputTokens: 32_768 },
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
      { id: 'deepseek-r1-local', contextWindow: 131_072, supportsThinking: true, maxTokens: 32_768 },
    ]);
  });
});

describe('piDriver external subscription bridges', () => {
  it('routes Google Antigravity through its dedicated bridge without the Pi interceptor', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'none',
        resolvedModel: 'pi/gemini-3.7-flash-high',
        capabilities: { needsHttpPoolServer: false },
        connection: { piAuthProvider: 'google-antigravity' } as any,
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        antigravityServerPath: '/tmp/antigravity-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });
    expect(runtime.paths?.piServer).toBe('/tmp/antigravity-server.js');
    expect(runtime.paths?.interceptor).toBeUndefined();
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

describe('piDriver local & custom endpoint model discovery', () => {
  it('discovers local models via /v1/models or Ollama /api/tags fallback, infers capabilities, and preserves user models', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: Parameters<typeof originalFetch>[0]) => {
      const url = String(input);
      if (url === 'http://localhost:11434/v1/models') {
        return new Response('Not Found', { status: 404 });
      }
      if (url === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({
          models: [
            { name: 'qwen3:32b' },
            { name: 'gemma4:27b' },
            { name: 'qwen3-coder:30b' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as unknown as typeof fetch;

    try {
      const result = await piDriver.fetchModels!({
        connection: {
          slug: 'ollama-local',
          name: 'Local Model',
          providerType: 'pi_compat',
          authType: 'none',
          baseUrl: 'http://localhost:11434',
          customEndpoint: { api: 'openai-completions' },
          defaultModel: 'qwen3-coder:30b',
          models: ['custom-local-alias'],
          createdAt: Date.now(),
        } as any,
        credentials: {},
        timeoutMs: 2_000,
        hostRuntime: {} as any,
        resolvedPaths: {
          piServerPath: '/tmp/pi-agent-server.js',
          interceptorBundlePath: '/tmp/interceptor.cjs',
          nodeRuntimePath: '/usr/bin/node',
        },
      });

      expect(result.serverDefault).toBe('qwen3-coder:30b');
      expect(result.models.map(m => m.id)).toEqual([
        'qwen3:32b',
        'gemma4:27b',
        'qwen3-coder:30b',
        'custom-local-alias',
      ]);
      expect(result.models.find(m => m.id === 'qwen3:32b')?.supportsThinking).toBe(true);
      expect(result.models.find(m => m.id === 'gemma4:27b')?.supportsImages).toBe(true);
      expect(result.models.find(m => m.id === 'qwen3-coder:30b')?.supportsThinking).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
