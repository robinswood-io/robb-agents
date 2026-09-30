import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from '@earendil-works/pi-coding-agent';
import {
  resolveInitialPiModel,
  resolvePiModelWithCustomFallback,
  requireExplicitPiModel,
  resolvePiModel,
  isDeniedMiniModelId,
  isModelNotFoundError,
} from './model-resolution.ts';

/**
 * Minimal mock of PiModelRegistry.
 * Maps provider → modelId → model object.
 */
function createMockRegistry(
  providers: Record<string, Array<{ id: string; name: string; provider?: string }>>,
) {
  const allModels = Object.entries(providers).flatMap(([provider, models]) =>
    models.map(m => ({ ...m, provider })),
  );

  return {
    find(provider: string, modelId: string) {
      const models = providers[provider];
      if (!models) return undefined;
      return models.find(m => m.id === modelId || m.name === modelId) ?? undefined;
    },
    getAll() {
      return allModels;
    },
  } as any;
}

describe('initial Pi session model', () => {
  it('makes an absent or empty Codex model explicit using supported provider preferences', () => {
    const registry = createMockRegistry({
      'openai-codex': [
        { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai-codex' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai-codex' },
        { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', provider: 'openai-codex' },
        { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai-codex' },
      ],
    });
    for (const id of [undefined, '']) {
      expect(resolveInitialPiModel(registry, id, 'openai-codex')).toMatchObject({ id: 'gpt-5.5', provider: 'openai-codex' });
    }
    expect(() => resolveInitialPiModel(registry, 'pi/gpt-5.4-mini', 'openai-codex')).toThrow('could not be resolved');
    expect(() => resolveInitialPiModel(registry, 'pi/gpt-5.4', 'openai-codex')).toThrow('could not be resolved');
    expect(() => resolveInitialPiModel(registry, 'pi/gpt-5.3-codex-spark', 'openai-codex')).toThrow('could not be resolved');
    expect(resolveInitialPiModel(registry, undefined, 'openai')).toBeUndefined();
    expect(resolveInitialPiModel(registry, '', 'openai')).toBeUndefined();
  });

  it('falls back only within the authenticated provider and fails if all its models are retired', () => {
    const registry = createMockRegistry({
      'openai-codex': [{ id: 'gpt-5.4-mini', name: 'Mini', provider: 'openai-codex' }],
      openai: [{ id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' }],
    });
    expect(() => resolveInitialPiModel(registry, undefined, 'openai-codex')).toThrow('No supported Pi model');
    const retired = createMockRegistry({
      'openai-codex': [{ id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai-codex' }],
      openai: [{ id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai' }],
      'custom-endpoint': [{ id: 'gpt-5.5', name: 'GPT-5.5', provider: 'custom-endpoint' }],
    });
    expect(() => resolveInitialPiModel(retired, undefined, 'openai-codex', true)).toThrow('No supported Pi model');
  });

  it('prevents the real SDK from restoring GPT-5.4 from saved settings or session history', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'robb-pi-model-policy-'));
    try {
      for (const withHistory of [false, true]) {
        const authStorage = AuthStorage.inMemory();
        authStorage.set('openai-codex', { type: 'api_key', key: 'fixture-no-network' });
        const modelRegistry = ModelRegistry.inMemory(authStorage);
        const settingsManager = SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: 'gpt-5.4' });
        const sessionManager = SessionManager.inMemory(directory);
        if (withHistory) {
          sessionManager.appendModelChange('openai-codex', 'gpt-5.4');
          sessionManager.appendMessage({ role: 'user', content: 'Isolated test fixture', timestamp: 1 });
        }
        const resourceLoader = new DefaultResourceLoader({
          cwd: directory, agentDir: directory, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        });
        await resourceLoader.reload();
        const model = resolveInitialPiModel(modelRegistry, undefined, 'openai-codex');
        const { session } = await createAgentSession({
          cwd: directory, agentDir: directory, authStorage, modelRegistry,
          settingsManager, sessionManager, resourceLoader, model, tools: [],
        });
        try {
          expect(session.model?.provider).toBe('openai-codex');
          expect(session.model?.id).not.toBe('gpt-5.4');
          expect(session.model?.id).toBe(model?.id);
        } finally {
          session.dispose();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('dynamic custom-endpoint model fallback', () => {
  it('never registers forbidden Codex models, but preserves regular API registration', () => {
    for (const provider of ['openai-codex', 'openai']) {
      let registrationCalls = 0;
      let registered: { id: string; name: string; provider: string } | undefined;
      const registry = {
        find: (candidateProvider: string, id: string) => candidateProvider === 'custom-endpoint' && registered?.id === id ? registered : undefined,
        getAll: () => registered ? [registered] : [],
      } as any;
      const result = resolvePiModelWithCustomFallback(registry, 'pi/gpt-5.4', provider, true, id => {
        registrationCalls += 1;
        registered = { id, name: id, provider: 'custom-endpoint' };
      });
      expect(registrationCalls).toBe(provider === 'openai' ? 1 : 0);
      if (provider === 'openai') expect(result?.id).toBe('gpt-5.4');
      else expect(result).toBeUndefined();
    }
  });

  it('revalidates the model returned after dynamic registration', () => {
    let registered = false;
    const registry = {
      find: () => registered ? { id: 'gpt-5.4', name: 'Alias', provider: 'custom-endpoint' } : undefined,
      getAll: () => [],
    } as any;
    expect(resolvePiModelWithCustomFallback(registry, 'Alias', 'openai-codex', true, () => { registered = true; })).toBeUndefined();
  });
});

describe('resolvePiModel', () => {
  describe('ChatGPT model eligibility', () => {
    const registry = createMockRegistry(Object.fromEntries(
      ['openai-codex', 'openai', 'custom-endpoint'].map(provider => [provider, [
        { id: 'gpt-5.4', name: 'GPT-5.4', provider },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider },
        { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', provider },
      ]]),
    ));

    it('rejects exact and prefixed incompatible models without falling through to another provider', () => {
      for (const id of ['gpt-5.4', 'pi/gpt-5.4', 'openai-codex/gpt-5.4', 'pi/openai-codex/gpt-5.4', 'gpt-5.4-mini', 'pi/gpt-5.4-mini', 'openai-codex/gpt-5.4-mini', 'pi/openai-codex/gpt-5.4-mini', 'gpt-5.3-codex-spark', 'pi/gpt-5.3-codex-spark', 'openai-codex/gpt-5.3-codex-spark', 'pi/openai-codex/gpt-5.3-codex-spark']) {
        expect(resolvePiModel(registry, id, 'openai-codex')).toBeUndefined();
        expect(resolvePiModel(registry, id, 'openai-codex', true)).toBeUndefined();
        expect(() => requireExplicitPiModel(registry, id, 'openai-codex')).toThrow('could not be resolved');
      }
    });

    it('also rejects a name alias that resolves to the forbidden model ID', () => {
      expect(resolvePiModel(registry, 'GPT-5.4', 'openai-codex')).toBeUndefined();
      expect(resolvePiModel(registry, 'GPT-5.4', 'openai-codex', true)).toBeUndefined();
      const aliased = createMockRegistry({
        'openai-codex': [{ id: 'gpt-5.4', name: 'Old saved choice', provider: 'openai-codex' }],
      });
      expect(resolvePiModel(aliased, 'Old saved choice', 'openai-codex')).toBeUndefined();
      expect(resolvePiModel({ ...aliased, find: () => undefined }, 'Old saved choice', 'openai-codex')).toBeUndefined();
    });

    it('preserves GPT-5.4 and Mini on regular API providers', () => {
      expect(requireExplicitPiModel(registry, 'pi/gpt-5.4-mini', 'openai').id).toBe('gpt-5.4-mini');
      expect(requireExplicitPiModel(registry, 'pi/gpt-5.4', 'openai').provider).toBe('openai');
      expect(requireExplicitPiModel(registry, 'pi/gpt-5.4', 'openai', true).provider).toBe('custom-endpoint');
      expect(requireExplicitPiModel(registry, 'pi/gpt-5.3-codex-spark', 'openai').id).toBe('gpt-5.3-codex-spark');
    });

    it('fails closed on ambiguous providerless matches while preserving unambiguous lookup', () => {
      expect(resolvePiModel(registry, 'gpt-5.4')).toBeUndefined();
      const openaiOnly = createMockRegistry({
        openai: [{ id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai' }],
      });
      expect(resolvePiModel(openaiOnly, 'gpt-5.4')?.provider).toBe('openai');
      const codexOnly = createMockRegistry({
        'openai-codex': [{ id: 'gpt-5.4', name: 'Old saved choice', provider: 'openai-codex' }],
      });
      expect(resolvePiModel(codexOnly, 'Old saved choice')).toBeUndefined();
    });
  });

  describe('preferCustomEndpoint', () => {
    it('returns custom-endpoint model when preferCustomEndpoint=true and model exists in both providers', () => {
      const registry = createMockRegistry({
        'custom-endpoint': [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'custom-endpoint' }],
        anthropic: [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'anthropic' }],
      });

      const result = resolvePiModel(registry, 'claude-sonnet-4-6', 'anthropic', true);
      expect(result).toBeDefined();
      expect(result!.provider).toBe('custom-endpoint');
    });

    it('returns anthropic model when preferCustomEndpoint=false', () => {
      const registry = createMockRegistry({
        'custom-endpoint': [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'custom-endpoint' }],
        anthropic: [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'anthropic' }],
      });

      const result = resolvePiModel(registry, 'claude-sonnet-4-6', 'anthropic', false);
      expect(result).toBeDefined();
      expect(result!.provider).toBe('anthropic');
    });

    it('rejects a missing custom endpoint model instead of switching to the auth provider', () => {
      const registry = createMockRegistry({
        'custom-endpoint': [],
        anthropic: [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'anthropic' }],
      });

      const result = resolvePiModel(registry, 'claude-sonnet-4-6', 'anthropic', true);
      expect(result).toBeUndefined();
    });
  });

  describe('exact provider lookup', () => {
    it('returns exact match for piAuthProvider', () => {
      const registry = createMockRegistry({
        openai: [{ id: 'gpt-5.2', name: 'GPT 5.2', provider: 'openai' }],
        'azure-openai-responses': [{ id: 'gpt-5.2', name: 'GPT 5.2', provider: 'azure-openai-responses' }],
      });

      const result = resolvePiModel(registry, 'gpt-5.2', 'openai');
      expect(result).toBeDefined();
      expect(result!.provider).toBe('openai');
    });

    it('strips MiniMax- prefix for minimax-cn provider', () => {
      const registry = createMockRegistry({
        'minimax-cn': [{ id: 'MiniMax-M2.5-highspeed', name: 'MiniMax-M2.5-highspeed', provider: 'minimax-cn' }],
      });

      const result = resolvePiModel(registry, 'MiniMax-M2.5-highspeed', 'minimax-cn');
      expect(result).toBeDefined();
      expect(result!.id).toBe('M2.5-highspeed');
    });
  });

  describe('pi/ prefix stripping', () => {
    it('strips pi/ prefix from model ID', () => {
      const registry = createMockRegistry({
        anthropic: [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', provider: 'anthropic' }],
      });

      const result = resolvePiModel(registry, 'pi/claude-sonnet-4-6', 'anthropic');
      expect(result).toBeDefined();
      expect(result!.id).toBe('claude-sonnet-4-6');
    });
  });

  describe('legacy unambiguous lookup', () => {
    it('falls through getAll scan when no exact match', () => {
      const registry = createMockRegistry({
        google: [{ id: 'gemini-pro', name: 'Gemini Pro', provider: 'google' }],
      });

      const result = resolvePiModel(registry, 'gemini-pro');
      expect(result).toBeDefined();
      expect(result!.id).toBe('gemini-pro');
    });

    it('does not search common providers when none is explicitly configured', () => {
      // Model not in getAll by id/name match, but findable via provider lookup
      const registry = {
        find(provider: string, modelId: string) {
          if (provider === 'custom-endpoint' && modelId === 'my-model') {
            return { id: 'my-model', name: 'My Model', provider: 'custom-endpoint' };
          }
          return undefined;
        },
        getAll() {
          return [];
        },
      } as any;

      const result = resolvePiModel(registry, 'my-model');
      expect(result).toBeUndefined();
    });

    it('rejects an ambiguous model ID instead of choosing the first provider', () => {
      const registry = createMockRegistry({
        openai: [{ id: 'same-model', name: 'same-model', provider: 'openai' }],
        anthropic: [{ id: 'same-model', name: 'same-model', provider: 'anthropic' }],
      });
      expect(resolvePiModel(registry, 'same-model')).toBeUndefined();
    });

    it('returns undefined when model not found anywhere', () => {
      const registry = createMockRegistry({
        anthropic: [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' }],
      });

      const result = resolvePiModel(registry, 'nonexistent-model');
      expect(result).toBeUndefined();
    });
  });

  describe('provider boundary', () => {
    it('does not return a model from an incompatible provider via getAll fallback', () => {
      // gpt-5.4 exists under azure-openai-responses but NOT github-copilot.
      // With github-copilot auth, the fallback must not return the azure model.
      const registry = createMockRegistry({
        'github-copilot': [{ id: 'gpt-5.3-codex', name: 'GPT-5.3-Codex', provider: 'github-copilot' }],
        'azure-openai-responses': [{ id: 'gpt-5.4', name: 'GPT-5.4', provider: 'azure-openai-responses' }],
      });

      const result = resolvePiModel(registry, 'gpt-5.4', 'github-copilot');
      expect(result).toBeUndefined();
    });

    it('returns same-provider model from getAll fallback when exact lookup misses', () => {
      const registry = {
        find() {
          return undefined;
        },
        getAll() {
          return [{ id: 'gpt-5.4', name: 'GPT-5.4', provider: 'github-copilot' }];
        },
      } as any;

      const result = resolvePiModel(registry, 'gpt-5.4', 'github-copilot');
      expect(result).toBeDefined();
      expect(result!.provider).toBe('github-copilot');
    });

    it('does not switch to a custom endpoint without an explicit endpoint selection', () => {
      const registry = createMockRegistry({
        'custom-endpoint': [{ id: 'my-model', name: 'My Model', provider: 'custom-endpoint' }],
        'github-copilot': [],
      });

      const result = resolvePiModel(registry, 'my-model', 'github-copilot');
      expect(result).toBeUndefined();
    });

    it('does not filter by provider when piAuthProvider is not set', () => {
      const registry = createMockRegistry({
        'azure-openai-responses': [{ id: 'gpt-5.4', name: 'GPT-5.4', provider: 'azure-openai-responses' }],
      });

      const result = resolvePiModel(registry, 'gpt-5.4');
      expect(result).toBeDefined();
      expect(result!.provider).toBe('azure-openai-responses');
    });

    it('skips incompatible providers in the common-provider fallback loop', () => {
      // Model findable via the 'openai' common provider, but piAuthProvider is 'github-copilot'
      const registry = {
        find(provider: string, modelId: string) {
          if (provider === 'openai' && modelId === 'gpt-5.4') {
            return { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai' };
          }
          return undefined;
        },
        getAll() { return []; },
      } as any;

      const result = resolvePiModel(registry, 'gpt-5.4', 'github-copilot');
      expect(result).toBeUndefined();
    });
  });
});

describe('requireExplicitPiModel', () => {
  it('returns the explicitly selected model when it resolves', () => {
    const registry = createMockRegistry({
      openai: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai' }],
    });

    expect(requireExplicitPiModel(registry, 'pi/gpt-5.6-sol', 'openai')).toMatchObject({
      id: 'gpt-5.6-sol',
      provider: 'openai',
    });
  });

  it('throws instead of allowing the SDK default when the selection is unresolved', () => {
    const registry = createMockRegistry({
      openai: [{ id: 'gpt-5.5', name: 'GPT-5.5' }],
    });

    expect(() => requireExplicitPiModel(registry, 'pi/gpt-5.6-sol', 'openai')).toThrow(
      'Explicitly selected Pi model "pi/gpt-5.6-sol" could not be resolved for provider "openai"',
    );
  });

  it('throws if a registry returns an incompatible provider', () => {
    const registry = {
      find(provider: string, modelId: string) {
        if (provider === 'openai' && modelId === 'gpt-5.6-sol') {
          return { id: modelId, name: 'GPT-5.6 Sol', provider: 'anthropic' };
        }
        return undefined;
      },
      getAll() { return []; },
    } as any;

    expect(() => requireExplicitPiModel(registry, 'gpt-5.6-sol', 'openai')).toThrow(
      'resolved to incompatible provider "anthropic"',
    );
  });
});

describe('isDeniedMiniModelId', () => {
  it('denies codex-mini-latest regardless of auth provider', () => {
    expect(isDeniedMiniModelId('codex-mini-latest')).toBe(true);
    expect(isDeniedMiniModelId('pi/codex-mini-latest')).toBe(true);
    expect(isDeniedMiniModelId('codex-mini-latest', 'openai')).toBe(true);
    expect(isDeniedMiniModelId('codex-mini-latest', 'openai-codex')).toBe(true);
  });

  it('denies *codex-mini* variants when piAuthProvider is openai-codex (ChatGPT account)', () => {
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini', 'openai-codex')).toBe(true);
    expect(isDeniedMiniModelId('pi/gpt-5.1-codex-mini', 'openai-codex')).toBe(true);
    expect(isDeniedMiniModelId('gpt-5.2-codex-mini-preview', 'openai-codex')).toBe(true);
  });

  it('allows *codex-mini* variants when piAuthProvider is a regular openai API key', () => {
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini', 'openai')).toBe(false);
    expect(isDeniedMiniModelId('pi/gpt-5.1-codex-mini', 'openai')).toBe(false);
  });

  it('allows non-codex-mini models under openai-codex auth', () => {
    expect(isDeniedMiniModelId('gpt-5.1-codex', 'openai-codex')).toBe(false);
    expect(isDeniedMiniModelId('gpt-5-mini', 'openai-codex')).toBe(false);
    expect(isDeniedMiniModelId('claude-haiku-4-5', 'openai-codex')).toBe(false);
  });

  it('treats unset piAuthProvider as unrestricted (only the hardcoded denylist applies)', () => {
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini')).toBe(false);
    expect(isDeniedMiniModelId('gpt-5-mini')).toBe(false);
  });
});

describe('isModelNotFoundError', () => {
  it('matches the ChatGPT-account Codex refusal', () => {
    expect(
      isModelNotFoundError(
        "The 'gpt-5.1-codex-mini' model is not supported when using Codex with a ChatGPT account.",
      ),
    ).toBe(true);
  });

  it('matches classic OpenAI model_not_found shapes', () => {
    expect(isModelNotFoundError('The model `gpt-99` does not exist')).toBe(true);
    expect(isModelNotFoundError('Error code: model_not_found')).toBe(true);
    expect(isModelNotFoundError('No such model: foo-bar')).toBe(true);
    expect(isModelNotFoundError('The requested model is not available or does not exist')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isModelNotFoundError('MODEL_NOT_FOUND')).toBe(true);
    expect(isModelNotFoundError('Is Not Supported')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isModelNotFoundError('rate limit exceeded')).toBe(false);
    expect(isModelNotFoundError('invalid api key')).toBe(false);
    expect(isModelNotFoundError('')).toBe(false);
  });
});
