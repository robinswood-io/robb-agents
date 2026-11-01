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
import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "fs";
import { join } from "path";
import { getWorkspaceSessionsPath } from "../../workspaces/storage.ts";
import { generateUniqueSessionId } from "../slug-generator.ts";
import { sanitizeSessionId } from "../validation.ts";
import { isSessionPersistenceWriteInProgress, sessionPersistenceQueue } from "../persistence-queue.ts";

// ============================================================
// Directory Utilities
// ============================================================

function ensurePhysicalDirectory(path: string, label: string): string {
  let directory: ReturnType<typeof lstatSync>;
  try {
    directory = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(path, { recursive: true });
    directory = lstatSync(path);
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`Unsafe ${label}: expected a physical directory at ${path}`);
  }
  return path;
}

/**
 * Ensure sessions directory exists for a workspace
 */
export function ensureSessionsDir(workspaceRootPath: string): string {
  const dir = getWorkspaceSessionsPath(workspaceRootPath);
  return ensurePhysicalDirectory(dir, 'session persistence directory');
}

/**
 * Get path to a session's directory
 *
 * SECURITY: Uses sanitizeSessionId() as defense-in-depth to prevent path traversal.
 * Callers should still validate sessionId before calling this function.
 */
export function getSessionPath(workspaceRootPath: string, sessionId: string): string {
  // Defense-in-depth: strip any path components from sessionId
  const safeSessionId = sanitizeSessionId(sessionId);
  return join(getWorkspaceSessionsPath(workspaceRootPath), safeSessionId);
}

/**
 * Get path to a session's JSONL file (inside session folder)
 */
export function getSessionFilePath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'session.jsonl');
}

/**
 * Recover from an interrupted atomic session write.
 *
 * Older writes used `unlink(session.jsonl)` before renaming `session.jsonl.tmp`.
 * If Robb was quit in that small window, the UI could no longer list the chat
 * on restart even though the complete tmp file was still present. Prefer the
 * tmp file when the primary file is absent; otherwise remove stale sidecars.
 */
export function recoverInterruptedSessionWrite(sessionFile: string): void {
  // The async persistence queue has already created (or is about to promote)
  // its .tmp file. Treating that live sidecar as stale races the rename and
  // produces ENOENT under normal reads/list refreshes.
  if (isSessionPersistenceWriteInProgress(sessionFile)) return;

  const tmpFile = `${sessionFile}.tmp`;
  const backupFile = `${sessionFile}.bak`;

  if (!existsSync(sessionFile)) {
    if (existsSync(tmpFile)) {
      try {
        renameSync(tmpFile, sessionFile);
        return;
      } catch {
        // Fall through to backup recovery if tmp cannot be promoted.
      }
    }

    if (existsSync(backupFile)) {
      try {
        renameSync(backupFile, sessionFile);
      } catch {
        // Leave sidecars in place; the next startup can retry recovery.
      }
    }
    return;
  }

  if (existsSync(tmpFile)) {
    try { unlinkSync(tmpFile); } catch { /* ignore stale sidecar cleanup */ }
  }
  if (existsSync(backupFile)) {
    try { unlinkSync(backupFile); } catch { /* ignore stale sidecar cleanup */ }
  }
}

/**
 * Ensure session directory exists with all subdirectories
 */
export function ensureSessionDir(workspaceRootPath: string, sessionId: string): string {
  ensureSessionsDir(workspaceRootPath);
  const sessionDir = getSessionPath(workspaceRootPath, sessionId);
  ensurePhysicalDirectory(sessionDir, `session directory for ${sessionId}`);
  // Also create plans, attachments, long_responses, and downloads directories
  const plansDir = join(sessionDir, 'plans');
  if (!existsSync(plansDir)) {
    mkdirSync(plansDir, { recursive: true });
  }
  const attachmentsDir = join(sessionDir, 'attachments');
  if (!existsSync(attachmentsDir)) {
    mkdirSync(attachmentsDir, { recursive: true });
  }
  const longResponsesDir = join(sessionDir, 'long_responses');
  if (!existsSync(longResponsesDir)) {
    mkdirSync(longResponsesDir, { recursive: true });
  }
  // Data directory for transform_data tool output (JSON files for datatable/spreadsheet)
  const dataDir = join(sessionDir, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  // Downloads directory for binary files from API responses (PDFs, images, etc.)
  const downloadsDir = join(sessionDir, 'downloads');
  if (!existsSync(downloadsDir)) {
    mkdirSync(downloadsDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Get the attachments directory for a session
 */
export function getSessionAttachmentsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'attachments');
}

/**
 * Get the plans directory for a session
 */
export function getSessionPlansPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'plans');
}

/**
 * Get the data directory for a session (transform_data tool output)
 */
export function getSessionDataPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'data');
}

/**
 * Get the downloads directory for a session (binary files from API responses)
 */
export function getSessionDownloadsPath(workspaceRootPath: string, sessionId: string): string {
  return join(getSessionPath(workspaceRootPath, sessionId), 'downloads');
}

// ============================================================
// Session ID Generation
// ============================================================

/**
 * Get existing session IDs for collision detection
 */
function getExistingSessionIds(workspaceRootPath: string): Set<string> {
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) {
    return new Set();
  }
  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  return new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
}

/**
 * Generate a human-readable session ID
 * Format: YYMMDD-adjective-noun (e.g., 260111-swift-river)
 */
export function generateSessionId(workspaceRootPath: string): string {
  const existingIds = getExistingSessionIds(workspaceRootPath);
  while (true) {
    const candidate = generateUniqueSessionId(existingIds);
    if (!sessionPersistenceQueue.isRetired(candidate, workspaceRootPath)) return candidate;
    // A deleted ID remains reserved until process restart so stale callbacks
    // can never target a newly-created session with the same human slug.
    existingIds.add(candidate);
  }
}
