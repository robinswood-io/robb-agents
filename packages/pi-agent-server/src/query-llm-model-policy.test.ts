import { describe, expect, it } from 'bun:test';

import {
  activateEphemeralQueryModel,
  selectCompatibleQueryModel,
  shouldRetryQueryModel,
} from './query-llm-model-policy.ts';

describe('queryLlm model policy', () => {
  it('fails closed without evaluating a fallback for an incompatible explicit model', () => {
    let fallbackCalls = 0;

    expect(() => selectCompatibleQueryModel({
      modelId: 'pi/gpt-5.6-sol',
      explicitlyRequested: true,
      compatible: false,
      authProvider: 'openai-codex',
      resolvedProvider: 'openai',
      getFallbackModel: () => {
        fallbackCalls += 1;
        return 'pi/gpt-5-mini';
      },
    })).toThrow(/explicit mini model/i);
    expect(fallbackCalls).toBe(0);
  });

  it('retains provider fallback for an implicit mini model', () => {
    expect(selectCompatibleQueryModel({
      modelId: 'pi/incompatible-default',
      explicitlyRequested: false,
      compatible: false,
      authProvider: 'openai-codex',
      resolvedProvider: 'anthropic',
      getFallbackModel: () => 'pi/gpt-5-mini',
    })).toBe('pi/gpt-5-mini');
  });

  it('disposes and throws before prompting when setModel is rejected', async () => {
    let disposeCalls = 0;
    let promptCalls = 0;
    const session = {
      async setModel(): Promise<void> {
        throw new Error('model not found');
      },
      dispose(): void {
        disposeCalls += 1;
      },
      async prompt(): Promise<void> {
        promptCalls += 1;
      },
    };

    const run = async () => {
      await activateEphemeralQueryModel(session, { id: 'gpt-5.6-sol' }, 'pi/gpt-5.6-sol');
      await session.prompt();
    };

    await expect(run()).rejects.toThrow(/failed to activate mini model.*model not found/i);
    expect(disposeCalls).toBe(1);
    expect(promptCalls).toBe(0);
  });

  it('never enters model-not-found fallback for an explicit request', () => {
    const error = new Error('404 model_not_found: gpt-5.6-sol');
    expect(shouldRetryQueryModel(error, true)).toBe(false);
    expect(shouldRetryQueryModel(error, false)).toBe(true);
  });
});
