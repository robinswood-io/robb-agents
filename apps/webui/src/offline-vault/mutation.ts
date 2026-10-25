import type { OfflineVault } from '../offline-vault.ts';
import { VAULT_RECORD_ID } from './persistence.ts';
import { AES_GCM_IV_BYTES, OfflineVaultUnavailableError, OfflineVaultConflictError, emptyState, cloneState, isScopeExpired, normalizeState, isOfflineVaultEnabled } from './shared.ts';
import type { OfflineVaultScopeToken, OfflineVaultState } from './shared.ts';

export async function persistState(transportOwner: OfflineVault, state: OfflineVaultState): Promise<void> {
    const key = await transportOwner["ensureKey"]();
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const encoded = new TextEncoder().encode(JSON.stringify(state));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key.key, encoded);
    const revision = crypto.randomUUID();
    await transportOwner["persistence"].saveRecord({
        id: VAULT_RECORD_ID,
        algorithm: 'AES-GCM',
        iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
        ciphertext,
        updatedAt: state.updatedAt,
        revision,
        keyGeneration: key.generation,
    }, key.generation, transportOwner["recordRevision"]);
    transportOwner["recordRevision"] = revision;
}

export function invalidateAfterConflict(transportOwner: OfflineVault): void {
    transportOwner["key"] = null;
    // Do not let a stale tab reinterpret the intentionally empty in-memory
    // view as an expired scope: that path would clear the newer tab's record.
    // Only an explicit load() may adopt the winning CAS revision.
    transportOwner["loaded"] = false;
    transportOwner["conflicted"] = true;
    transportOwner["recordRevision"] = null;
    transportOwner["state"] = emptyState();
    transportOwner["generation"] += 1;
    transportOwner["emit"]();
}

export function mutate(transportOwner: OfflineVault, update: (state: OfflineVaultState, now: number) => void, expectedScope?: OfflineVaultScopeToken): Promise<boolean> {
    const operation = transportOwner["queue"].then(async () => {
        if (transportOwner["conflicted"])
            throw new OfflineVaultConflictError();
        if (!transportOwner["loaded"])
            await transportOwner["loadNow"]();
        if (transportOwner["conflicted"])
            throw new OfflineVaultConflictError();
        if (!isOfflineVaultEnabled())
            throw new OfflineVaultUnavailableError('Offline storage is not enabled');
        const now = Date.now();
        if (!transportOwner["state"].scope || isScopeExpired(transportOwner["state"].scope, now)) {
            await transportOwner["purgeNow"]();
            throw new OfflineVaultUnavailableError('The offline session has expired');
        }
        if (!transportOwner["scopeTokenMatches"](transportOwner["state"], expectedScope))
            return false;
        const next = normalizeState(cloneState(transportOwner["state"]), now);
        if (!next.scope || isScopeExpired(next.scope, now)) {
            await transportOwner["purgeNow"]();
            throw new OfflineVaultUnavailableError('The offline session has expired');
        }
        update(next, now);
        const normalized = normalizeState(next, now);
        if (!normalized.scope || !transportOwner["scopeTokenMatches"](normalized, expectedScope))
            return false;
        normalized.updatedAt = now;
        // Commit to IndexedDB before publishing the new in-memory snapshot. A
        // failed save therefore cannot leak into a later successful mutation.
        try {
            await transportOwner["persistState"](normalized);
        }
        catch (error) {
            if (error instanceof OfflineVaultConflictError)
                transportOwner["invalidateAfterConflict"]();
            throw error;
        }
        transportOwner["state"] = normalized;
        transportOwner["emit"]();
        return true;
    });
    transportOwner["queue"] = operation.then(() => undefined, () => undefined);
    return operation;
}

export function assertUserMutationCommitted(transportOwner: OfflineVault, committed: boolean): void {
    if (!committed) {
        throw new OfflineVaultUnavailableError('The offline workspace changed before the action was saved');
    }
}
