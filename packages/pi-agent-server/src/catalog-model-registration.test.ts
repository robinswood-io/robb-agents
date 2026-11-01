import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAuthenticatedModelRuntime } from './authenticated-model-runtime.ts';
import { registerSupplementalCatalogModels } from './catalog-model-registration.ts';
import { resolvePiModel } from './model-resolution.ts';

const openaiModels = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

describe('native catalogue and saved model compatibility', () => {
  for (const provider of ['openai', 'openai-codex', 'anthropic']) {
    it(`uses current native ${provider} models without replacing SDK metadata`, async () => {
      const { modelRegistry } = await createAuthenticatedModelRuntime(new InMemoryCredentialStore(), {
        provider, credential: { type: 'api_key', key: 'offline-fixture' },
      });
      const before = modelRegistry.getAll();
      expect(registerSupplementalCatalogModels(modelRegistry, provider)).toEqual([]);
      expect(modelRegistry.getAll()).toEqual(before);
      const ids = provider === 'anthropic' ? ['claude-opus-5', 'claude-fable-5-1'] : openaiModels;
      for (const id of ids) {
        expect(resolvePiModel(modelRegistry, `pi/${id}`, provider)?.id).toBe(id);
      }
    });
  }

  it('keeps the saved Mistral alias and native models, with idempotent registration', async () => {
    const { modelRegistry } = await createAuthenticatedModelRuntime(new InMemoryCredentialStore(), {
      provider: 'mistral', credential: { type: 'api_key', key: 'offline-fixture' },
    });
    const before = modelRegistry.getAll().filter(model => model.provider === 'mistral');
    const native = modelRegistry.find('mistral', 'mistral-medium-2604')!;
    expect(registerSupplementalCatalogModels(modelRegistry, 'mistral')).toEqual(['mistral-medium-3-5']);
    const alias = resolvePiModel(modelRegistry, 'pi/mistral-medium-3-5', 'mistral')!;
    expect(alias.api).toBe(native.api);
    expect(alias.cost).toEqual(native.cost);
    expect(modelRegistry.getAll().filter(model => model.provider === 'mistral')).toHaveLength(before.length + 1);
    expect(registerSupplementalCatalogModels(modelRegistry, 'mistral')).toEqual([]);
    for (const model of before) expect(modelRegistry.find('mistral', model.id)).toEqual(model);
  });

  it('leaves unknown or unauthenticated providers alone', async () => {
    const { modelRegistry } = await createAuthenticatedModelRuntime(new InMemoryCredentialStore());
    const before = modelRegistry.getAll();
    expect(registerSupplementalCatalogModels(modelRegistry, 'mistral')).toEqual([]);
    expect(registerSupplementalCatalogModels(modelRegistry, 'unknown-provider')).toEqual([]);
    expect(modelRegistry.getAll()).toEqual(before);
  });
  it('resolves saved DeepSeek Flash IDs with the current native transport and metadata', async () => {
    const { modelRegistry } = await createAuthenticatedModelRuntime(new InMemoryCredentialStore(), {
      provider: 'deepseek', credential: { type: 'api_key', key: 'offline-fixture' },
    });
    const native = modelRegistry.find('deepseek', 'deepseek-flash')!;
    expect(registerSupplementalCatalogModels(modelRegistry, 'deepseek')).toEqual([
      'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
    ]);
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      const alias = resolvePiModel(modelRegistry, `pi/${id}`, 'deepseek')!;
      expect(alias).toMatchObject({ provider: native.provider, api: native.api, baseUrl: native.baseUrl,
        contextWindow: native.contextWindow, cost: native.cost, input: native.input });
    }
    expect(registerSupplementalCatalogModels(modelRegistry, 'deepseek')).toEqual([]);
  });

});
