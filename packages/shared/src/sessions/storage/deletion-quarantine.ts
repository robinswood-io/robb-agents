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
import { closeSync, constants, fsyncSync, lstatSync, openSync, readdirSync, realpathSync, rmdirSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { debug } from "../../utils/debug.ts";

const LEGACY_SESSION_DELETION_QUARANTINE = '.session-deletions';

const LEGACY_SESSION_DELETION_STAGING_PREFIX = '.robb-agents-session-deletion-legacy-v1-';

export const SESSION_DELETION_ENTRY_PREFIX = '.robb-agents-session-deletion-v1-';

// A move is not eligible for automatic purge until its source, destination,
// and both physical parents have been verified. Pending entries intentionally
// use a different namespace so a failed/raced verification preserves data.
export const SESSION_DELETION_PENDING_PREFIX = '.robb-agents-session-deletion-pending-v1-';

const UUID_V4_PATTERN_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

const LEGACY_SESSION_DELETION_ENTRY_PATTERN = new RegExp(
  `^[a-f0-9]{64}-${UUID_V4_PATTERN_SOURCE}$`,
);

const SESSION_DELETION_ENTRY_PATTERN = new RegExp(
  `^\\.robb-agents-session-deletion-v1-[a-f0-9]{64}-${UUID_V4_PATTERN_SOURCE}$`,
);

const LEGACY_SESSION_DELETION_STAGING_PATTERN = new RegExp(
  `^\\.robb-agents-session-deletion-legacy-v1-${UUID_V4_PATTERN_SOURCE}$`,
);

export const recoveredDeletionQuarantines = new Set<string>();

export function syncDirectory(path: string): boolean {
  if (process.platform === 'win32') return false;
  const directoryFlag = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag | noFollowFlag);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return true;
}

export function syncDirectoryForMaintenance(path: string): boolean {
  // Windows does not provide the same directory-fsync contract through Node.
  // A completed logical purge is still complete and must be cached; durability
  // remains explicitly false for atomic deletion results on that platform.
  return process.platform === 'win32' || syncDirectory(path);
}

function purgeLegacySessionDeletionQuarantine(canonicalWorkspaceRoot: string): boolean {
  const legacyRoot = join(canonicalWorkspaceRoot, LEGACY_SESSION_DELETION_QUARANTINE);
  const stagedNames = readdirSync(canonicalWorkspaceRoot, { withFileTypes: true })
    .map((entry) => entry.name)
    .filter((name) => LEGACY_SESSION_DELETION_STAGING_PATTERN.test(name));

  // Atomically detach the well-known legacy path before inspecting contents.
  // This prevents a check/use race where it is replaced with a symlink between
  // lstat/readdir/rm. The random sibling name is never traversed before rename.
  const stagedName = `${LEGACY_SESSION_DELETION_STAGING_PREFIX}${randomUUID()}`;
  const stagedPath = join(canonicalWorkspaceRoot, stagedName);
  try {
    renameSync(legacyRoot, stagedPath);
    stagedNames.push(stagedName);
    if (!syncDirectoryForMaintenance(canonicalWorkspaceRoot)) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      debug('[sessions] Failed to isolate the legacy session deletion quarantine:', error);
      return false;
    }
  }

  let completelyPurged = true;
  for (const name of stagedNames) {
    const candidatePath = join(canonicalWorkspaceRoot, name);
    let candidate: ReturnType<typeof lstatSync>;
    try {
      candidate = lstatSync(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      completelyPurged = false;
      continue;
    }

    if (!candidate.isDirectory() || candidate.isSymbolicLink()) {
      // Preserve unexpected legacy data without ever following it. Restore the
      // familiar path when possible; otherwise leave the isolated sibling for
      // a later, equally conservative retry.
      try {
        renameSync(candidatePath, legacyRoot);
        syncDirectoryForMaintenance(canonicalWorkspaceRoot);
      } catch {
        // A concurrent creator may now own the legacy path.
      }
      completelyPurged = false;
      continue;
    }

    let removedEntry = false;
    try {
      for (const entry of readdirSync(candidatePath, { withFileTypes: true })) {
        if (!LEGACY_SESSION_DELETION_ENTRY_PATTERN.test(entry.name)) continue;
        try {
          rmSync(join(candidatePath, entry.name), { recursive: true, force: true });
          removedEntry = true;
        } catch (error) {
          completelyPurged = false;
          debug(`[sessions] Failed to purge legacy quarantined session entry ${entry.name}:`, error);
        }
      }
      if (removedEntry && !syncDirectoryForMaintenance(candidatePath)) {
        completelyPurged = false;
      }

      if (readdirSync(candidatePath).length === 0) {
        rmdirSync(candidatePath);
        if (!syncDirectoryForMaintenance(canonicalWorkspaceRoot)) completelyPurged = false;
      } else {
        // Preserve files outside our strict namespace at the original path.
        renameSync(candidatePath, legacyRoot);
        if (!syncDirectoryForMaintenance(canonicalWorkspaceRoot)) completelyPurged = false;
      }
    } catch (error) {
      completelyPurged = false;
      debug('[sessions] Failed to purge an isolated legacy session deletion quarantine:', error);
    }
  }
  return completelyPurged;
}

/**
 * Remove entries left after a deletion committed but its best-effort purge was
 * interrupted. New entries live directly below the canonical workspace so the
 * atomic rename never traverses a replaceable quarantine symlink. The legacy
 * quarantine directory is also purged conservatively for upgrades.
 */
export function purgeSessionDeletionQuarantine(workspaceRootPath: string): boolean {
  let completelyPurged = true;
  try {
    let canonicalWorkspaceRoot: string;
    try {
      canonicalWorkspaceRoot = realpathSync(workspaceRootPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
    const workspace = lstatSync(canonicalWorkspaceRoot);
    if (!workspace.isDirectory() || workspace.isSymbolicLink()) return false;

    let removedWorkspaceEntry = false;
    for (const entry of readdirSync(canonicalWorkspaceRoot, { withFileTypes: true })) {
      if (!SESSION_DELETION_ENTRY_PATTERN.test(entry.name)) continue;
      try {
        rmSync(join(canonicalWorkspaceRoot, entry.name), { recursive: true, force: true });
        removedWorkspaceEntry = true;
      } catch (error) {
        completelyPurged = false;
        debug(`[sessions] Failed to purge quarantined session entry ${entry.name}:`, error);
      }
    }
    if (removedWorkspaceEntry && !syncDirectoryForMaintenance(canonicalWorkspaceRoot)) {
      completelyPurged = false;
    }

    if (!purgeLegacySessionDeletionQuarantine(canonicalWorkspaceRoot)) completelyPurged = false;
  } catch (error) {
    debug('[sessions] Failed to inspect the session deletion quarantine:', error);
    return false;
  }
  return completelyPurged;
}
