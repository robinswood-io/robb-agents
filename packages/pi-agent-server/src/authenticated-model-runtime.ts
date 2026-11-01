import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import type { Credential } from '@earendil-works/pi-ai';
import type { PiAuthUpdate, PiCredential } from './token-update.ts';

function nativeCredential(credential: PiCredential): Credential {
  return credential.type === 'iam'
    ? {
      type: 'api_key',
      env: {
        AWS_ACCESS_KEY_ID: credential.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
        ...(credential.region ? { AWS_REGION: credential.region } : {}),
        ...(credential.sessionToken ? { AWS_SESSION_TOKEN: credential.sessionToken } : {}),
      },
    }
    : credential;
}

/** Host token updates replace credentials through Pi's serialized store. */
export async function storePiCredential(
  store: InMemoryCredentialStore,
  provider: string,
  credential: PiCredential,
): Promise<void> {
  await store.modify(provider, async () => nativeCredential(credential));
}

export async function createAuthenticatedModelRuntime(
  credentials: InMemoryCredentialStore,
  auth?: PiAuthUpdate,
  legacyAnthropicKey?: string,
) {
  const initialAuth = auth ?? (legacyAnthropicKey
    ? { provider: 'anthropic', credential: { type: 'api_key' as const, key: legacyAnthropicKey } }
    : undefined);
  // A new query runtime must not replace tokens refreshed by an earlier runtime.
  // Seeding and host updates share the SDK's per-provider modification lock.
  if (initialAuth) {
    await credentials.modify(initialAuth.provider,
      async current => current ?? nativeCredential(initialAuth.credential));
  }
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}
