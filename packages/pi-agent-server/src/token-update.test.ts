import { describe, expect, it } from 'bun:test';

import { applyTokenUpdate, type PiAuthUpdate } from './token-update.ts';

describe('applyTokenUpdate', () => {
  const fresh: PiAuthUpdate = {
    provider: 'openai-codex',
    credential: { type: 'api_key', key: 'fresh-token' },
  };

  it('updates init state before the model registry exists', () => {
    const initConfig: { piAuth?: PiAuthUpdate } = {
      piAuth: {
        provider: 'openai-codex',
        credential: { type: 'api_key', key: 'stale-token' },
      },
    };

    expect(applyTokenUpdate(fresh, initConfig)).toBe(false);
    expect(initConfig.piAuth).toEqual(fresh);
  });

  it('updates init state before pushing the credential into a live registry', () => {
    const initConfig: { piAuth?: PiAuthUpdate } = {};
    const stored: PiAuthUpdate[] = [];

    expect(applyTokenUpdate(fresh, initConfig, (provider, credential) => {
      expect(initConfig.piAuth).toBe(fresh);
      stored.push({ provider, credential });
    })).toBe(true);
    expect(stored).toEqual([fresh]);
  });
});
