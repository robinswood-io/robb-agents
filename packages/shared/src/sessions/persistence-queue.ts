import type { StoredSession } from "./types.js";
import { getHeaderMetadataSignature, mergeHeaderWithExternalMetadata } from './persistence-queue/shared.ts';
import type { PendingWrite, SessionPersistenceIdentity, SessionPersistenceRootIdentity, SessionPersistenceQueueTestHooks } from './persistence-queue/shared.ts';
import * as persistenceQueueIdentity from './persistence-queue/identity.ts';
import * as persistenceQueueWriting from './persistence-queue/writing.ts';
import * as persistenceQueueFlush from './persistence-queue/flush.ts';
import * as persistenceQueueLifecycle from './persistence-queue/lifecycle.ts';
export type { SessionPersistenceRootIdentity } from './persistence-queue/shared.ts';
export { SessionPersistenceRootIdentityError, captureSessionPersistenceRootPath, captureSessionPersistenceRootIdentity, assertSessionPersistenceRootIdentity, isSessionPersistenceWriteInProgress } from './persistence-queue/shared.ts';

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
    private pending = new Map<string, PendingWrite>();
    /** @internal */ public writeInProgress = new Map<string, Promise<void>>();
    /** @internal */ public identities = new Map<string, SessionPersistenceIdentity>();
    /** Exact lexical paths keep their identity even after the workspace is gone. */
    /** @internal */ public identityAliases = new Map<string, string>();
    /** Session-name folding is scoped to one exact canonical workspace root. */
    /** @internal */ public caseInsensitiveCanonicalAliases = new Map<string, string>();
    /**
     * A removed case-insensitive root can only be found by lexical spelling.
     * Keep every candidate instead of allowing a lower-cased path to overwrite a
     * distinct root; ambiguous missing-root lookups fail closed.
     */
    /** @internal */ public caseInsensitiveFallbackAliases = new Map<string, Set<string>>();
    /**
     * A deleted session must never be recreated by a late debounced write or by
     * an asynchronous callback that still holds its old snapshot. Retirement is
     * therefore a tombstone, not just a one-shot cancellation. It is kept for
     * the lifetime of this queue; a failed deletion may explicitly reactivate
     * the session after every in-flight writer has drained.
     */
    /** @internal */ public retired = new Set<string>();
    /** @internal */ public activeWrites = 0;
    /** @internal */ public waitingWriters: Array<() => void> = [];
    /** @internal */ public lastWrittenHeaderSignature = new Map<string, string>();
    /** @internal */ public nextRevision = 0;
    /** @internal */ public lastDurableRevision = new Map<string, number>();
    /** @internal Shared with the extracted backend helpers. */ public debounceMs: number;
    private testHooks?: SessionPersistenceQueueTestHooks;
    constructor(debounceMs = 500, testHooks?: SessionPersistenceQueueTestHooks) {
        this.debounceMs = debounceMs;
        if (testHooks === undefined) { delete this.testHooks } else { this.testHooks = testHooks }
    }
    /** @internal */ public lookupIdentityAlias(workspaceRootPath: string, sessionId: string): string | undefined {
        return persistenceQueueIdentity.lookupIdentityAlias(this, workspaceRootPath, sessionId);
    }
    /** @internal Shared with the extracted backend helpers. */ public recordIdentityAliases(workspaceRootPath: string, canonicalRoot: string, sessionId: string, key: string, caseInsensitive: boolean): void {
        return persistenceQueueIdentity.recordIdentityAliases(this, workspaceRootPath, canonicalRoot, sessionId, key, caseInsensitive);
    }
    /** @internal Shared with the extracted backend helpers. */ public workspaceRootIsCaseInsensitive(workspaceRootPath: string): boolean {
        return persistenceQueueIdentity.workspaceRootIsCaseInsensitiveOperation(this, workspaceRootPath);
    }
    /** @internal */ public assertOrBindPersistenceHierarchy(key: string, workspaceRootPath: string, sessionId: string, persistenceRootIdentity: SessionPersistenceRootIdentity | undefined, options: {
        bind: boolean;
        requireSession: boolean;
    }): void {
        return persistenceQueueIdentity.assertOrBindPersistenceHierarchy(this, key, workspaceRootPath, sessionId, persistenceRootIdentity, options);
    }
    /** @internal Shared with the extracted backend helpers. */ public registerIdentity(workspaceRootPath: string, sessionId: string): string {
        return persistenceQueueIdentity.registerIdentity(this, workspaceRootPath, sessionId);
    }
    /** @internal */ public resolveIdentityKey(sessionId: string, workspaceRootPath?: string): string | undefined {
        return persistenceQueueIdentity.resolveIdentityKey(this, sessionId, workspaceRootPath);
    }
    /**
     * Queue a session for persistence. If a write is already pending for this
     * session, it will be replaced with the new data and the timer reset.
     */
    enqueue(session: StoredSession, persistenceRootPath: string = session.workspaceRootPath, persistenceRootIdentity?: SessionPersistenceRootIdentity): number {
        return persistenceQueueWriting.enqueue(this, session, persistenceRootPath, persistenceRootIdentity);
    }
    /** @internal Shared with the extracted backend helpers. */ public async write(key: string): Promise<void> {
        return persistenceQueueWriting.write(this, key);
    }
    /** @internal Shared with the extracted backend helpers. */ public async writeWithGlobalLimit(key: string): Promise<void> {
        return persistenceQueueWriting.writeWithGlobalLimit(this, key);
    }
    /** @internal Shared with the extracted backend helpers. */ public queueWrite(key: string): Promise<void> {
        return persistenceQueueWriting.queueWrite(this, key);
    }
    /**
     * Immediately flush a specific session if pending.
     * Waits for any in-progress write to complete before starting a new one
     * to prevent race conditions on the shared .tmp file.
     */
    async flush(sessionId: string, workspaceRootPath?: string): Promise<void> {
        return persistenceQueueFlush.flush(this, sessionId, workspaceRootPath);
    }
    /** @internal Shared with the extracted backend helpers. */ public async flushKey(key: string): Promise<void> {
        return persistenceQueueFlush.flushKey(this, key);
    }
    /**
     * Flush the currently queued snapshot with a power-loss durability barrier.
     * The exact pending revision (or a newer coalesced revision) is fsynced before
     * this resolves. Calling without a pending snapshot is an error: an earlier
     * ordinary flush cannot be retroactively claimed as durable.
     */
    async flushDurable(sessionId: string, workspaceRootPath?: string): Promise<void> {
        return persistenceQueueFlush.flushDurable(this, sessionId, workspaceRootPath);
    }
    /**
     * Cancel a pending write for a session (e.g., when deleting the session).
     */
    cancel(sessionId: string, workspaceRootPath?: string): void {
        return persistenceQueueLifecycle.cancel(this, sessionId, workspaceRootPath);
    }
    /** @internal Shared with the extracted backend helpers. */ public cancelKey(key: string): void {
        return persistenceQueueLifecycle.cancelKey(this, key);
    }
    /**
     * Permanently fence a session from new writes and wait for every write that
     * was already admitted to the serialized queue. Callers may safely remove
     * the session directory only after this resolves.
     *
     * Write failures are deliberately absorbed here: `write()` already reports
     * them, and deletion needs the writer to be quiescent rather than successful.
     */
    async retire(sessionId: string, workspaceRootPath?: string): Promise<void> {
        return persistenceQueueLifecycle.retire(this, sessionId, workspaceRootPath);
    }
    /** Restore persistence only when a deletion failed before it committed. */
    reactivate(sessionId: string, workspaceRootPath?: string): void {
        return persistenceQueueLifecycle.reactivate(this, sessionId, workspaceRootPath);
    }
    isRetired(sessionId: string, workspaceRootPath?: string): boolean {
        return persistenceQueueLifecycle.isRetired(this, sessionId, workspaceRootPath);
    }
    /**
     * Flush all pending sessions. Call this on app quit.
     */
    async flushAll(): Promise<void> {
        return persistenceQueueFlush.flushAll(this);
    }
    /**
     * Check if a session has a pending write.
     */
    hasPending(sessionId: string, workspaceRootPath?: string): boolean {
        return persistenceQueueLifecycle.hasPending(this, sessionId, workspaceRootPath);
    }
    /**
     * Get the metadata signature of the last header we wrote for a session.
     * Used by ConfigWatcher to suppress self-triggered metadata change events.
     */
    getLastWrittenSignature(sessionId: string, workspaceRootPath?: string): string | undefined {
        return persistenceQueueLifecycle.getLastWrittenSignature(this, sessionId, workspaceRootPath);
    }
    /**
     * Get count of pending writes.
     */
    get pendingCount(): number {
        return this.pending.size;
    }
}
// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue();
// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
