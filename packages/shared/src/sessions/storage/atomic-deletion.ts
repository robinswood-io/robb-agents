/**
 * Session Storage
 *
 * Workspace-scoped session CRUD operations.
 * Sessions are stored at {workspaceRootPath}/sessions/{id}/session.jsonl
 * Each session folder contains:
 * - session.jsonl (main data in JSONL format: line 1 = header, lines 2+ = messages)
 * - attachments/ (file attachments)
 * - plans/ (plan files for Safe Mode)
 * - data/ (transform_data tool output: JSON files for datatable/spreadsheet blocks)
 * - long_responses/ (full tool results that were summarized due to size limits)
 * - downloads/ (binary files downloaded from API sources: PDFs, images, archives, etc.)
 */
import { lstatSync, realpathSync, rmSync, renameSync, type BigIntStats } from "fs";
import { join } from "path";
import { createHash, randomUUID } from "crypto";
import { getWorkspaceSessionsPath } from "../../workspaces/storage.ts";
import { validateSessionId } from "../validation.ts";
import { debug } from "../../utils/debug.ts";
import { SESSION_DELETION_ENTRY_PREFIX, SESSION_DELETION_PENDING_PREFIX, recoveredDeletionQuarantines, syncDirectory, syncDirectoryForMaintenance } from './deletion-quarantine.ts';
import { getSessionPath } from './session-paths.ts';

export interface AtomicSessionDeletionResult {
  /** The live session path is proven absent because it never existed or was renamed. */
  committed: boolean;
  /** The directory rename was verified and fsynced in both parent directories. */
  durable: boolean;
  /** Why the commit could not be proven. Unsafe paths must never be traversed
   * by rollback persistence; a plain rename failure retains the verified source. */
  failureReason?: 'unsafe-path' | 'rename-failed';
}

/** @internal Deterministic race injection for filesystem contract tests. */
export interface AtomicSessionDeletionTestHooks {
  afterRename?: (paths: { sourcePath: string; pendingPath: string }) => void;
}

/**
 * Commit an explicit session deletion with an atomic rename before recursively
 * purging its contents. A purge failure can leave a hidden quarantine entry,
 * but it cannot expose a partially deleted session or let startup reload it.
 */
