import { isUnknownArray } from '../../../utils/json.ts';
import type { StoredCredential } from "../../types.ts";

/** Internal credential store structure */
export interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export type CredentialStoreErrorCode =
  | 'read_failed'
  | 'corrupted'
  | 'decryption_failed'
  | 'write_conflict';

export class CredentialStoreError extends Error {
  constructor(
    readonly code: CredentialStoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CredentialStoreError';
  }
}

export interface SecureStorageOptions {
  /** Override used by isolated profiles and tests. */
  credentialsFile?: string;
  /** Deterministic machine binding used by tests; production resolves the OS machine ID. */
  machineId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isUnknownArray(value);
}

export function isCredentialStore(value: unknown): value is CredentialStore {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["credentials"]) || !isRecord(value["metadata"])) {
    return false;
  }
  if (typeof value["metadata"]["createdAt"] !== 'number' || typeof value["metadata"]["updatedAt"] !== 'number') {
    return false;
  }
  return Object.values(value["credentials"]).every(
    (credential) => isRecord(credential) && typeof credential["value"] === 'string',
  );
}
