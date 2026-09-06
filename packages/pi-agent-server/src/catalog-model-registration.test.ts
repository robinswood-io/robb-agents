import { describe, expect, it } from 'bun:test';
import {
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
} from '@earendil-works/pi-coding-agent';
import { registerOAuthProvider, unregisterOAuthProvider } from '@earendil-works/pi-ai/oauth';

import { registerSupplementalCatalogModels } from './catalog-model-registration.ts';
import { resolvePiModel } from './model-resolution.ts';

const OPENAI_SUPPLEMENTAL_IDS = [
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
];

const OPENAI_SUPPLEMENTAL_COSTS = {
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
};

const OPENAI_SUPPLEMENTAL_CONTEXT_WINDOWS = {
  'gpt-6-astra': 272_000,
  'gpt-5.6-sol': 1_048_576,
  'gpt-5.6-terra': 1_048_576,
  'gpt-5.6-luna': 1_048_576,
};

describe('registerSupplementalCatalogModels', () => {
  for (const provider of ['openai', 'openai-codex']) {
    it(`registers and resolves recent OpenAI models for ${provider} without removing SDK models`, () => {
      const authStorage = provider === 'openai'
        ? PiAuthStorage.inMemory({
          [provider]: { type: 'api_key', key: 'test-api-key' },
        })
        : PiAuthStorage.inMemory({
          [provider]: {
            type: 'oauth',
            access: 'test-access-token',
            refresh: 'test-refresh-token',
            expires: Date.now() + 60_000,
          },
        });
      const registry = PiModelRegistry.inMemory(authStorage);
      const templateBefore = registry.find(provider, 'gpt-5.5');
      const providerModelCountBefore = registry.getAll().filter(model => model.provider === provider).length;

      expect(templateBefore).toBeDefined();
      expect(registry.find(provider, OPENAI_SUPPLEMENTAL_IDS[0]!)).toBeUndefined();

      expect(registerSupplementalCatalogModels(registry, provider)).toEqual(OPENAI_SUPPLEMENTAL_IDS);

      for (const modelId of OPENAI_SUPPLEMENTAL_IDS) {
        const resolved = resolvePiModel(registry, `pi/${modelId}`, provider);
        expect(resolved).toBeDefined();
        expect(resolved!.provider).toBe(provider);
        expect(resolved!.api).toBe(templateBefore!.api);
        expect(resolved!.baseUrl).toBe(templateBefore!.baseUrl);
        expect(resolved!.contextWindow).toBe(
          OPENAI_SUPPLEMENTAL_CONTEXT_WINDOWS[modelId as keyof typeof OPENAI_SUPPLEMENTAL_CONTEXT_WINDOWS],
        );
        expect(resolved!.maxTokens).toBe(128_000);
        expect(resolved!.cost).toEqual(
          OPENAI_SUPPLEMENTAL_COSTS[modelId as keyof typeof OPENAI_SUPPLEMENTAL_COSTS],
        );
        expect(resolved!.reasoning).toBe(true);
      }

      expect(resolvePiModel(registry, 'pi/gpt-6-astra', provider)?.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
      });

      expect(registry.find(provider, 'gpt-5.5')).toMatchObject({
        api: templateBefore!.api,
        baseUrl: templateBefore!.baseUrl,
      });
      expect(registry.getAll().filter(model => model.provider === provider)).toHaveLength(
        providerModelCountBefore + OPENAI_SUPPLEMENTAL_IDS.length,
      );

      // Repeated registry setup calls must not duplicate supplemental entries.
      expect(registerSupplementalCatalogModels(registry, provider)).toEqual([]);
      expect(registry.getAll().filter(model => model.provider === provider)).toHaveLength(
        providerModelCountBefore + OPENAI_SUPPLEMENTAL_IDS.length,
      );
    });
  }

  it('leaves providers without a runtime registration rule unchanged', () => {
    const authStorage = PiAuthStorage.inMemory({
      anthropic: { type: 'api_key', key: 'test-api-key' },
    });
    const registry = PiModelRegistry.inMemory(authStorage);
    const countBefore = registry.getAll().length;

    expect(registerSupplementalCatalogModels(registry, 'anthropic')).toEqual([]);
    expect(registry.getAll()).toHaveLength(countBefore);
  });

  it('preserves openai-codex OAuth refresh and stores the refreshed credential', async () => {
    const builtInProvider = PiAuthStorage.inMemory()
      .getOAuthProviders()
      .find(provider => provider.id === 'openai-codex');
    expect(builtInProvider).toBeDefined();

    let refreshCalls = 0;
    registerOAuthProvider({
      ...builtInProvider!,
      async refreshToken(credentials) {
        refreshCalls += 1;
        return {
          ...credentials,
          access: 'refreshed-access-token',
          expires: Date.now() + 60_000,
        };
      },
    });

    try {
      const authStorage = PiAuthStorage.inMemory({
        'openai-codex': {
          type: 'oauth',
          access: 'expired-access-token',
          refresh: 'refresh-token',
          expires: 0,
        },
      });
      const credentialBefore = authStorage.get('openai-codex');
      const registry = PiModelRegistry.inMemory(authStorage);

      registerSupplementalCatalogModels(registry, 'openai-codex');
      expect(authStorage.get('openai-codex')).toBe(credentialBefore);

      const model = registry.find('openai-codex', 'gpt-6-astra');
      expect(model).toBeDefined();
      expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
        ok: true,
        apiKey: 'refreshed-access-token',
      });
      expect(refreshCalls).toBe(1);
      expect(authStorage.get('openai-codex')).toMatchObject({
        type: 'oauth',
        access: 'refreshed-access-token',
      });
    } finally {
      unregisterOAuthProvider('openai-codex');
    }
  });

  it('never falls back to an expired OAuth access token when refresh fails', async () => {
    const builtInProvider = PiAuthStorage.inMemory()
      .getOAuthProviders()
      .find(provider => provider.id === 'openai-codex');
    expect(builtInProvider).toBeDefined();

    registerOAuthProvider({
      ...builtInProvider!,
      async refreshToken() {
        throw new Error('simulated refresh failure');
      },
    });

    try {
      const authStorage = PiAuthStorage.inMemory({
        'openai-codex': {
          type: 'oauth',
          access: 'expired-access-token',
          refresh: 'refresh-token',
          expires: 0,
        },
      });
      const registry = PiModelRegistry.inMemory(authStorage);

      registerSupplementalCatalogModels(registry, 'openai-codex');
      const model = registry.find('openai-codex', 'gpt-6-astra');
      expect(model).toBeDefined();

      const auth = await registry.getApiKeyAndHeaders(model!);
      expect(auth.ok).toBe(true);
      if (auth.ok) {
        expect(auth.apiKey).toBeUndefined();
      }
      expect(authStorage.drainErrors()).toHaveLength(1);
    } finally {
      unregisterOAuthProvider('openai-codex');
    }
  });
});
