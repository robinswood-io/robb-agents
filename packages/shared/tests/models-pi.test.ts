import { describe, it, expect } from 'bun:test';
import { getAllPiModels, getPiApiKeyProviders, getPiModelsForAuthProvider } from '../src/config/models-pi.ts';

describe('models-pi filtering', () => {
  it('excludes GPT-5.4 and Mini from the ChatGPT SDK catalog while preserving API access', () => {
    const codexIds = getPiModelsForAuthProvider('openai-codex').map(m => m.id);
    const apiIds = getPiModelsForAuthProvider('openai').map(m => m.id);
    const all = getAllPiModels();
    for (const id of ['pi/gpt-5.4', 'pi/gpt-5.4-mini']) {
      expect(codexIds).not.toContain(id);
      expect(apiIds).toContain(id);
      expect(all.some(m => m.id === id && m.description?.startsWith('openai-codex model'))).toBe(false);
      expect(all.some(m => m.id === id && m.description?.startsWith('openai model'))).toBe(true);
    }
  });

  it('excludes codex-mini-latest for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.includes('pi/codex-mini-latest')).toBe(false);
  });

  it('excludes all gpt-4* models for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.some(id => id.startsWith('pi/gpt-4'))).toBe(false);
  });

  it('exposes current GPT-6 models for OpenAI API and ChatGPT account auth', () => {
    for (const provider of ['openai', 'openai-codex']) {
      const models = getPiModelsForAuthProvider(provider);
      const ids = models.map(m => m.id);
      expect(ids.slice(0, 7)).toEqual([
        'pi/gpt-6.1-sol',
        'pi/gpt-6-astra',
        'pi/gpt-6-sol',
        'pi/gpt-6-luna',
        'pi/gpt-5.6-sol',
        'pi/gpt-5.6-terra',
        'pi/gpt-5.6-luna',
      ]);
      expect(ids.filter(id => id === 'pi/gpt-6-astra')).toHaveLength(1);
      for (const id of ['pi/gpt-6.1-sol', 'pi/gpt-6-sol', 'pi/gpt-6-luna']) {
        expect(models.filter(model => model.id === id)).toEqual([
          expect.objectContaining({
            id,
            contextWindow: 272_000,
            supportsThinking: true,
            supportsImages: true,
          }),
        ]);
      }
      expect(models.find(model => model.id === 'pi/gpt-6-astra')).toMatchObject({
        name: 'GPT-6 Astra',
        shortName: 'Astra',
        contextWindow: 272_000,
        supportsThinking: true,
        supportsImages: true,
      });
    }
  });

  it('excludes deprecated Claude Opus 4.6 models from Anthropic catalogs', () => {
    const anthropicIds = getPiModelsForAuthProvider('anthropic').map(m => m.id);
    expect(anthropicIds).not.toContain('pi/claude-opus-4-6');

    const copilotIds = getPiModelsForAuthProvider('github-copilot').map(m => m.id);
    expect(copilotIds).not.toContain('pi/claude-opus-4.6');

    const bedrockIds = getPiModelsForAuthProvider('amazon-bedrock').map(m => m.id);
    expect(bedrockIds.some(id => id.includes('claude-opus-4-6'))).toBe(false);
  });

  it('exposes the current Anthropic snapshots alongside existing selections', () => {
    const models = getPiModelsForAuthProvider('anthropic');
    for (const id of ['pi/claude-opus-5', 'pi/claude-fable-5-1']) {
      expect(models.filter(model => model.id === id)).toEqual([
        expect.objectContaining({
          id,
          contextWindow: 1_000_000,
          supportsThinking: true,
          supportsImages: true,
        }),
      ]);
    }
    expect(models.map(model => model.id)).toContain('pi/claude-fable-5');
    expect(models.map(model => model.id)).toContain('pi/claude-opus-4-8');
  });

  it('preserves SDK image capabilities for vision and text-only models', () => {
    const mistralModels = getPiModelsForAuthProvider('mistral');
    expect(mistralModels.find(model => model.id === 'pi/mistral-small-latest')).toMatchObject({
      supportsImages: true,
      supportsThinking: true,
    });
    expect(mistralModels.find(model => model.id === 'pi/codestral-latest')).toMatchObject({
      supportsImages: false,
      supportsThinking: false,
    });
  });

  it('includes DeepSeek in the Pi API key provider list with a human-readable label', () => {
    const providers = getPiApiKeyProviders();
    expect(providers.some(provider => provider.key === 'deepseek' && provider.label === 'DeepSeek')).toBe(true);
  });

  it('returns current DeepSeek models from the Pi SDK catalog', () => {
    const models = getPiModelsForAuthProvider('deepseek');
    const ids = models.map(m => m.id);
    expect(ids).toContain('pi/deepseek-v4-flash');
    expect(ids).toContain('pi/deepseek-v4-pro');
  });

  it('exposes Mistral as a native Pi API-key provider with its agentic model family', () => {
    const providers = getPiApiKeyProviders();
    expect(providers.some(provider => provider.key === 'mistral' && provider.label === 'Mistral')).toBe(true);

    const models = getPiModelsForAuthProvider('mistral');
    const ids = models.map(m => m.id);
    expect(ids[0]).toBe('pi/mistral-medium-3-5');
    expect(models.find(model => model.id === 'pi/mistral-medium-3-5')).toMatchObject({
      contextWindow: 262_144,
      supportsThinking: true,
      supportsImages: true,
    });
    expect(ids).toContain('pi/mistral-medium-3.5');
    expect(ids).toContain('pi/mistral-small-latest');
    expect(ids).toContain('pi/devstral-latest');
  });

  it('exposes Mistral Vibe as a separate subscription agent without an API-key catalog', () => {
    const models = getPiModelsForAuthProvider('mistral-vibe');
    expect(models).toEqual([expect.objectContaining({
      id: 'pi/mistral-vibe',
      name: 'Mistral Vibe',
      supportsThinking: false,
      supportsImages: false,
    })]);
  });

  it('exposes the Gemini, Claude, and GPT models reported by the official Antigravity CLI', () => {
    const models = getPiModelsForAuthProvider('google-antigravity');
    const ids = models.map(model => model.id);
    expect(ids.slice(0, 3)).toEqual([
      'pi/gemini-3.8-flash-high',
      'pi/gemini-3.8-flash-medium',
      'pi/gemini-3.8-flash-low',
    ]);
    expect(ids).toContain('pi/claude-sonnet-4-6');
    expect(ids).toContain('pi/claude-opus-4-6-thinking');
    expect(ids).toContain('pi/gpt-oss-120b-medium');
    expect(ids.some(id => id.startsWith('pi/gemini-3.5-flash-'))).toBe(false);
    expect(models.every(model => model.supportsImages === false)).toBe(true);
    expect(models.every(model => model.supportsThinking === false)).toBe(true);

    const sonnet = models.find(m => m.id === 'pi/claude-sonnet-4-6');
    expect(sonnet?.contextWindow).toBe(200_000);
    const gptOss = models.find(m => m.id === 'pi/gpt-oss-120b-medium');
    expect(gptOss?.contextWindow).toBe(131_072);
  });
});
