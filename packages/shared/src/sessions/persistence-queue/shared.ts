import { open, rename, unlink } from "fs/promises";
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync, type BigIntStats } from "fs";
import { randomUUID } from "crypto";
import { basename, dirname, join, resolve } from "path";
import type { StoredSession, SessionHeader } from "../types.js";
import type { SessionPersistenceRootIdentity } from './identity-types.ts';
export type { SessionPersistenceIdentity, SessionPersistenceRootIdentity } from './identity-types.ts';

export interface PendingWrite {
    data: StoredSession;
    /** Canonical destination captured at enqueue, immune to symlink retargeting. */
    workspaceRootPath: string;
    /** Physical root proof checked again when the debounced write actually runs. */
    persistenceRootIdentity?: SessionPersistenceRootIdentity;
    timer: ReturnType<typeof setTimeout>;
    revision: number;
    durable: boolean;
}

export const canonicalWorkspaceRoots = new Map<string, string>();

export const caseInsensitiveSessionsDirectories = new Map<string, boolean>();

export class SessionPersistenceRootIdentityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionPersistenceRootIdentityError';
    }
}

export function physicalDirectoryStats(path: string, label: string): BigIntStats {
    let directory: BigIntStats;
    try {
        directory = lstatSync(path, { bigint: true });
    }
    catch {
        throw new SessionPersistenceRootIdentityError(`${label} is unavailable: ${path}`);
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new SessionPersistenceRootIdentityError(`${label} is not a physical directory: ${path}`);
    }
    return directory;
}

export function optionalPhysicalDirectoryStats(path: string, label: string): BigIntStats | undefined {
    try {
        const directory = lstatSync(path, { bigint: true });
        if (!directory.isDirectory() || directory.isSymbolicLink()) {
            throw new SessionPersistenceRootIdentityError(`${label} is not a physical directory: ${path}`);
        }
        return directory;
    }
    catch (error) {
        if (error instanceof SessionPersistenceRootIdentityError)
            throw error;
        if (isErrnoException(error) && error.code === 'ENOENT')
            return undefined;
        throw new SessionPersistenceRootIdentityError(`${label} could not be inspected: ${path}`);
    }
}

export function assertDirectoryIdentityPair(path: string, label: string, directory: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'> | undefined, device: string | undefined, inode: string | undefined, birthtimeNs?: string): void {
    if ((device === undefined) !== (inode === undefined)) {
        throw new SessionPersistenceRootIdentityError(`${label} identity is incomplete: ${path}`);
    }
    if (device === undefined)
        return;
    if (!directory
        || directory.dev.toString() !== device
        || directory.ino.toString() !== inode
        || (birthtimeNs !== undefined && directory.birthtimeNs.toString() !== birthtimeNs)) {
        throw new SessionPersistenceRootIdentityError(`${label} was replaced: ${path}`);
    }
}

export function bindSessionContainerIdentity(identity: SessionPersistenceRootIdentity, canonicalRoot: string): BigIntStats {
    const sessionsPath = join(canonicalRoot, 'sessions');
    const sessions = physicalDirectoryStats(sessionsPath, 'Session persistence directory');
    assertDirectoryIdentityPair(sessionsPath, 'Session persistence directory', sessions, identity.sessionsDevice, identity.sessionsInode, identity.sessionsBirthtimeNs);
    identity.sessionsDevice ??= sessions.dev.toString();
    identity.sessionsInode ??= sessions.ino.toString();
    identity.sessionsBirthtimeNs ??= sessions.birthtimeNs.toString();
    return sessions;
}

export function canonicalWorkspaceRoot(workspaceRootPath: string): string {
    const absolute = resolve(workspaceRootPath);
    try {
        // Refresh live roots on every identity operation. A workspace symlink can
        // be retargeted during a long-running process; a lexical cache hit must not
        // keep sending its new target through the old persistence chain.
        const canonical = realpathSync.native(absolute);
        canonicalWorkspaceRoots.set(absolute, canonical);
        return canonical;
    }
    catch {
        // Preserve the last proven target after deletion so late callbacks still
        // meet its tombstone. Never cache an unproven lexical fallback: once a new
        // root exists, the next operation must discover it.
        return canonicalWorkspaceRoots.get(absolute) ?? absolute;
    }
}