export function deleteSessionAtomically(
  workspaceRootPath: string,
  sessionId: string,
  testHooks?: AtomicSessionDeletionTestHooks,
): AtomicSessionDeletionResult {
  validateSessionId(sessionId);
  let canonicalWorkspaceRoot: string;
  let workspaceIdentity: BigIntStats;
  try {
    canonicalWorkspaceRoot = realpathSync(workspaceRootPath);
    workspaceIdentity = lstatSync(canonicalWorkspaceRoot, { bigint: true });
    if (!workspaceIdentity.isDirectory() || workspaceIdentity.isSymbolicLink()) {
      return { committed: false, durable: false, failureReason: 'unsafe-path' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { committed: true, durable: true };
    }
    return { committed: false, durable: false, failureReason: 'unsafe-path' };
  }

  const sessionDir = getSessionPath(canonicalWorkspaceRoot, sessionId);
  const sessionsDir = getWorkspaceSessionsPath(canonicalWorkspaceRoot);
  let sessionsIdentity: BigIntStats;
  let source: BigIntStats;
  try {
    sessionsIdentity = lstatSync(sessionsDir, { bigint: true });
    if (!sessionsIdentity.isDirectory() || sessionsIdentity.isSymbolicLink()) {
      return { committed: false, durable: false, failureReason: 'unsafe-path' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { committed: true, durable: true };
    }
    return { committed: false, durable: false, failureReason: 'unsafe-path' };
  }
  try {
    source = lstatSync(sessionDir, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { committed: true, durable: true };
    }
    return { committed: false, durable: false, failureReason: 'unsafe-path' };
  }
  if (!source.isDirectory() || source.isSymbolicLink()) {
    return { committed: false, durable: false, failureReason: 'unsafe-path' };
  }

  // Revalidate every source object immediately before rename. Node does not
  // expose renameat(), so the post-rename proof below remains mandatory too.
  try {
    const currentWorkspace = lstatSync(canonicalWorkspaceRoot, { bigint: true });
    const currentSessions = lstatSync(sessionsDir, { bigint: true });
    const currentSource = lstatSync(sessionDir, { bigint: true });
    if (!currentWorkspace.isDirectory() || currentWorkspace.isSymbolicLink()
      || currentWorkspace.dev !== workspaceIdentity.dev || currentWorkspace.ino !== workspaceIdentity.ino
      || !currentSessions.isDirectory() || currentSessions.isSymbolicLink()
      || currentSessions.dev !== sessionsIdentity.dev || currentSessions.ino !== sessionsIdentity.ino
      || !currentSource.isDirectory() || currentSource.isSymbolicLink()
      || currentSource.dev !== source.dev || currentSource.ino !== source.ino) {
      return { committed: false, durable: false, failureReason: 'unsafe-path' };
    }
  } catch {
    return { committed: false, durable: false, failureReason: 'unsafe-path' };
  }

  // Keep the destination as an immediate child of the canonical workspace.
  // A pending namespace is deliberately not startup-purgeable: until the move
  // is verified, preserving an ambiguous object is safer than deleting it.
  const deletionSuffix = `${createHash('sha256').update(sessionId).digest('hex')}-${randomUUID()}`;
  const pendingPath = join(
    canonicalWorkspaceRoot,
    `${SESSION_DELETION_PENDING_PREFIX}${deletionSuffix}`,
  );
  const quarantinePath = join(canonicalWorkspaceRoot, `${SESSION_DELETION_ENTRY_PREFIX}${deletionSuffix}`);
  try {
    renameSync(sessionDir, pendingPath);
  } catch {
    return { committed: false, durable: false, failureReason: 'rename-failed' };
  }
  testHooks?.afterRename?.({ sourcePath: sessionDir, pendingPath });
  // A previous successful startup purge may already be cached. This newly
  // created entry must remain eligible for a later retry if immediate removal
  // fails (notably on Windows, where directory fsync is unavailable).
  recoveredDeletionQuarantines.delete(workspaceRootPath);
  recoveredDeletionQuarantines.delete(canonicalWorkspaceRoot);

  // The rename is not a proven commit until the exact moved inode, source
  // absence, and both physical parents still match. A concurrent recreation or
  // path swap must be reported as unsafe and its pending data left untouched.
  let verified = false;
  try {
    const quarantined = lstatSync(pendingPath, { bigint: true });
    const currentWorkspace = lstatSync(canonicalWorkspaceRoot, { bigint: true });
    const currentSessions = lstatSync(sessionsDir, { bigint: true });
    let sourceAbsent = false;
    try {
      lstatSync(sessionDir, { bigint: true });
    } catch (error) {
      sourceAbsent = (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    verified = quarantined.isDirectory() && !quarantined.isSymbolicLink()
      && quarantined.dev === source.dev && quarantined.ino === source.ino
      && sourceAbsent
      && currentWorkspace.isDirectory() && !currentWorkspace.isSymbolicLink()
      && currentWorkspace.dev === workspaceIdentity.dev && currentWorkspace.ino === workspaceIdentity.ino
      && currentSessions.isDirectory() && !currentSessions.isSymbolicLink()
      && currentSessions.dev === sessionsIdentity.dev && currentSessions.ino === sessionsIdentity.ino;
    if (!verified) {
      debug(`[sessions] Session ${sessionId} deletion move could not be fully verified`);
    }
  } catch (error) {
    debug(`[sessions] Session ${sessionId} deletion move could not be verified:`, error);
  }
  if (!verified) {
    return { committed: false, durable: false, failureReason: 'unsafe-path' };
  }

  let sourceParentSynced = false;
  let workspaceParentSynced = false;
  try {
    sourceParentSynced = syncDirectory(sessionsDir);
  } catch (error) {
    debug(`[sessions] Session ${sessionId} source directory rename could not be synced:`, error);
  }
  try {
    // The quarantine entry is created by rename in the workspace itself. Sync
    // that parent before reporting durable=true, as well as the source parent.
    workspaceParentSynced = syncDirectory(canonicalWorkspaceRoot);
  } catch (error) {
    debug(`[sessions] Session ${sessionId} quarantine rename could not be synced:`, error);
  }

  const durable = sourceParentSynced && workspaceParentSynced;
  try {
    rmSync(pendingPath, { recursive: true, force: true });
    syncDirectoryForMaintenance(canonicalWorkspaceRoot);
  } catch (error) {
    // Only a fully verified move may enter the purgeable namespace. If the
    // immediate recursive removal fails, retain it for conservative recovery.
    try {
      renameSync(pendingPath, quarantinePath);
      syncDirectoryForMaintenance(canonicalWorkspaceRoot);
    } catch {
      // The pending namespace remains non-purgeable if promotion cannot finish.
    }
    debug(`[sessions] Session ${sessionId} was detached but its quarantine purge failed:`, error);
  }
  return { committed: true, durable };
}
