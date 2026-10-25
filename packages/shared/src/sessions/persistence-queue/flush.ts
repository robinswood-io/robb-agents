import type { SessionPersistenceQueue } from '../persistence-queue.ts';

export async function flush(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): Promise<void> {
    const key = transportOwner["resolveIdentityKey"](sessionId, workspaceRootPath);
    if (!key)
        return;
    await transportOwner["flushKey"](key);
}

export async function flushKey(transportOwner: SessionPersistenceQueue, key: string): Promise<void> {
    const entry = transportOwner["pending"].get(key);
    if (entry) {
        clearTimeout(entry.timer);
        await transportOwner["queueWrite"](key);
        return;
    }
    const inProgress = transportOwner["writeInProgress"].get(key);
    if (inProgress) {
        await inProgress;
        // An enqueue may have arrived while the preceding write was running.
        if (transportOwner["pending"].has(key))
            await transportOwner["flushKey"](key);
    }
}

export async function flushDurable(transportOwner: SessionPersistenceQueue, sessionId: string, workspaceRootPath?: string): Promise<void> {
    const key = transportOwner["resolveIdentityKey"](sessionId, workspaceRootPath);
    const initial = key ? transportOwner["pending"].get(key) : undefined;
    if (!initial) {
        throw new Error(`No pending session snapshot is available for durable flush: ${sessionId}`);
    }
    let requiredRevision = initial.revision;
    initial.durable = true;
    clearTimeout(initial.timer);
    while (true) {
        await transportOwner["queueWrite"](key!);
        // An enqueue that raced after write() claimed the preceding snapshot must
        // also cross the barrier before the provider-visible operation can start.
        const pending = transportOwner["pending"].get(key!);
        if (!pending)
            break;
        requiredRevision = pending.revision;
        pending.durable = true;
        clearTimeout(pending.timer);
    }
    if ((transportOwner["lastDurableRevision"].get(key!) ?? 0) < requiredRevision) {
        throw new Error(`Session durability revision ${requiredRevision} was not committed: ${sessionId}`);
    }
}

export async function flushAll(transportOwner: SessionPersistenceQueue): Promise<void> {
    const failures: unknown[] = [];
    while (true) {
        const keys = [...new Set([
                ...transportOwner["pending"].keys(),
                ...transportOwner["writeInProgress"].keys(),
            ])];
        if (keys.length === 0) {
            // Let already-queued debounce callbacks enter queueWrite before declaring
            // the barrier stable. New work admitted during an earlier pass is then
            // included in the next pass rather than being left for process exit.
            await Promise.resolve();
            if (transportOwner["pending"].size === 0 && transportOwner["writeInProgress"].size === 0)
                break;
            continue;
        }
        const results = await Promise.allSettled(keys.map(key => transportOwner["flushKey"](key)));
        for (const result of results) {
            if (result.status === 'rejected')
                failures.push(result.reason);
        }
    }
    if (failures.length === 1)
        throw failures[0];
    if (failures.length > 1) {
        throw new AggregateError(failures, 'Multiple session persistence writes failed while flushing');
    }
}