/**
 * Resolve the deepest existing ancestor and append the still-missing suffix.
 * This preserves physical aliases such as macOS `/tmp` -> `/private/tmp`
 * even when the workspace directory itself has not been created yet.
 */
export function canonicalMissingWorkspaceRoot(workspaceRootPath: string): string {
    let cursor = resolve(workspaceRootPath);
    const suffix: string[] = [];
    while (true) {
        try {
            return join(realpathSync.native(cursor), ...suffix);
        }
        catch {
            const parent = dirname(cursor);
            if (parent === cursor)
                return resolve(workspaceRootPath);
            suffix.unshift(basename(cursor));
            cursor = parent;
        }
    }
}

/**
 * Capture the physical workspace root that owns a managed session.
 *
 * The returned path is intentionally stable: callers keep it for the lifetime
 * of the ManagedSession so a later retarget of a lexical workspace symlink
 * cannot redirect that session's writes, retirement fence, or deletion to a
 * different workspace.
 */
export function captureSessionPersistenceRootPath(workspaceRootPath: string): string {
    return canonicalWorkspaceRoot(workspaceRootPath);
}

/** Capture the directory object, not only its pathname. */
export function captureSessionPersistenceRootIdentity(workspaceRootPath: string): SessionPersistenceRootIdentity {
    const canonicalRoot = canonicalWorkspaceRoot(workspaceRootPath);
    try {
        const root = lstatSync(canonicalRoot, { bigint: true });
        if (!root.isDirectory() || root.isSymbolicLink()) {
            throw new SessionPersistenceRootIdentityError(`Session persistence root is not a physical directory: ${canonicalRoot}`);
        }
        const sessionsPath = join(canonicalRoot, 'sessions');
        const sessions = optionalPhysicalDirectoryStats(sessionsPath, 'Session persistence directory');
        return {
            workspaceRootPath: canonicalRoot,
            device: root.dev.toString(),
            inode: root.ino.toString(),
            birthtimeNs: root.birthtimeNs.toString(),
            ...(sessions ? { sessionsDevice: sessions.dev.toString(), sessionsInode: sessions.ino.toString(), sessionsBirthtimeNs: sessions.birthtimeNs.toString() } : {}),
        };
    }
    catch (error) {
        if (error instanceof SessionPersistenceRootIdentityError)
            throw error;
        if (!isErrnoException(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
            throw new SessionPersistenceRootIdentityError(`Session persistence root identity could not be captured: ${canonicalRoot}`);
        }
        // Some unit/in-memory session fixtures are created before their workspace
        // directory. They retain stable pathname semantics but cannot claim an
        // inode proof that did not exist at capture time.
        return { workspaceRootPath: canonicalMissingWorkspaceRoot(canonicalRoot) };
    }
}

/** Fail closed if the captured physical workspace directory was replaced. */
export function assertSessionPersistenceRootIdentity(identity: SessionPersistenceRootIdentity): string {
    const hasPhysicalProof = identity.device !== undefined || identity.inode !== undefined;
    if ((identity.device === undefined) !== (identity.inode === undefined)) {
        throw new SessionPersistenceRootIdentityError(`Session persistence root identity is incomplete: ${identity.workspaceRootPath}`);
    }
    let canonicalRoot: string;
    try {
        canonicalRoot = realpathSync.native(resolve(identity.workspaceRootPath));
    }
    catch {
        // A few construction/test paths intentionally create the workspace on the
        // first persistence operation. They cannot be protected by an inode until
        // that directory exists, but they must retain the canonical parent path
        // captured above and may not follow a later symlink target.
        if (!hasPhysicalProof)
            return identity.workspaceRootPath;
        throw new SessionPersistenceRootIdentityError(`Session persistence root is unavailable: ${identity.workspaceRootPath}`);
    }
    if (canonicalRoot !== identity.workspaceRootPath) {
        throw new SessionPersistenceRootIdentityError(`Session persistence root target changed: ${identity.workspaceRootPath}`);
    }
    let root: BigIntStats;
    try {
        root = lstatSync(canonicalRoot, { bigint: true });
    }
    catch {
        throw new SessionPersistenceRootIdentityError(`Session persistence root is unavailable: ${identity.workspaceRootPath}`);
    }
    if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new SessionPersistenceRootIdentityError(`Session persistence root is no longer a physical directory: ${identity.workspaceRootPath}`);
    }
    if ((identity.device !== undefined && root.dev.toString() !== identity.device)
        || (identity.inode !== undefined && root.ino.toString() !== identity.inode)
        || (identity.birthtimeNs !== undefined && root.birthtimeNs.toString() !== identity.birthtimeNs)) {
        throw new SessionPersistenceRootIdentityError(`Session persistence root was replaced: ${identity.workspaceRootPath}`);
    }
    const sessionsPath = join(canonicalRoot, 'sessions');
    const sessions = optionalPhysicalDirectoryStats(sessionsPath, 'Session persistence directory');
    assertDirectoryIdentityPair(sessionsPath, 'Session persistence directory', sessions, identity.sessionsDevice, identity.sessionsInode, identity.sessionsBirthtimeNs);
    return canonicalRoot;
}

