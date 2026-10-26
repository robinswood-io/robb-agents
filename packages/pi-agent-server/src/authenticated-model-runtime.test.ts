import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAuthenticatedModelRuntime, storePiCredential } from './authenticated-model-runtime.ts';
import { applyTokenUpdate } from './token-update.ts';
import type { PiAuthUpdate } from './token-update.ts';

const initial: PiAuthUpdate = { provider: 'openai-codex', credential: {
  type: 'oauth', access: 'fixture-original', refresh: 'fixture-refresh', expires: Date.now() + 60_000,
} };

describe('native Pi credentials and runtime isolation', () => {
  it('preserves a refreshed credential across additional query runtimes', async () => {
    const credentials = new InMemoryCredentialStore();
    await createAuthenticatedModelRuntime(credentials, initial);
    const refreshed = { type: 'oauth' as const, access: 'fixture-refreshed', refresh: 'fixture-new-refresh', expires: Date.now() + 120_000 };
    await credentials.modify(initial.provider, async () => refreshed);
    await createAuthenticatedModelRuntime(credentials, initial);
    expect(await credentials.read(initial.provider)).toEqual(refreshed);
  });

  it('keeps the latest host update when initialization and an update overlap', async () => {
    const credentials = new InMemoryCredentialStore();
    const latest = { type: 'api_key' as const, key: 'fixture-host-update' };
    const creating = createAuthenticatedModelRuntime(credentials, initial);
    const updating = storePiCredential(credentials, initial.provider, latest);
    await Promise.all([creating, updating]);
    expect(await credentials.read(initial.provider)).toEqual(latest);
  });

  it('awaits the real credential write before acknowledging a host update', async () => {
    const credentials = new InMemoryCredentialStore();
    const config: { piAuth?: PiAuthUpdate } = {};
    const auth = { provider: 'openai', credential: { type: 'api_key', key: 'fixture-key' } } satisfies PiAuthUpdate;
    expect(await applyTokenUpdate(auth, config,
      (provider, value) => storePiCredential(credentials, provider, value))).toBe(true);
    expect(await credentials.read('openai')).toEqual(auth.credential);
  });

  it('maps IAM credentials to native provider environment without changing process.env', async () => {
    const before = process.env.AWS_ACCESS_KEY_ID;
    const credentials = new InMemoryCredentialStore();
    await storePiCredential(credentials, 'amazon-bedrock', { type: 'iam', accessKeyId: 'fixture-id',
      secretAccessKey: 'fixture-secret', sessionToken: 'fixture-session', region: 'eu-west-3' });
    expect(await credentials.read('amazon-bedrock')).toEqual({ type: 'api_key', env: {
      AWS_ACCESS_KEY_ID: 'fixture-id', AWS_SECRET_ACCESS_KEY: 'fixture-secret',
      AWS_SESSION_TOKEN: 'fixture-session', AWS_REGION: 'eu-west-3',
    } });
    expect(process.env.AWS_ACCESS_KEY_ID).toBe(before);
  });
});
