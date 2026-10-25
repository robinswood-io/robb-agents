import type { OfflineVault } from '../offline-vault.ts';
import { OfflineVaultUnavailableError, OfflineVaultConflictError, emptyState, cloneState, isScopeExpired, normalizeState, isOfflineVaultEnabled, isOfflineVaultRevocationPending } from './shared.ts';
import type { OfflineVaultState } from './shared.ts';
import { returnedVaultKey } from './persistence.ts';
import type { OfflineVaultKey } from './persistence.ts';

export async function ensureKey(transportOwner: OfflineVault): Promise<OfflineVaultKey> {
    if (transportOwner["key"])
        return transportOwner["key"];
    const stored = returnedVaultKey(await transportOwner["persistence"].loadKey());
    if (stored) {
        if (stored.key.extractable || stored.key.algorithm.name !== 'AES-GCM') {
            throw new OfflineVaultUnavailableError('Stored key does not meet the vault policy');
        }
        transportOwner["key"] = stored;
        return stored;
    }
    const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (!(generated instanceof CryptoKey) || generated.extractable) {
        throw new OfflineVaultUnavailableError('Unable to create a non-extractable key');
    }
    const winner = returnedVaultKey(await transportOwner["persistence"].saveKey(generated));
    if (!winner)
        throw new OfflineVaultUnavailableError('Unable to persist the encrypted vault key');
    if (winner.key.extractable || winner.key.algorithm.name !== 'AES-GCM') {
        throw new OfflineVaultUnavailableError('Stored key does not meet the vault policy');
    }
    transportOwner["key"] = winner;
    return winner;
}

export async function loadNow(transportOwner: OfflineVault): Promise<OfflineVaultState> {
    if (isOfflineVaultRevocationPending()) {
        await transportOwner["purgeNow"]();
        return cloneState(transportOwner["state"]);
    }
    if (!isOfflineVaultEnabled()) {
        transportOwner["key"] = null;
        transportOwner["recordRevision"] = null;
        transportOwner["state"] = emptyState();
        transportOwner["loaded"] = true;
        transportOwner["conflicted"] = false;
        transportOwner["emit"]();
        return cloneState(transportOwner["state"]);
    }
    const key = await transportOwner["ensureKey"]();
    const record = await transportOwner["persistence"].loadRecord();
    if (!record) {
        transportOwner["recordRevision"] = null;
        transportOwner["state"] = emptyState();
        transportOwner["loaded"] = true;
        transportOwner["conflicted"] = false;
        transportOwner["emit"]();
        return cloneState(transportOwner["state"]);
    }
    transportOwner["recordRevision"] = typeof record.revision === 'string' ? record.revision : null;
    if (record.keyGeneration !== undefined && record.keyGeneration !== key.generation) {
        transportOwner["invalidateAfterConflict"]();
        throw new OfflineVaultConflictError();
    }
    let decoded: Partial<OfflineVaultState>;
    try {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(record.iv) }, key.key, record.ciphertext);
        decoded = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<OfflineVaultState>;
    }
    catch (error) {
        if (error instanceof OfflineVaultConflictError) {
            transportOwner["invalidateAfterConflict"]();
            throw error;
        }
        await transportOwner["purgeNow"]();
        throw new OfflineVaultUnavailableError('Encrypted offline data could not be opened');
    }
    const normalized = normalizeState(decoded, Date.now());
    if (!normalized.scope || isScopeExpired(normalized.scope)) {
        await transportOwner["purgeNow"]();
        return cloneState(transportOwner["state"]);
    }
    if (record.keyGeneration !== key.generation || JSON.stringify(normalized) !== JSON.stringify(decoded)) {
        try {
            // Rewrite when normalization repaired data or a legacy record needs its
            // migrated key generation. Otherwise independent tabs retain one CAS
            // revision instead of producing no-op conflicts.
            normalized.updatedAt = Date.now();
            await transportOwner["persistState"](normalized);
        }
        catch (error) {
            if (error instanceof OfflineVaultConflictError) {
                transportOwner["invalidateAfterConflict"]();
                throw error;
            }
            await transportOwner["purgeNow"]();
            throw new OfflineVaultUnavailableError('Expired offline data could not be removed safely');
        }
    }
    transportOwner["state"] = normalized;
    transportOwner["loaded"] = true;
    transportOwner["conflicted"] = false;
    transportOwner["emit"]();
    return cloneState(transportOwner["state"]);
}

export function load(transportOwner: OfflineVault): Promise<OfflineVaultState> {
    const operation = transportOwner["queue"].then(() => transportOwner["loadNow"]());
    transportOwner["queue"] = operation.then(() => undefined, () => undefined);
    return operation;
}