export function workspaceRootIsCaseInsensitive(workspaceRootPath: string): boolean {
    const canonical = canonicalWorkspaceRoot(workspaceRootPath);
    let sessionsDir: string;
    try {
        const candidate = join(canonical, 'sessions');
        if (!optionalPhysicalDirectoryStats(candidate, 'Session persistence directory'))
            return false;
        sessionsDir = realpathSync.native(candidate);
    }
    catch (error) {
        if (error instanceof SessionPersistenceRootIdentityError)
            throw error;
        // Identity registration prepares the sessions directory first. Read-only
        // lookups may reach this path after a workspace was removed; without an
        // existing directory there is no filesystem behavior to infer safely.
        return false;
    }
    const cached = caseInsensitiveSessionsDirectories.get(sessionsDir);
    if (cached !== undefined)
        return cached;
    // Probe the exact directory in which session IDs are resolved. Looking at a
    // parent path is insufficient on filesystems that support per-directory case
    // sensitivity, and can be spoofed by an alternate-case symlink. A random,
    // exclusive, owner-only file makes the probe collision-safe and is removed
    // synchronously before registration returns.
    const probeName = `.persistence-case-${randomUUID()}-a`;
    const probePath = join(sessionsDir, probeName);
    const alternatePath = join(sessionsDir, `${probeName.slice(0, -1)}A`);
    let descriptor: number | undefined;
    let caseInsensitive = false;
    let determined = false;
    try {
        descriptor = openSync(probePath, 'wx', 0o600);
        const probeStat = fstatSync(descriptor);
        try {
            const alternateStat = lstatSync(alternatePath);
            caseInsensitive = probeStat.dev === alternateStat.dev && probeStat.ino === alternateStat.ino;
            determined = true;
        }
        catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                // The alternate spelling not resolving proves this directory uses
                // case-sensitive lookup for session names.
                determined = true;
            }
        }
    }
    catch {
        // If the probe cannot be created, preserve distinct IDs instead of
        // collapsing them without evidence. A later registration can retry.
    }
    finally {
        if (descriptor !== undefined) {
            try {
                closeSync(descriptor);
            }
            catch { /* best-effort close */ }
            try {
                unlinkSync(probePath);
            }
            catch { /* best-effort probe cleanup */ }
        }
    }
    if (determined)
        caseInsensitiveSessionsDirectories.set(sessionsDir, caseInsensitive);
    return determined ? caseInsensitive : false;
}

