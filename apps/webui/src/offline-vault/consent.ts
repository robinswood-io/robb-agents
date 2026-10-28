import type { OfflineVault } from '../offline-vault.ts';
import { OfflineVaultUnavailableError, OfflineVaultConflictError, emptyState, cloneState, isScopeExpired, normalizeScope, isOfflineVaultEnabled, isOfflineVaultRevocationPending, setOfflineVaultRevocationPending, setOfflineVaultConsent } from './shared.ts';
import type { OfflineVaultScope } from './shared.ts';

export function enable(transportOwner: OfflineVault, scope: OfflineVaultScope): Promise<void> {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope || isScopeExpired(normalizedScope)) {
        return Promise.reject(new OfflineVaultUnavailableError('Remote session is already expired'));
    }
    const operation = transportOwner["queue"].then(async () => {
        if (isOfflineVaultRevocationPending()) {
            await transportOwner["purgeNow"]();
            if (isOfflineVaultRevocationPending()) {
                throw new OfflineVaultUnavailableError('A previous offline-data erasure must finish before enabling storage again');
            }
        }
        if (isOfflineVaultEnabled()) {
            if (!transportOwner["loaded"])
                await transportOwner["loadNow"]();
            const current = transportOwner["state"].scope;
            if (current
                && current.deviceId === normalizedScope.deviceId
                && current.workspaceId === normalizedScope.workspaceId) {
                const next = cloneState(transportOwner["state"]);
                next.scope = normalizedScope;
                next.updatedAt = Date.now();
                try {
                    await transportOwner["persistState"](next);
                }
                catch (error) {
                    if (error instanceof OfflineVaultConflictError)
                        transportOwner["invalidateAfterConflict"]();
                    throw error;
                }
                transportOwner["state"] = next;
                transportOwner["emit"]();
                return;
            }
        }
        if (!transportOwner["loaded"]) {
            const existingRecord = await transportOwner["persistence"].loadRecord();
            transportOwner["recordRevision"] = typeof existingRecord?.revision === 'string' ? existingRecord.revision : null;
        }
        await transportOwner["ensureKey"]();
        const next = emptyState();
        next.scope = normalizedScope;
        // Replace any previous principal's ciphertext before recording consent.
        try {
            await transportOwner["persistState"](next);
        }
        catch (error) {
            if (error instanceof OfflineVaultConflictError)
                transportOwner["invalidateAfterConflict"]();
            throw error;
        }
        try {
            setOfflineVaultConsent(true);
        }
        catch (error) {
            transportOwner.key = null;
            transportOwner["state"] = emptyState();
            transportOwner["loaded"] = true;
            transportOwner["generation"] += 1;
            transportOwner["emit"]();
            throw error;
        }
        transportOwner["state"] = next;
        transportOwner["loaded"] = true;
        transportOwner.conflicted = false;
        transportOwner["generation"] += 1;
        transportOwner["emit"]();
    });
    transportOwner["queue"] = operation.catch(() => { });
    return operation;
}

export async function purgeNow(transportOwner: OfflineVault): Promise<void> {
    let pendingMarkerWritten = false;
    try {
        setOfflineVaultRevocationPending(true);
        pendingMarkerWritten = true;
    }
    catch {
        // Continue: overwriting or clearing IndexedDB can still establish the
        // durable privacy barrier even when localStorage is unavailable.
    }
    // A new page may see the durable revocation marker before it has loaded
    // the record. Resolve its CAS revision without decrypting private content
    // so an empty overwrite remains available when IndexedDB deletion fails.
    let hasStoredRecord = transportOwner["state"].scope !== null || transportOwner["recordRevision"] !== null;
    if (!hasStoredRecord) {
        try {
            const storedRecord = await transportOwner["persistence"].loadRecord();
            if (storedRecord) {
                hasStoredRecord = true;
                transportOwner["recordRevision"] = typeof storedRecord.revision === 'string' ? storedRecord.revision : null;
            }
        }
        catch {
            // clear() below is still an independent erasure path.
        }
    }
    let overwriteSucceeded = false;
    if (hasStoredRecord) {
        try {
            await transportOwner["persistState"](emptyState());
            overwriteSucceeded = true;
        }
        catch {
            // clear() below is the independent erasure path.
        }
    }
    let clearSucceeded = false;
    let persistenceFailure: unknown;
    try {
        await transportOwner["persistence"].clear();
        clearSucceeded = true;
    }
    catch (error) {
        persistenceFailure = error;
    }
    transportOwner.key = null;
    transportOwner["recordRevision"] = null;
    transportOwner["loaded"] = true;
    transportOwner.conflicted = false;
    transportOwner["state"] = emptyState();
    transportOwner["generation"] += 1;
    transportOwner["emit"]();
    const privateDataErased = overwriteSucceeded || clearSucceeded;
    if (privateDataErased) {
        try {
            setOfflineVaultConsent(false);
        }
        catch { /* marker below remains fail-closed */ }
        try {
            setOfflineVaultRevocationPending(false);
        }
        catch { /* no private payload remains */ }
        return;
    }
    // If the durable marker was written, a later load will retry purgeNow()
    // before decrypting. Without either a marker or an erased payload, report
    // the hard failure and keep consent intact so the condition is observable.
    if (!pendingMarkerWritten || persistenceFailure) {
        throw new OfflineVaultUnavailableError('Offline data could not be fully erased from this browser');
    }
}

export function purge(transportOwner: OfflineVault): Promise<void> {
    const operation = transportOwner["queue"].then(() => transportOwner["purgeNow"]());
    transportOwner["queue"] = operation.catch(() => { });
    return operation;
}
