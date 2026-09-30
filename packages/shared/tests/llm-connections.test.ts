/**
 * Tests for LLM connection utilities (llm-connections.ts).
 *
 * Focuses on getMiniModel() / findSmallModel() — the provider-aware small
 * model resolution used for title/icon metadata generation.
 */
import { afterEach, describe, it, expect } from 'bun:test';
import {
  getDefaultModelForConnection,
  getDefaultModelsForConnection,
  getMiniModel,
  isDeniedMiniModelId,
  isModelAllowedForAuthProvider,
  registerPiModelResolver,
} from '../src/config/llm-connections.ts';
import type { LlmProviderType } from '../src/config/llm-connections.ts';

// ============================================================
// Helpers
// ============================================================

function makeConnection(providerType: LlmProviderType, models: string[], piAuthProvider?: string) {
  return { providerType, models, piAuthProvider };
}

afterEach(() => {
  registerPiModelResolver(() => []);
});

// ============================================================
// getMiniModel / findSmallModel
// ============================================================

describe('getMiniModel()', () => {
  // --- Anthropic providers ---

  it('finds haiku for anthropic provider', () => {
    const conn = makeConnection('anthropic', [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]);
    expect(getMiniModel(conn)).toBe('claude-haiku-4-5-20251001');
  });

  // --- Pi providers ---

  it('finds mini for pi provider', () => {
    const conn = makeConnection('pi', [
      'pi/gpt-5.2-codex',
      'pi/gpt-5.1-codex-mini',
    ]);
    expect(getMiniModel(conn)).toBe('pi/gpt-5.1-codex-mini');
  });

  it('skips denied codex-mini-latest alias for pi provider', () => {
    const conn = makeConnection('pi', [
      'pi/codex-mini-latest',
      'pi/gpt-5.1-codex-mini',
      'pi/gpt-5.2-codex',
    ]);
    expect(getMiniModel(conn)).toBe('pi/gpt-5.1-codex-mini');
  });

  it('skips denied pi/codex-mini-latest alias for pi provider', () => {
    const conn = makeConnection('pi', [
      'pi/codex-mini-latest',
      'pi/gpt-5.1-codex-mini',
      'pi/gpt-5.3-codex',
    ]);
    expect(getMiniModel(conn)).toBe('pi/gpt-5.1-codex-mini');
  });

  it('finds mini for pi_compat provider', () => {
    const conn = makeConnection('pi_compat', [
      'openai/gpt-5.2-codex',
      'openai/gpt-5.1-codex-mini',
    ]);
    expect(getMiniModel(conn)).toBe('openai/gpt-5.1-codex-mini');
  });

  // --- Pi fallback behavior ---

  it('finds mini for Pi list with mixed models', () => {
    const conn = makeConnection('pi', [
      'pi/claude-sonnet-4.6',
      'pi/gpt-5',
      'pi/gpt-5-mini',
      'pi/o3',
    ]);
    expect(getMiniModel(conn)).toBe('pi/gpt-5-mini');
  });

  it('finds mini even when model name has "mini" in different position', () => {
    const conn = makeConnection('pi', [
      'pi/gpt-5',
      'pi/o4-mini',
      'pi/claude-sonnet-4.6',
    ]);
    expect(getMiniModel(conn)).toBe('pi/o4-mini');
  });

  it('falls back to last model when Pi list has no mini/flash model', () => {
    const conn = makeConnection('pi', [
      'pi/gpt-5',
      'pi/claude-sonnet-4.6',
      'pi/o3',
    ]);
    expect(getMiniModel(conn)).toBe('pi/o3');
  });

  // --- Edge cases ---

  it('returns undefined for empty model list', () => {
    const conn = makeConnection('anthropic', []);
    expect(getMiniModel(conn)).toBeUndefined();
  });

  it('returns undefined for undefined models', () => {
    const conn = { providerType: 'anthropic' as LlmProviderType, models: undefined };
    expect(getMiniModel(conn)).toBeUndefined();
  });

  it('falls back to last model when no keyword match', () => {
    const conn = makeConnection('anthropic', [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    // No haiku in list — falls back to last model
    expect(getMiniModel(conn)).toBe('claude-sonnet-4-6');
  });

  it('fallback ignores denied alias and returns last allowed model', () => {
    const conn = makeConnection('pi', [
      'pi/codex-mini-latest',
      'pi/gpt-5',
      'pi/claude-sonnet-4.6',
    ]);
    expect(getMiniModel(conn)).toBe('pi/claude-sonnet-4.6');
  });

  it('handles single-model list', () => {
    const conn = makeConnection('pi', ['pi/gpt-5']);
    expect(getMiniModel(conn)).toBe('pi/gpt-5');
  });
});

// ============================================================
// Auth-flavor awareness — see isDeniedMiniModelId
// ============================================================

describe('getMiniModel() — auth-flavor awareness', () => {
  it('filters rejected ChatGPT models from saved utility choices without mutating them', () => {
    const conn = makeConnection('pi', ['pi/gpt-5.5', 'pi/gpt-5.4'], 'openai-codex');
    expect(getMiniModel(conn)).toBe('pi/gpt-5.5');
    expect(conn.models).toEqual(['pi/gpt-5.5', 'pi/gpt-5.4']);
    expect(getMiniModel({ ...conn, models: ['pi/gpt-5.4'] })).toBeUndefined();
    expect(getMiniModel({ ...conn, models: ['pi/gpt-5.4-mini'] })).toBeUndefined();
    expect(getMiniModel({ ...conn, models: ['pi/gpt-5.3-codex-spark'] })).toBeUndefined();
    expect(getMiniModel({ ...conn, piAuthProvider: 'openai' })).toBe('pi/gpt-5.4');
  });

  it('filters saved model definitions by ID even when their label matches mini', () => {
    const conn = {
      providerType: 'pi' as const,
      piAuthProvider: 'openai-codex',
      models: [
        { id: 'pi/gpt-5.4', name: 'My mini model', shortName: 'mini', description: '', provider: 'pi' as const, contextWindow: 272_000 },
        { id: 'pi/gpt-5.4-mini', name: 'GPT-5.4 Mini', shortName: 'Mini', description: '', provider: 'pi' as const, contextWindow: 272_000 },
      ],
    };
    expect(getMiniModel(conn)).toBeUndefined();
  });

  it.each(['ids', 'definitions'])('selects only an eligible existing utility model from the observed ChatGPT catalog (%s)', shape => {
    const ids = ['pi/gpt-6-astra', 'pi/gpt-5.6-sol', 'pi/gpt-5.6-terra', 'pi/gpt-5.6-luna',
      'pi/gpt-5.3-codex-spark', 'pi/gpt-5.4-mini', 'pi/gpt-5.5'];
    const models = shape === 'ids' ? ids : ids.map(id => ({
      id, name: id, shortName: id, description: '', provider: 'pi' as const, contextWindow: 272_000,
    }));
    const conn = { providerType: 'pi' as const, piAuthProvider: 'openai-codex', models };
    const before = JSON.stringify(conn);
    expect(getMiniModel(conn)).toBe('pi/gpt-5.6-luna');
    expect(JSON.stringify(conn)).toBe(before);
    expect(getMiniModel({ ...conn, piAuthProvider: 'openai' })).toBe('pi/gpt-5.6-luna');
  });

  it('returns no utility model when every configured candidate is denied for this auth', () => {
    const conn = makeConnection('pi', ['pi/gpt-5.4-mini', 'pi/gpt-5.1-codex-mini'], 'openai-codex');
    expect(getMiniModel(conn)).toBeUndefined();
  });

  it('skips *codex-mini* variants under openai-codex auth', () => {
    // Reproduces the bug surfaced as:
    //   "The 'gpt-5.1-codex-mini' model is not supported when using Codex
    //    with a ChatGPT account."
    // The keyword search would otherwise pick gpt-5.1-codex-mini first.
    const conn = makeConnection(
      'pi',
      ['pi/gpt-5.2-codex', 'pi/gpt-5.1-codex-mini', 'pi/gpt-5-mini'],
      'openai-codex',
    );
    expect(getMiniModel(conn)).toBe('pi/gpt-5-mini');
  });

  it('still returns *codex-mini* variants under regular openai (API-key) auth', () => {
    const conn = makeConnection(
      'pi',
      ['pi/gpt-5.2-codex', 'pi/gpt-5.1-codex-mini'],
      'openai',
    );
    expect(getMiniModel(conn)).toBe('pi/gpt-5.1-codex-mini');
  });

  it('falls back to last allowed model when every mini candidate is denied', () => {
    const conn = makeConnection(
      'pi',
      ['pi/gpt-5', 'pi/gpt-5.1-codex-mini', 'pi/gpt-5.2-codex'],
      'openai-codex',
    );
    // No remaining mini/flash candidate after filtering → falls back to last
    // allowed model (gpt-5.2-codex).
    expect(getMiniModel(conn)).toBe('pi/gpt-5.2-codex');
  });
});

// ============================================================
// Preferred Pi defaults
// ============================================================

describe('getDefaultModelsForConnection() — current OpenAI defaults', () => {
  it('filters an injected or cached ChatGPT catalog before choosing its default', () => {
    const models = ['pi/gpt-5.4', 'pi/gpt-5.4-mini'].map(id => ({
      id, name: id, shortName: id, description: '', provider: 'pi' as const, contextWindow: 272_000,
    }));
    registerPiModelResolver(() => models);
    expect(getDefaultModelsForConnection('pi', 'openai-codex').map(m => typeof m === 'string' ? m : m.id))
      .toEqual([]);
    expect(getDefaultModelForConnection('pi', 'openai-codex')).toBe('');
    expect(getDefaultModelsForConnection('pi', 'openai')).toHaveLength(2);
    expect(models).toHaveLength(2);
    registerPiModelResolver(() => models.slice(0, 1));
    expect(getDefaultModelForConnection('pi', 'openai-codex')).toBe('');
  });

  it('offers Astra after Sol for regular OpenAI API auth without changing the default', () => {
    registerPiModelResolver((provider) => provider === 'openai' ? [
      { id: 'pi/gpt-5.5', name: 'GPT 5.5', shortName: '5.5', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
      { id: 'pi/gpt-5.6-luna', name: 'GPT-5.6 Luna', shortName: 'Luna', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
      { id: 'pi/gpt-6-astra', name: 'GPT-6 Astra', shortName: 'Astra', provider: 'pi', contextWindow: 272000, supportsThinking: true },
      { id: 'pi/gpt-5.6-sol', name: 'GPT-5.6 Sol', shortName: 'Sol', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
      { id: 'pi/gpt-5.6-terra', name: 'GPT-5.6 Terra', shortName: 'Terra', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
    ] : []);

    expect(getDefaultModelsForConnection('pi', 'openai').slice(0, 5).map(m => typeof m === 'string' ? m : m.id)).toEqual([
      'pi/gpt-5.6-sol',
      'pi/gpt-6-astra',
      'pi/gpt-5.6-terra',
      'pi/gpt-5.6-luna',
      'pi/gpt-5.5',
    ]);
    expect(getDefaultModelForConnection('pi', 'openai')).toBe('pi/gpt-5.6-sol');
  });

  it('offers Astra after Sol for ChatGPT account / Codex auth without changing the default', () => {
    registerPiModelResolver((provider) => provider === 'openai-codex' ? [
      { id: 'pi/gpt-5.2', name: 'GPT 5.2', shortName: '5.2', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
      { id: 'pi/gpt-5.6-terra', name: 'GPT-5.6 Terra', shortName: 'Terra', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
      { id: 'pi/gpt-6-astra', name: 'GPT-6 Astra', shortName: 'Astra', provider: 'pi', contextWindow: 272000, supportsThinking: true },
      { id: 'pi/gpt-5.6-luna', name: 'GPT-5.6 Luna', shortName: 'Luna', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
      { id: 'pi/gpt-5.6-sol', name: 'GPT-5.6 Sol', shortName: 'Sol', provider: 'pi', contextWindow: 1048576, supportsThinking: true },
    ] : []);

    expect(getDefaultModelsForConnection('pi', 'openai-codex').slice(0, 5).map(m => typeof m === 'string' ? m : m.id)).toEqual([
      'pi/gpt-5.6-sol',
      'pi/gpt-6-astra',
      'pi/gpt-5.6-terra',
      'pi/gpt-5.6-luna',
      'pi/gpt-5.2',
    ]);
    expect(getDefaultModelForConnection('pi', 'openai-codex')).toBe('pi/gpt-5.6-sol');
  });

  it('uses current agentic Mistral models before legacy catalog entries', () => {
    registerPiModelResolver((provider) => provider === 'mistral' ? [
      { id: 'pi/codestral-latest', name: 'Codestral', shortName: 'Codestral', provider: 'pi', contextWindow: 256000, supportsThinking: false },
      { id: 'pi/mistral-small-latest', name: 'Mistral Small 4', shortName: 'Small 4', provider: 'pi', contextWindow: 256000, supportsThinking: true },
      { id: 'pi/ministral-3b-latest', name: 'Ministral 3B', shortName: '3B', provider: 'pi', contextWindow: 128000, supportsThinking: false },
      { id: 'pi/mistral-medium-3.5', name: 'Mistral Medium 3.5', shortName: 'Medium 3.5', provider: 'pi', contextWindow: 262144, supportsThinking: true },
      { id: 'pi/devstral-latest', name: 'Devstral 2', shortName: 'Devstral', provider: 'pi', contextWindow: 262144, supportsThinking: false },
      { id: 'pi/mistral-medium-3-5', name: 'Mistral Medium 3.5', shortName: 'Medium 3.5', provider: 'pi', contextWindow: 262144, supportsThinking: true },
    ] : []);

    expect(getDefaultModelsForConnection('pi', 'mistral').map(m => typeof m === 'string' ? m : m.id)).toEqual([
      'pi/mistral-medium-3-5',
      'pi/mistral-medium-3.5',
      'pi/mistral-small-latest',
      'pi/ministral-3b-latest',
      'pi/devstral-latest',
      'pi/codestral-latest',
    ]);
    expect(getDefaultModelForConnection('pi', 'mistral')).toBe('pi/mistral-medium-3-5');
  });

  it.each(['anthropic', 'amazon-bedrock'])('ranks actual current Claude IDs without upgrading old IDs for %s', (provider) => {
    const prefix = provider === 'amazon-bedrock' ? 'pi/eu.anthropic.' : 'pi/';
    const ids = ['claude-opus-4-5-20251101', 'claude-opus-4-8', 'claude-fable-5', 'claude-fable-5-1', 'claude-opus-5'];
    const models = ids.map(id => ({ id: `${prefix}${id}`, name: id, shortName: id, provider: 'pi' as const, contextWindow: 1_000_000 }));
    registerPiModelResolver(() => models);

    expect(getDefaultModelForConnection('pi', provider)).toBe(`${prefix}claude-opus-5`);
    const rankedIds = getDefaultModelsForConnection('pi', provider).map(m => typeof m === 'string' ? m : m.id);
    expect(rankedIds.indexOf(`${prefix}claude-opus-4-5-20251101`)).toBeGreaterThan(rankedIds.indexOf(`${prefix}claude-opus-4-8`));
    if (provider === 'anthropic') {
      expect(rankedIds.indexOf(`${prefix}claude-fable-5-1`)).toBeLessThan(rankedIds.indexOf(`${prefix}claude-fable-5`));
    }
    expect(models.map(m => m.id)).toEqual(ids.map(id => `${prefix}${id}`));
  });

  it('prefers an available current Antigravity model at connection creation', () => {
    registerPiModelResolver(() => ['gemini-3.7-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'].map(id => ({
      id: `pi/${id}`, name: id, shortName: id, provider: 'pi', contextWindow: 1_048_576,
    })));
    expect(getDefaultModelForConnection('pi', 'google-antigravity')).toBe('pi/gemini-3.8-flash-high');
  });
});

// ============================================================
// isDeniedMiniModelId — re-exported from this module so getMiniModel and
// the pi-agent-server queryLlm guard share one source of truth.
// ============================================================

describe('isModelAllowedForAuthProvider()', () => {
  it('rejects exact incompatible IDs for ChatGPT-account auth, including supported prefixes', () => {
    for (const id of ['gpt-5.4', 'pi/gpt-5.4', 'openai-codex/gpt-5.4', 'pi/openai-codex/gpt-5.4', ' PI/GPT-5.4 ', 'gpt-5.4-mini', 'pi/gpt-5.4-mini', 'openai-codex/gpt-5.4-mini', 'pi/openai-codex/gpt-5.4-mini', ' PI/GPT-5.4-MINI ', 'gpt-5.3-codex-spark', 'pi/gpt-5.3-codex-spark', 'openai-codex/gpt-5.3-codex-spark', 'pi/openai-codex/gpt-5.3-codex-spark', ' PI/GPT-5.3-CODEX-SPARK ']) {
      expect(isModelAllowedForAuthProvider(id, 'openai-codex')).toBe(false);
      for (const provider of ['openai', 'azure-openai-responses', 'github-copilot', undefined]) {
        expect(isModelAllowedForAuthProvider(id, provider)).toBe(true);
      }
    }
    for (const id of ['gpt-5.4-pro', 'gpt-5.5', 'gpt-5-mini']) {
      expect(isModelAllowedForAuthProvider(id, 'openai-codex')).toBe(true);
    }
  });
});

describe('isDeniedMiniModelId()', () => {
  it('always denies codex-mini-latest', () => {
    expect(isDeniedMiniModelId('codex-mini-latest')).toBe(true);
    expect(isDeniedMiniModelId('pi/codex-mini-latest')).toBe(true);
    expect(isDeniedMiniModelId('codex-mini-latest', 'openai')).toBe(true);
  });

  it('denies *codex-mini* variants only under openai-codex auth', () => {
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini', 'openai-codex')).toBe(true);
    expect(isDeniedMiniModelId('pi/gpt-5.1-codex-mini', 'openai-codex')).toBe(true);
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini', 'openai')).toBe(false);
    expect(isDeniedMiniModelId('gpt-5.1-codex-mini')).toBe(false);
  });

  it('denies auth-incompatible GPT-5.4 Mini for worker utility and compaction guards', () => {
    for (const id of ['gpt-5.4-mini', 'pi/gpt-5.4-mini', 'pi/openai-codex/gpt-5.4-mini']) {
      expect(isDeniedMiniModelId(id, 'openai-codex')).toBe(true);
      expect(isDeniedMiniModelId(id, 'openai')).toBe(false);
    }
  });

  it('denies auth-incompatible Codex Spark for worker utility and compaction guards', () => {
    for (const id of ['gpt-5.3-codex-spark', 'pi/gpt-5.3-codex-spark', 'pi/openai-codex/gpt-5.3-codex-spark']) {
      expect(isDeniedMiniModelId(id, 'openai-codex')).toBe(true);
      expect(isDeniedMiniModelId(id, 'openai')).toBe(false);
    }
  });

  it('does not deny non-codex-mini models', () => {
    expect(isDeniedMiniModelId('gpt-5-mini', 'openai-codex')).toBe(false);
    expect(isDeniedMiniModelId('claude-haiku-4-5', 'openai-codex')).toBe(false);
    expect(isDeniedMiniModelId('gpt-5.1-codex', 'openai-codex')).toBe(false);
  });
});