export function rawIdentityAlias(workspaceRootPath: string, sessionId: string): string {
    return JSON.stringify([resolve(workspaceRootPath), sessionId]);
}

export function canonicalCaseFoldedIdentityAlias(canonicalRoot: string, sessionId: string): string {
    // The session directory may fold names, but the workspace's canonical path
    // remains part of the identity. Lower-casing it would merge distinct roots
    // such as /work/Foo and /work/foo on a case-sensitive parent filesystem.
    return JSON.stringify([canonicalRoot, sessionId.toLowerCase()]);
}

export function lexicalCaseFoldedIdentityAlias(workspaceRootPath: string, sessionId: string): string {
    // This is only a fallback for a root which no longer exists. Values are sets,
    // so two real roots whose spellings differ only by case can never overwrite
    // or silently alias one another.
    return JSON.stringify([resolve(workspaceRootPath).toLowerCase(), sessionId.toLowerCase()]);
}

export function existingCanonicalWorkspaceRoot(workspaceRootPath: string): string | undefined {
    try {
        return realpathSync.native(resolve(workspaceRootPath));
    }
    catch {
        return undefined;
    }
}

export interface SessionPersistenceQueueTestHooks {
    beforeWrite?: (sessionId: string) => Promise<void> | void;
    afterTempWrite?: (sessionId: string) => Promise<void> | void;
    beforeFileSync?: (sessionId: string) => Promise<void> | void;
    afterFileSync?: (sessionId: string) => Promise<void> | void;
    afterFinalFileSync?: (sessionId: string) => Promise<void> | void;
    afterDirectorySync?: (sessionId: string) => Promise<void> | void;
    /** Lets cross-platform tests model a case-folded sessions directory. */
    caseInsensitiveWorkspaceRoot?: (workspaceRootPath: string) => boolean;
}

export const activeSessionWritePaths = new Map<string, number>();

export function canonicalSessionPersistenceWritePath(filePath: string): string {
    const absolute = resolve(filePath);
    try {
        // The final JSONL file may not exist on its first write, but its session
        // directory does. Canonicalizing that parent collapses lexical and symlink
        // workspace aliases without depending on the destination file itself.
        return join(realpathSync.native(dirname(absolute)), basename(absolute));
    }
    catch {
        // Preserve the old lexical behavior when a caller probes a path whose
        // parent no longer exists. Active writers record the canonical key once
        // and pass that same key to endSessionPersistenceWrite().
        return absolute;
    }
}

export function beginSessionPersistenceWrite(filePath: string): string {
    const key = canonicalSessionPersistenceWritePath(filePath);
    activeSessionWritePaths.set(key, (activeSessionWritePaths.get(key) ?? 0) + 1);
    return key;
}

export function endSessionPersistenceWrite(key: string): void {
    const remaining = (activeSessionWritePaths.get(key) ?? 1) - 1;
    if (remaining > 0)
        activeSessionWritePaths.set(key, remaining);
    else
        activeSessionWritePaths.delete(key);
}

export function isSessionPersistenceWriteInProgress(filePath: string): boolean {
    return activeSessionWritePaths.has(canonicalSessionPersistenceWritePath(filePath));
}

export interface HeaderMetadataSignature {
    name?: string;
    labels?: string[];
    isFlagged?: boolean;
    sessionStatus?: string;
    permissionMode?: string;
    hasUnread?: boolean;
    lastReadMessageId?: string;
}

export function getHeaderMetadataSignature(header: SessionHeader): string {
    const signature: HeaderMetadataSignature = {
        ...(header.name !== undefined ? { name: header.name } : {}),
        ...(header.labels !== undefined ? { labels: header.labels } : {}),
        ...(header.isFlagged !== undefined ? { isFlagged: header.isFlagged } : {}),
        ...(header.sessionStatus !== undefined ? { sessionStatus: header.sessionStatus } : {}),
        ...(header.permissionMode !== undefined ? { permissionMode: header.permissionMode } : {}),
        ...(header.hasUnread !== undefined ? { hasUnread: header.hasUnread } : {}),
        ...(header.lastReadMessageId !== undefined ? { lastReadMessageId: header.lastReadMessageId } : {}),
    };
    return JSON.stringify(signature);
}

