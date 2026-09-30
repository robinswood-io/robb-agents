export type PiCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };

export interface PiAuthUpdate {
  provider: string;
  credential: PiCredential;
}

/**
 * Update the durable in-process init snapshot even when the SDK registry has
 * not been created yet. The optional callback updates an already-live registry.
 */
export function applyTokenUpdate(
  update: PiAuthUpdate,
  initConfig: { piAuth?: PiAuthUpdate } | null,
  storeCredential?: (provider: string, credential: PiCredential) => void,
): boolean {
  if (initConfig) {
    initConfig.piAuth = update;
  }

  if (!storeCredential) return false;
  storeCredential(update.provider, update.credential);
  return true;
}
