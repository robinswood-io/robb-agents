import { OfflineVaultUnavailableError, OfflineVaultConflictError } from './shared.ts';

export const DB_NAME = 'robb-agents-remote-offline-v1';

export const DB_VERSION = 1;

export const KEY_STORE = 'keys';

export const DATA_STORE = 'data';

export const CONTENT_KEY_ID = 'content-key';

export const VAULT_RECORD_ID = 'vault';

export interface EncryptedVaultRecord {
    id: typeof VAULT_RECORD_ID;
    algorithm: 'AES-GCM';
    iv: ArrayBuffer;
    ciphertext: ArrayBuffer;
    updatedAt: number;
    /** Compare-and-swap token preventing stale tabs from overwriting newer data. */
    revision: string;
    /** Binds ciphertext to the exact non-extractable key generation that encrypted it. */
    keyGeneration?: string;
}

export interface OfflineVaultKey {
    key: CryptoKey;
    generation: string;
}

export interface OfflineVaultPersistence {
    // The CryptoKey union keeps test/custom persistence implementations written
    // against the initial v1 contract source-compatible. IndexedDB always
    // migrates bare keys to OfflineVaultKey before returning them.
    loadKey(): Promise<OfflineVaultKey | CryptoKey | null>;
    /** Atomically keep an existing key or store and return this candidate. */
    saveKey(key: CryptoKey): Promise<OfflineVaultKey | CryptoKey>;
    loadRecord(): Promise<EncryptedVaultRecord | null>;
    /** Commit only while both the key generation and record revision still match. */
    saveRecord(record: EncryptedVaultRecord, expectedKeyGeneration: string, expectedRevision?: string | null): Promise<void>;
    clear(): Promise<void>;
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new OfflineVaultUnavailableError());
    });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new OfflineVaultUnavailableError());
        transaction.onabort = () => reject(transaction.error ?? new OfflineVaultUnavailableError());
    });
}

export async function openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined')
        throw new OfflineVaultUnavailableError();
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(KEY_STORE))
            database.createObjectStore(KEY_STORE);
        if (!database.objectStoreNames.contains(DATA_STORE))
            database.createObjectStore(DATA_STORE, { keyPath: 'id' });
    };
    return requestResult(request);
}

export function persistedVaultKey(value: unknown): OfflineVaultKey | null {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value as Partial<OfflineVaultKey>;
    return candidate.key instanceof CryptoKey
        && typeof candidate.generation === 'string'
        && candidate.generation.length > 0
        ? { key: candidate.key, generation: candidate.generation }
        : null;
}

export const compatibilityKeyGenerations = new WeakMap<CryptoKey, string>();

export function returnedVaultKey(value: OfflineVaultKey | CryptoKey | null): OfflineVaultKey | null {
    const persisted = persistedVaultKey(value);
    if (persisted)
        return persisted;
    if (!(value instanceof CryptoKey))
        return null;
    let generation = compatibilityKeyGenerations.get(value);
    if (!generation) {
        generation = crypto.randomUUID();
        compatibilityKeyGenerations.set(value, generation);
    }
    return { key: value, generation };
}

export function migratePersistedVaultKey(value: unknown): {
    value: OfflineVaultKey | null;
    migrated: boolean;
} {
    const current = persistedVaultKey(value);
    if (current)
        return { value: current, migrated: false };
    // Version 1 initially stored a bare structured-cloned CryptoKey. Preserve it
    // and attach a generation instead of rotating the key and losing ciphertext.
    if (value instanceof CryptoKey) {
        return {
            value: { key: value, generation: crypto.randomUUID() },
            migrated: true,
        };
    }
    return { value: null, migrated: false };
}

export class IndexedDbOfflineVaultPersistence implements OfflineVaultPersistence {
    async loadKey(): Promise<OfflineVaultKey | null> {
        const database = await openDatabase();
        try {
            const transaction = database.transaction(KEY_STORE, 'readwrite');
            const store = transaction.objectStore(KEY_STORE);
            const result = await requestResult(store.get(CONTENT_KEY_ID));
            const migrated = migratePersistedVaultKey(result);
            if (migrated.migrated)
                store.put(migrated.value, CONTENT_KEY_ID);
            await transactionDone(transaction);
            return migrated.value;
        }
        finally {
            database.close();
        }
    }
    async saveKey(key: CryptoKey): Promise<OfflineVaultKey> {
        if (key.extractable)
            throw new OfflineVaultUnavailableError('Refusing to persist an extractable key');
        const database = await openDatabase();
        try {
            const transaction = database.transaction(KEY_STORE, 'readwrite');
            const store = transaction.objectStore(KEY_STORE);
            // Read and conditional write in the same readwrite transaction. IndexedDB
            // serializes competing writers, so simultaneous tabs converge on one key
            // instead of overwriting the key used by the winning ciphertext record.
            const rawCurrent = await requestResult(store.get(CONTENT_KEY_ID));
            const current = migratePersistedVaultKey(rawCurrent);
            const winner = current.value ?? { key, generation: crypto.randomUUID() };
            if (!current.value || current.migrated)
                store.put(winner, CONTENT_KEY_ID);
            await transactionDone(transaction);
            return winner;
        }
        catch (error) {
            throw new OfflineVaultUnavailableError(error instanceof Error ? `Unable to persist the encrypted vault key (${error.name})` : undefined);
        }
        finally {
            database.close();
        }
    }
    async loadRecord(): Promise<EncryptedVaultRecord | null> {
        const database = await openDatabase();
        try {
            const transaction = database.transaction(DATA_STORE, 'readonly');
            const result = await requestResult(transaction.objectStore(DATA_STORE).get(VAULT_RECORD_ID));
            await transactionDone(transaction);
            return result && typeof result === 'object' ? result as EncryptedVaultRecord : null;
        }
        finally {
            database.close();
        }
    }
    async saveRecord(record: EncryptedVaultRecord, expectedKeyGeneration: string, expectedRevision?: string | null): Promise<void> {
        const database = await openDatabase();
        try {
            // Key validation and record CAS share one transaction. A purge/re-key that
            // commits before this transaction therefore makes this write fail instead
            // of leaving ciphertext whose key no longer exists.
            const transaction = database.transaction([KEY_STORE, DATA_STORE], 'readwrite');
            const currentKey = persistedVaultKey(await requestResult(transaction.objectStore(KEY_STORE).get(CONTENT_KEY_ID)));
            if (currentKey?.generation !== expectedKeyGeneration) {
                transaction.abort();
                throw new OfflineVaultConflictError();
            }
            const store = transaction.objectStore(DATA_STORE);
            const current = await requestResult(store.get(VAULT_RECORD_ID)) as EncryptedVaultRecord | undefined;
            const currentRevision = typeof current?.revision === 'string' ? current.revision : null;
            if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
                transaction.abort();
                throw new OfflineVaultConflictError();
            }
            store.put(record);
            await transactionDone(transaction);
        }
        finally {
            database.close();
        }
    }
    async clear(): Promise<void> {
        const database = await openDatabase();
        try {
            const transaction = database.transaction([KEY_STORE, DATA_STORE], 'readwrite');
            transaction.objectStore(KEY_STORE).clear();
            transaction.objectStore(DATA_STORE).clear();
            await transactionDone(transaction);
        }
        finally {
            database.close();
        }
    }
}
