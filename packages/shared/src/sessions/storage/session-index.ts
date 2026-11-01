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
import { existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { getWorkspaceSessionsPath } from "../../workspaces/storage.ts";
import { expandPath } from "../../utils/paths.ts";
import { perf } from "../../utils/perf.ts";
import type { StoredSession, SessionMetadata, SessionHeader } from "../types.ts";
import { validateSessionStatus } from "../../statuses/validation.ts";
import { debug } from "../../utils/debug.ts";
import { readSessionHeader, readSessionJsonl } from "../jsonl.ts";
import { purgeSessionDeletionQuarantine, recoveredDeletionQuarantines } from './deletion-quarantine.ts';
import { listPlanFiles } from './plan-files.ts';
import { getSessionFilePath, getSessionPath, recoverInterruptedSessionWrite } from './session-paths.ts';

/**
 * Load session by ID
 * Loads session from folder structure in JSONL format.
 */
export function loadSession(workspaceRootPath: string, sessionId: string): StoredSession | null {
  const end = perf.start('session.loadSession', { sessionId });

  const jsonlPath = getSessionFilePath(workspaceRootPath, sessionId);
  recoverInterruptedSessionWrite(jsonlPath);
  if (existsSync(jsonlPath)) {
    const session = readSessionJsonl(jsonlPath);
    if (session) {
      end();
      return session;
    }
  }

  end();
  return null;
}

/**
 * List sessions for a workspace
 * Lists sessions from folder structure.
 *
 * Uses JSONL header for fast loading (only reads first line of each file).
 */
export function listSessions(workspaceRootPath: string): SessionMetadata[] {
  const span = perf.span('session.listSessions');
  if (!recoveredDeletionQuarantines.has(workspaceRootPath)) {
    if (purgeSessionDeletionQuarantine(workspaceRootPath)) {
      recoveredDeletionQuarantines.add(workspaceRootPath);
    }
  }
  const sessionsDir = getWorkspaceSessionsPath(workspaceRootPath);
  if (!existsSync(sessionsDir)) {
    span.end();
    return [];
  }

  const entries = readdirSync(sessionsDir, { withFileTypes: true });
  span.mark('readdir');
  const sessions: SessionMetadata[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const sessionId = entry.name;
      const sessionDir = join(sessionsDir, sessionId);
      const jsonlFile = join(sessionDir, 'session.jsonl');
      recoverInterruptedSessionWrite(jsonlFile);

      if (existsSync(jsonlFile)) {
        const header = readSessionHeader(jsonlFile);
        if (header) {
          const metadata = headerToMetadata(header, workspaceRootPath);
          if (metadata) sessions.push(metadata);
        }
      }
    }
  }
  span.mark('parsed');
  span.setMetadata('count', sessions.length);

  // Sort by lastUsedAt descending (most recent first)
  const sorted = sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  span.end();
  return sorted;
}

/**
 * Convert SessionHeader to SessionMetadata
 * Used for fast session list loading from JSONL format.
 */
function headerToMetadata(header: SessionHeader, workspaceRootPath: string): SessionMetadata | null {
  try {
    // Migration: accept old 'todoState' field from pre-rename session files
    const rawStatus = header.sessionStatus ?? (header as { todoState?: string }).todoState;
    // Validate sessionStatus against workspace status config
    const validatedStatus = validateSessionStatus(workspaceRootPath, rawStatus);

    // Count plan files for this session
    const planCount = listPlanFiles(workspaceRootPath, header.id).length;

    // Migration: For sessions created before sdkCwd was added, use workingDirectory as fallback.
    const workingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workingDir;

    // Destructure fields that don't exist on SessionMetadata or need overrides
    const {
      pendingPlanExecution: _pp,
      sessionStatus: _ss, workingDirectory: _wd, sdkCwd: _sc,
      workspaceRootPath: _wrp, ...headerFields
    } = header;

    return {
      ...headerFields,
      workspaceRootPath,
      sessionStatus: validatedStatus,
      planCount: planCount > 0 ? planCount : undefined,
      workingDirectory: workingDir,
      sdkCwd,
    } as SessionMetadata;
  } catch (error) {
    debug(`[sessions] Failed to convert header to metadata for session "${header?.id}" in ${workspaceRootPath}:`, error);
    return null;
  }
}

/**
 * Delete a session and its associated files
 * Deletes session folder and all associated files
 */
export function deleteSession(workspaceRootPath: string, sessionId: string): boolean {
  try {
    // Delete session directory (includes session.json, attachments, plans)
    const sessionDir = getSessionPath(workspaceRootPath, sessionId);
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true });
    }

    return true;
  } catch {
    return false;
  }
}
