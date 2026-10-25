/**
 * Credential Manager
 *
 * Main interface for credential storage. Uses encrypted file storage
 * for cross-platform compatibility without OS keychain prompts.
 */
import type { CredentialBackend } from "../backends/types.ts";
import type { CredentialId, CredentialType, StoredCredential } from "../types.ts";
import { SecureStorageBackend } from "../backends/secure-storage.ts";
import { debug } from "../../utils/debug.ts";
import type { CredentialManager } from '../manager.ts';

export async function serializeMutation<T>(transportOwner: CredentialManager, key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = transportOwner["mutationTails"].get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    transportOwner["mutationTails"].set(key, tail);
    await previous.catch(() => undefined);
    try {
        return await mutation();
    }
    finally {
        release();
        if (transportOwner["mutationTails"].get(key) === tail)
            transportOwner["mutationTails"].delete(key);
    }
}

export function llmMutationKey(transportOwner: CredentialManager, type: CredentialType, connectionSlug: string): string {
    return `${type}\u0000${connectionSlug}`;
}

export async function initialize(transportOwner: CredentialManager): Promise<void> {
    await transportOwner["ensureInitialized"]();
}

/**
   * Internal: ensure initialization has completed.
   * Called automatically by all public methods.
   */
export async function ensureInitialized(transportOwner: CredentialManager): Promise<void> {
    if (transportOwner["initialized"]) {
        return;
    }
    // Prevent race condition with concurrent initialization
    if (transportOwner["initPromise"]) {
        return transportOwner["initPromise"];
    }
    // Clear promise on failure so initialization can be retried
    transportOwner["initPromise"] = transportOwner["_doInitialize"]().catch((err) => {
        transportOwner["initPromise"] = null;
        throw err;
    });
    await transportOwner["initPromise"];
}

export function ensureInitializedSync(transportOwner: CredentialManager): void {
    if (transportOwner["initialized"]) {
        return;
    }
    // SecureStorageBackend is always available and is currently the only
    // credential backend. This sync path exists for sync callers such as
    // saveSourceConfig(), where fire-and-forget cleanup can race immediate reloads.
    const backend = new SecureStorageBackend();
    transportOwner["backends"] = [backend];
    transportOwner["writeBackend"] = backend;
    transportOwner["initialized"] = true;
    transportOwner["initPromise"] = null;
    debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
    debug(`[CredentialManager] Using backend: ${backend.name}`);
}

export async function _doInitialize(transportOwner: CredentialManager): Promise<void> {
    const potentialBackends: CredentialBackend[] = [
        new SecureStorageBackend(),
    ];
    const availableBackends: CredentialBackend[] = [];
    // Check which backends are available
    for (const backend of potentialBackends) {
        if (await backend.isAvailable()) {
            availableBackends.push(backend);
            debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
        }
    }
    // A synchronous caller may have initialized the singleton while the async
    // availability checks above were in flight. In that case, keep the sync state
    // instead of appending duplicate backends.
    if (transportOwner["initialized"])
        return;
    // Sort by priority (highest first)
    availableBackends.sort((a, b) => b.priority - a.priority);
    transportOwner["backends"] = availableBackends;
    // Use the first available backend for writing
    transportOwner["writeBackend"] = transportOwner["backends"][0] || null;
    if (transportOwner["writeBackend"]) {
        debug(`[CredentialManager] Using backend: ${transportOwner["writeBackend"].name}`);
    }
    else {
        debug(`[CredentialManager] WARNING: No backend available.`);
    }
    transportOwner["initialized"] = true;
}

export function getActiveBackendName(transportOwner: CredentialManager): string | null {
    return transportOwner["writeBackend"]?.name || null;
}

export async function get(transportOwner: CredentialManager, id: CredentialId): Promise<StoredCredential | null> {
    await transportOwner["ensureInitialized"]();
    let firstError: unknown;
    for (const backend of transportOwner["backends"]) {
        try {
            const cred = await backend.get(id);
            if (cred) {
                debug(`[CredentialManager] Found ${id.type} in ${backend.name}`);
                return cred;
            }
        }
        catch (err) {
            firstError ??= err;
            debug(`[CredentialManager] Error reading from ${backend.name}:`, err);
        }
    }
    if (firstError)
        throw firstError;
    return null;
}

export async function set(transportOwner: CredentialManager, id: CredentialId, credential: StoredCredential): Promise<void> {
    await transportOwner["ensureInitialized"]();
    if (!transportOwner["writeBackend"]) {
        throw new Error('No writable credential backend available');
    }
    await transportOwner["writeBackend"].set(id, credential);
    debug(`[CredentialManager] Saved ${id.type} to ${transportOwner["writeBackend"].name}`);
}

export async function getOrCreate(transportOwner: CredentialManager, id: CredentialId, create: () => StoredCredential): Promise<StoredCredential> {
    await transportOwner["ensureInitialized"]();
    if (!transportOwner["writeBackend"]) {
        throw new Error('No writable credential backend available');
    }
    if (transportOwner["writeBackend"].getOrCreate) {
        return transportOwner["writeBackend"].getOrCreate(id, create);
    }
    const existing = await transportOwner["get"](id);
    if (existing)
        return existing;
    const credential = create();
    await transportOwner["writeBackend"].set(id, credential);
    return credential;
}

export async function deleteOperation(transportOwner: CredentialManager, id: CredentialId): Promise<boolean> {
    await transportOwner["ensureInitialized"]();
    let deleted = false;
    let firstError: unknown;
    for (const backend of transportOwner["backends"]) {
        try {
            if (await backend.delete(id)) {
                deleted = true;
                debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
            }
        }
        catch (err) {
            firstError ??= err;
            debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
        }
    }
    if (!deleted && firstError)
        throw firstError;
    return deleted;
}

export function deleteSync(transportOwner: CredentialManager, id: CredentialId): boolean {
    transportOwner["ensureInitializedSync"]();
    let deleted = false;
    let firstError: unknown;
    for (const backend of transportOwner["backends"]) {
        if (!backend.deleteSync) {
            debug(`[CredentialManager] Backend ${backend.name} does not support synchronous delete`);
            continue;
        }
        try {
            if (backend.deleteSync(id)) {
                deleted = true;
                debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
            }
        }
        catch (err) {
            firstError ??= err;
            debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
        }
    }
    if (!deleted && firstError)
        throw firstError;
    return deleted;
}

export async function list(transportOwner: CredentialManager, filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await transportOwner["ensureInitialized"]();
    const seen = new Set<string>();
    const results: CredentialId[] = [];
    let firstError: unknown;
    for (const backend of transportOwner["backends"]) {
        try {
            const ids = await backend.list(filter);
            for (const id of ids) {
                const key = JSON.stringify(id);
                if (!seen.has(key)) {
                    seen.add(key);
                    results.push(id);
                }
            }
        }
        catch (err) {
            firstError ??= err;
            debug(`[CredentialManager] Error listing from ${backend.name}:`, err);
        }
    }
    if (firstError)
        throw firstError;
    return results;
}
