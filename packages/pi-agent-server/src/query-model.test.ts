import { describe, expect, it } from 'bun:test';
import { activateEphemeralQueryModel, resolveQueryModel } from './query-model.ts';

describe('queryLlm manual model selection', () => {
  it('inherits exactly the selected model or preserves an explicit override', () => {
    expect(resolveQueryModel(undefined, 'pi/selected')).toBe('pi/selected');
    expect(resolveQueryModel('pi/override', 'pi/selected')).toBe('pi/override');
    expect(() => resolveQueryModel(undefined, undefined)).toThrow('selected model is required');
    expect(() => resolveQueryModel('', 'pi/selected')).toThrow('selected model is required');
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

    await expect(run()).rejects.toThrow(/failed to activate selected model.*model not found/i);
    expect(disposeCalls).toBe(1);
    expect(promptCalls).toBe(0);
  });

});