export function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
    const localHeaderWithoutOverrides = { ...localHeader };
    delete localHeaderWithoutOverrides.name;
    delete localHeaderWithoutOverrides.labels;
    delete localHeaderWithoutOverrides.isFlagged;
    delete localHeaderWithoutOverrides.sessionStatus;
    delete localHeaderWithoutOverrides.permissionMode;
    delete localHeaderWithoutOverrides.hasUnread;
    delete localHeaderWithoutOverrides.lastReadMessageId;
    return {
        ...localHeaderWithoutOverrides,
        ...(diskHeader.name !== undefined ? { name: diskHeader.name } : {}),
        ...(diskHeader.labels !== undefined ? { labels: diskHeader.labels } : {}),
        ...(diskHeader.isFlagged !== undefined ? { isFlagged: diskHeader.isFlagged } : {}),
        ...(diskHeader.sessionStatus !== undefined ? { sessionStatus: diskHeader.sessionStatus } : {}),
        ...(diskHeader.permissionMode !== undefined ? { permissionMode: diskHeader.permissionMode } : {}),
        ...(diskHeader.hasUnread !== undefined ? { hasUnread: diskHeader.hasUnread } : {}),
        ...(diskHeader.lastReadMessageId !== undefined ? { lastReadMessageId: diskHeader.lastReadMessageId } : {}),
    };
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

export async function replaceFileAtomically(tmpFile: string, finalFile: string): Promise<void> {
    try {
        await rename(tmpFile, finalFile);
        return;
    }
    catch (error) {
        // POSIX rename replaces the destination atomically. Some Windows handles can
        // reject replacement while the destination exists; keep a recoverable backup
        // instead of deleting the primary before the tmp has been promoted.
        if (!isErrnoException(error) || (error.code !== 'EEXIST' && error.code !== 'EPERM')) {
            throw error;
        }
    }
    const backupFile = `${finalFile}.bak`;
    try {
        await unlink(backupFile);
    }
    catch { /* ignore stale backup */ }
    let backupCreated = false;
    try {
        await rename(finalFile, backupFile);
        backupCreated = true;
    }
    catch {
        // Destination may not exist; continue with tmp promotion.
    }
    try {
        await rename(tmpFile, finalFile);
    }
    catch (error) {
        if (backupCreated) {
            try {
                await rename(backupFile, finalFile);
            }
            catch { /* leave backup for startup recovery */ }
        }
        throw error;
    }
    if (backupCreated) {
        try {
            await unlink(backupFile);
        }
        catch { /* ignore stale backup cleanup */ }
    }
}

export async function syncPath(path: string): Promise<void> {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}

/**
 * Commit one already-written temp snapshot to stable storage. This helper must
 * run inside the per-session persistence chain: syncing a pathname after that
 * chain is released can fsync an inode replaced by a concurrent enqueue.
 */
export async function commitDurableSessionFile(sessionId: string, tmpFile: string, finalFile: string, testHooks?: SessionPersistenceQueueTestHooks, assertDestination?: () => void): Promise<void> {
    await testHooks?.beforeFileSync?.(sessionId);
    assertDestination?.();
    await syncPath(tmpFile);
    await testHooks?.afterFileSync?.(sessionId);
    assertDestination?.();
    await replaceFileAtomically(tmpFile, finalFile);
    assertDestination?.();
    await syncPath(finalFile);
    await testHooks?.afterFinalFileSync?.(sessionId);
    assertDestination?.();
    // Windows does not expose a portable directory handle through Node. The
    // file FlushFileBuffers above remains mandatory there; POSIX additionally
    // persists the rename itself by syncing the parent directory.
    if (process.platform !== 'win32') {
        await syncPath(dirname(finalFile));
        await testHooks?.afterDirectorySync?.(sessionId);
        assertDestination?.();
    }
}
