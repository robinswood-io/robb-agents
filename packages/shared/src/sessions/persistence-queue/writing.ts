import { lstatSync } from "fs";
import { dirname } from "path";
import type { StoredSession } from "../types.js";
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from "../storage.js";
import { toPortablePath } from "../../utils/paths.js";
import { createSessionHeader, readSessionHeader } from "../jsonl.js";
import { debug } from "../../utils/debug.js";
import { writeSessionJsonlTemp } from "../session-jsonl-writer.js";
import type { SessionPersistenceQueue } from '../persistence-queue.ts';
import { SessionPersistenceRootIdentityError, canonicalWorkspaceRoot, assertSessionPersistenceRootIdentity, beginSessionPersistenceWrite, endSessionPersistenceWrite, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata, replaceFileAtomically, commitDurableSessionFile } from './shared.ts';
import type { SessionPersistenceRootIdentity } from './shared.ts';

export function enqueue(transportOwner: SessionPersistenceQueue, session: StoredSession, persistenceRootPath: string, persistenceRootIdentity?: SessionPersistenceRootIdentity): number {
    if (persistenceRootIdentity) {
        persistenceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
    }
    // Check registered aliases before touching disk. Once deletion tombstones a
    // session, a late callback using the old root must not recreate even the
    // workspace/sessions directory after it has been removed.
    const registeredAlias = transportOwner["lookupIdentityAlias"](persistenceRootPath, session.id);
    if (registeredAlias && transportOwner["retired"].has(registeredAlias)) {
        throw new Error(`Session persistence is retired: ${session.id}`);
    }
    // Establish the real lookup directory before deriving identity. Otherwise
    // a root first seen while absent can be keyed case-sensitively, then retire
    // under a different key once its first writer creates the directory.
    ensureSessionsDir(persistenceRootPath);
    if (persistenceRootIdentity) {
        // Bind path-only identities as soon as their workspace is created. The
        // ManagedSession and queued write share this object, so every later
        // operation gains the same device/inode replacement fence.
        const verifiedRoot = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
        const root = lstatSync(verifiedRoot, { bigint: true });
        persistenceRootIdentity.device ??= root.dev.toString();
        persistenceRootIdentity.inode ??= root.ino.toString();
    }
    const key = transportOwner["registerIdentity"](persistenceRootPath, session.id);
    if (transportOwner["retired"].has(key)) {
        throw new Error(`Session persistence is retired: ${session.id}`);
    }
    const canonicalPersistenceRootPath = transportOwner["identities"].get(key)?.workspaceRootPath
        ?? canonicalWorkspaceRoot(persistenceRootPath);
    transportOwner["assertOrBindPersistenceHierarchy"](key, canonicalPersistenceRootPath, session.id, persistenceRootIdentity, { bind: true, requireSession: false });
    const existing = transportOwner["pending"].get(key);
    if (existing) {
        clearTimeout(existing.timer);
    }
    const revision = ++transportOwner["nextRevision"];
    const timer = setTimeout(() => {
        // Debounced background writes have no caller to receive a rejection;
        // `write` already logs the failure. Explicit flush callers still await
        // and receive the same rejection from their own queueWrite promise.
        void transportOwner["queueWrite"](key).catch(() => { });
    }, transportOwner["debounceMs"]);
    transportOwner["pending"].set(key, {
        data: session,
        workspaceRootPath: canonicalPersistenceRootPath,
        persistenceRootIdentity: persistenceRootIdentity ?? existing?.persistenceRootIdentity,
        timer,
        revision,
        // Once a caller has requested a durable barrier, coalescing may advance
        // the snapshot but may not silently weaken that barrier.
        durable: existing?.durable ?? false,
    });
    return revision;
}

