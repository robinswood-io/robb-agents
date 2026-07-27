/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file at ~/.craft-agent/credentials.enc
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy credentials are auto-migrated on first load.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "CRAFT01\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { hostname, userInfo, homedir } from 'os';
import { join, dirname } from 'path';

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';

// File location — shared with existing Craft Agents installs by default, unless
// CRAFT_CONFIG_DIR explicitly selects an isolated profile.
const CREDENTIALS_DIR = CONFIG_DIR;
const DEFAULT_CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.enc');

// File format constants
const MAGIC_BYTES = Buffer.from('CRAFT01\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
function getStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: username + homedir (stable enough for most cases)
  return `${userInfo().username}:${homedir()}`;
}

/** Internal credential store structure */
interface CredentialStore {
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

const mutationQueues = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCredentialStore(value: unknown): value is CredentialStore {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.credentials) || !isRecord(value.metadata)) {
    return false;
  }
  if (typeof value.metadata.createdAt !== 'number' || typeof value.metadata.updatedAt !== 'number') {
    return false;
  }
  return Object.values(value.credentials).every(
    (credential) => isRecord(credential) && typeof credential.value === 'string',
  );
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;
  private readonly credentialsFile: string;
  private readonly credentialsDir: string;
  private readonly machineId: string;

  constructor(options: SecureStorageOptions = {}) {
    this.credentialsFile = options.credentialsFile ?? DEFAULT_CREDENTIALS_FILE;
    this.credentialsDir = dirname(this.credentialsFile);
    this.machineId = options.machineId ?? getStableMachineId();
  }

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] || null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    const key = credentialIdToAccount(id);
    await this.enqueueMutation(() => {
      this.withFileLockSync(() => {
        this.clearCache();
        const store = this.loadStoreSync() ?? this.createEmptyStore();
        store.credentials[key] = credential;
        store.metadata.updatedAt = Date.now();
        this.saveStoreSync(store);
      });
    });
  }

  async delete(id: CredentialId): Promise<boolean> {
    const key = credentialIdToAccount(id);
    return this.enqueueMutation(() => this.withFileLockSync(() => this.deleteByKeySync(key)));
  }

  deleteSync(id: CredentialId): boolean {
    const key = credentialIdToAccount(id);
    if (mutationQueues.has(this.credentialsFile)) {
      throw new CredentialStoreError(
        'write_conflict',
        'Credential store has a pending write; synchronous deletion was refused',
      );
    }
    return this.withFileLockSync(() => this.deleteByKeySync(key));
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    // Return cached store if available
    if (this.cachedStore) return this.cachedStore;

    if (!existsSync(this.credentialsFile)) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(this.credentialsFile);
    } catch (error) {
      throw new CredentialStoreError('read_failed', 'Credential store could not be read', { cause: error });
    }

    // Validate minimum size
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      throw new CredentialStoreError('corrupted', 'Credential store is truncated');
    }

    // Validate magic bytes
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      throw new CredentialStoreError('corrupted', 'Credential store header is invalid');
    }

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // Try new stable key first (v2 - hardware UUID based)
    const newKey = this.getEncryptionKey(salt);
    let store = this.tryDecrypt(encryptedData, newKey);

    if (store) {
      this.cachedStore = store;
      return store;
    }

    // Try legacy key for migration (v1 - included hostname)
    // This handles credentials encrypted with old key derivation
    const legacyKey = this.getLegacyEncryptionKey(salt);
    store = this.tryDecrypt(encryptedData, legacyKey);

    if (store) {
      // Migration: re-save with new stable key so future loads use hardware UUID
      this.cachedStore = store;
      this.saveStoreSync(store);
      return store;
    }

    // Preserve the original bytes for recovery. Authentication failure can be
    // caused by a machine migration and must never be treated as permission to
    // delete the only copy of the user's credentials.
    throw new CredentialStoreError(
      'decryption_failed',
      'Credential store authentication failed; the encrypted file was preserved',
    );
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const parsed: unknown = JSON.parse(decrypted.toString('utf8'));
      return isCredentialStore(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private saveStoreSync(store: CredentialStore): void {
    // Ensure directory exists
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Get encryption key
    const key = this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // Write atomically with restrictive permissions so a crash cannot leave a
    // partially-written primary file. rename() is atomic on the same volume.
    const tempFile = `${this.credentialsFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    let tempFd: number | null = null;
    try {
      tempFd = openSync(tempFile, 'wx', 0o600);
      writeFileSync(tempFd, fileData);
      fsyncSync(tempFd);
      closeSync(tempFd);
      tempFd = null;
      renameSync(tempFile, this.credentialsFile);
      chmodSync(this.credentialsFile, 0o600);
    } catch (error) {
      if (tempFd !== null) closeSync(tempFd);
      if (existsSync(tempFile)) unlinkSync(tempFile);
      throw error;
    }
    this.cachedStore = store;
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // New stable machine ID using hardware UUID (v2)
    // This is far more stable than hostname which can change with network/DHCP
    const stableMachineId = createHash('sha256')
      .update(this.machineId)
      .update('craft-agent-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');

    return this.encryptionKey;
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('craft-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  private createEmptyStore(): CredentialStore {
    const now = Date.now();
    return {
      version: 1,
      credentials: {},
      metadata: { createdAt: now, updatedAt: now },
    };
  }

  private deleteByKeySync(key: string): boolean {
    this.clearCache();
    const store = this.loadStoreSync();
    if (!store || !(key in store.credentials)) return false;
    delete store.credentials[key];
    store.metadata.updatedAt = Date.now();
    this.saveStoreSync(store);
    return true;
  }

  private enqueueMutation<T>(operation: () => T): Promise<T> {
    const previous = mutationQueues.get(this.credentialsFile) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    mutationQueues.set(this.credentialsFile, tail);
    void tail.finally(() => {
      if (mutationQueues.get(this.credentialsFile) === tail) {
        mutationQueues.delete(this.credentialsFile);
      }
    });
    return result;
  }

  private withFileLockSync<T>(operation: () => T): T {
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    }
    const lockFile = `${this.credentialsFile}.lock`;
    let lockFd: number;
    try {
      lockFd = openSync(lockFile, 'wx', 0o600);
    } catch (error) {
      throw new CredentialStoreError(
        'write_conflict',
        'Credential store is locked by another writer; mutation was refused',
        { cause: error },
      );
    }

    try {
      writeFileSync(lockFd, `${process.pid}\n`, 'utf8');
      fsyncSync(lockFd);
      return operation();
    } finally {
      closeSync(lockFd);
      if (existsSync(lockFile)) unlinkSync(lockFile);
    }
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
  }
}
