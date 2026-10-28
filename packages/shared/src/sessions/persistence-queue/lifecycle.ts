import { debug } from "../../utils/debug.js";
import type { SessionPersistenceQueue } from '../persistence-queue.ts';

export function cancel(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): void {
    const key = transportOwner.resolveIdentityKey(sessionId, workspaceRootPath);
    if (!key)
        return;
    transportOwner.cancelKey(key);
}

export function cancelKey(transportOwner: SessionPersistenceQueue, key: string): void {
    const entry = transportOwner["pending"].get(key);
    if (entry) {
        clearTimeout(entry.timer);
        transportOwner["pending"].delete(key);
        debug(`[PersistenceQueue] Cancelled pending write for session ${entry.data.id}`);
    }
    transportOwner.lastWrittenHeaderSignature.delete(key);
    transportOwner.lastDurableRevision.delete(key);
}

export async function retire(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): Promise<void> {
    const key = workspaceRootPath !== undefined
        ? transportOwner.registerIdentity(workspaceRootPath, sessionId)
        : transportOwner.resolveIdentityKey(sessionId);
    if (!key)
        throw new Error(`Cannot retire unknown session persistence identity: ${sessionId}`);
    transportOwner.retired.add(key);
    while (true) {
        transportOwner.cancelKey(key);
        const inProgress = transportOwner.writeInProgress.get(key);
        if (!inProgress) {
            // A debounce callback that was already queued can enter queueWrite in
            // the same microtask turn. Yield once, then prove the maps are still
            // empty while enqueue remains fenced by the tombstone above.
            await Promise.resolve();
            if (!transportOwner.writeInProgress.has(key) && !transportOwner["pending"].has(key)) {
                transportOwner.cancelKey(key);
                return;
            }
            continue;
        }
        await inProgress.catch(() => undefined);
    }
}

export function reactivate(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): void {
    const key = transportOwner.resolveIdentityKey(sessionId, workspaceRootPath);
    if (!key)
        return;
    if (transportOwner.writeInProgress.has(key) || transportOwner["pending"].has(key)) {
        throw new Error(`Cannot reactivate session persistence while writes are active: ${sessionId}`);
    }
    const identity = transportOwner.identities.get(key);
    if (!identity) {
        throw new Error(`Cannot reactivate unknown session persistence identity: ${sessionId}`);
    }
    transportOwner.assertOrBindPersistenceHierarchy(key, identity.workspaceRootPath, identity.sessionId, undefined, { bind: true, requireSession: identity.sessionDevice !== undefined });
    transportOwner.retired.delete(key);
}

export function isRetired(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): boolean {
    const key = transportOwner.resolveIdentityKey(sessionId, workspaceRootPath);
    return key ? transportOwner.retired.has(key) : false;
}

export function hasPending(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): boolean {
    const key = transportOwner.resolveIdentityKey(sessionId, workspaceRootPath);
    return key ? transportOwner["pending"].has(key) : false;
}

export function getLastWrittenSignature(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): string | undefined {
    const key = transportOwner.resolveIdentityKey(sessionId, workspaceRootPath);
    return key ? transportOwner.lastWrittenHeaderSignature.get(key) : undefined;
}