/**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
export async function write(transportOwner: SessionPersistenceQueue, key: string): Promise<void> {
    const entry = transportOwner["pending"].get(key);
    if (!entry)
        return;
    transportOwner["pending"].delete(key);
    let filePath: string | undefined;
    let activeWriteKey: string | undefined;
    const previousHeaderSignature = transportOwner["lastWrittenHeaderSignature"].get(key);
    const hadPreviousHeaderSignature = transportOwner["lastWrittenHeaderSignature"].has(key);
    let headerSignatureUpdated = false;
    try {
        const { data, workspaceRootPath, persistenceRootIdentity } = entry;
        let requireSessionDirectory = false;
        const assertDestination = () => {
            if (persistenceRootIdentity) {
                const verifiedRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
                if (verifiedRootPath !== workspaceRootPath) {
                    throw new SessionPersistenceRootIdentityError(`Session persistence destination changed before write: ${data.id}`);
                }
            }
            transportOwner["assertOrBindPersistenceHierarchy"](key, workspaceRootPath, data.id, persistenceRootIdentity, { bind: false, requireSession: requireSessionDirectory });
        };
        await transportOwner["testHooks"]?.beforeWrite?.(data.id);
        assertDestination();
        ensureSessionsDir(workspaceRootPath);
        ensureSessionDir(workspaceRootPath, data.id);
        transportOwner["assertOrBindPersistenceHierarchy"](key, workspaceRootPath, data.id, persistenceRootIdentity, { bind: true, requireSession: true });
        requireSessionDirectory = true;
        assertDestination();
        filePath = getSessionFilePath(workspaceRootPath, data.id);
        activeWriteKey = beginSessionPersistenceWrite(filePath);
        // Prepare session with portable paths for cross-machine compatibility
        const storageSession: StoredSession = {
            ...data,
            workspaceRootPath: toPortablePath(data.workspaceRootPath),
            workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
            sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
            lastUsedAt: Date.now(),
        };
        // Create JSONL content: header + messages (one per line)
        // Filter out intermediate messages - they're transient streaming status updates
        const localHeader = createSessionHeader(storageSession);
        const localSig = getHeaderMetadataSignature(localHeader);
        const diskHeader = readSessionHeader(filePath);
        const previousSig = transportOwner["lastWrittenHeaderSignature"].get(key);
        const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined;
        // Queue writes should never clobber session metadata changed externally
        // (watcher edits, direct header edits, other instances), but they must
        // still persist local metadata updates (e.g. generated title).
        //
        // Preserve disk metadata only when disk diverged from our last written
        // signature, which indicates an external mutation.
        const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig;
        const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig;
        const header = hasExternalMetadataChange && diskHeader
            ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
            : localHeader;
        if (hasMetadataMismatch) {
            const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>';
            const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved';
            debug(`[PersistenceQueue] Session ${data.id} metadata mismatch detected (${mode}${baseline})`);
        }
        // Use original absolute sessionDir (before toPortablePath) for path replacement
        const sessionDir = dirname(filePath);
        // Atomic write: write to .tmp then rename over the real file.
        // If the process crashes mid-write, only the .tmp is corrupted —
        // the original session.jsonl remains intact.
        //
        // Update signature BEFORE the write so that fs.watch events fired
        // during unlink/rename are correctly identified as self-writes.
        // Without this, onSessionMetadataChange sees the stale signature
        // and reverts in-memory metadata on idle sessions.
        const finalSignature = getHeaderMetadataSignature(header);
        transportOwner["lastWrittenHeaderSignature"].set(key, finalSignature);
        headerSignatureUpdated = true;
        const tmpFile = filePath + '.tmp';
        assertDestination();
        await writeSessionJsonlTemp(tmpFile, header, storageSession.messages, sessionDir);
        await transportOwner["testHooks"]?.afterTempWrite?.(data.id);
        assertDestination();
        if (entry.durable) {
            await commitDurableSessionFile(data.id, tmpFile, filePath, transportOwner["testHooks"], assertDestination);
            transportOwner["lastDurableRevision"].set(key, entry.revision);
        }
        else {
            assertDestination();
            await replaceFileAtomically(tmpFile, filePath);
            assertDestination();
        }
        debug(`[PersistenceQueue] Wrote session ${data.id}`);
    }
    catch (error) {
        if (headerSignatureUpdated) {
            if (hadPreviousHeaderSignature)
                transportOwner["lastWrittenHeaderSignature"].set(key, previousHeaderSignature!);
            else
                transportOwner["lastWrittenHeaderSignature"].delete(key);
        }
        const identity = transportOwner["identities"].get(key);
        console.error(`[PersistenceQueue] Failed to write session ${identity?.sessionId ?? '<unknown>'}:`, error);
        throw error;
    }
    finally {
        if (activeWriteKey)
            endSessionPersistenceWrite(activeWriteKey);
    }
}

/** Bound allocations across sessions, including flushAll during restart/quit. */
export async function writeWithGlobalLimit(transportOwner: SessionPersistenceQueue, key: string): Promise<void> {
    if (transportOwner["activeWrites"] < 2) {
        transportOwner["activeWrites"]++;
    }
    else {
        await new Promise<void>(resolve => { transportOwner["waitingWriters"].push(resolve); });
    }
    try {
        // Read pending only after admission so newer snapshots can coalesce and
        // cancellation can still remove work while both slots are occupied.
        await transportOwner["write"](key);
    }
    finally {
        const next = transportOwner["waitingWriters"].shift();
        if (next)
            next(); // Transfer this slot without admitting a third writer.
        else
            transportOwner["activeWrites"]--;
    }
}

/**
   * Append a write to the per-session promise chain. Debounce timers and
   * explicit flushes must both enter through this method; otherwise a timer
   * write can race a flush and both processes can rename the same .tmp file.
   */
export function queueWrite(transportOwner: SessionPersistenceQueue, key: string): Promise<void> {
    const previous = transportOwner["writeInProgress"].get(key) ?? Promise.resolve();
    const writePromise = previous
        .catch(() => { })
        .then(() => transportOwner["writeWithGlobalLimit"](key));
    transportOwner["writeInProgress"].set(key, writePromise);
    const clearCompletedWrite = () => {
        if (transportOwner["writeInProgress"].get(key) === writePromise) {
            transportOwner["writeInProgress"].delete(key);
        }
    };
    void writePromise.then(clearCompletedWrite, clearCompletedWrite);
    return writePromise;
}
