import type { OfflineVault } from '../offline-vault.ts';
import { OfflineVaultUnavailableError, OfflineVaultConflictError, emptyState, cloneState, isScopeExpired, normalizeScope, isOfflineVaultEnabled } from './shared.ts';
import type { OfflineVaultScope, OfflineVaultScopeToken, OfflineVaultState } from './shared.ts';

export function getScopeToken(transportOwner: OfflineVault): OfflineVaultScopeToken | null {
    const scope = transportOwner["state"].scope;
    if (!scope || isScopeExpired(scope))
        return null;
    return {
        generation: transportOwner["generation"],
        deviceId: scope.deviceId,
        workspaceId: scope.workspaceId,
    };
}

export function scopeTokenMatches(transportOwner: OfflineVault, state: OfflineVaultState, token: OfflineVaultScopeToken | undefined): boolean {
    if (!token)
        return true;
    return token.generation === transportOwner["generation"]
        && token.deviceId === state.scope?.deviceId
        && token.workspaceId === state.scope?.workspaceId;
}

export function configureScope(transportOwner: OfflineVault, scope: OfflineVaultScope): Promise<void> {
    const normalizedScope = normalizeScope(scope);
    if (!normalizedScope || isScopeExpired(normalizedScope)) {
        return Promise.reject(new OfflineVaultUnavailableError('Remote session is already expired'));
    }
    const operation = transportOwner["queue"].then(async () => {
        if (!isOfflineVaultEnabled())
            return;
        if (!transportOwner["loaded"])
            await transportOwner["loadNow"]();
        if (!isOfflineVaultEnabled() || !transportOwner["state"].scope)
            return;
        const current = transportOwner["state"].scope;
        const identityChanged = current.deviceId !== normalizedScope.deviceId
            || current.workspaceId !== normalizedScope.workspaceId;
        const next = identityChanged ? emptyState() : cloneState(transportOwner["state"]);
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
        transportOwner["conflicted"] = false;
        if (identityChanged)
            transportOwner["generation"] += 1;
        transportOwner["emit"]();
    });
    transportOwner["queue"] = operation.catch(() => { });
    return operation;
}
