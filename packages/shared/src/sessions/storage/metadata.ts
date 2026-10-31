import { setOptional } from '../../utils/json.ts';
import type { SessionConfig, StoredSession, SessionStatus } from "../types.ts";
import { assertSessionPersistenceRootIdentity, type SessionPersistenceRootIdentity } from "../persistence-queue.ts";
import { createSession, saveSession } from './creation.ts';
import { listSessions, loadSession } from './session-index.ts';
import { listActiveSessions } from './session-queries.ts';

/**
 * Clear messages from a session while preserving metadata.
 * Used for /clear command to reset conversation without creating a new session.
 * Also clears the SDK session ID to start a fresh Claude conversation.
 */
export async function clearSessionMessages(workspaceRootPath: string, sessionId: string): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (session) {
    // Clear messages and SDK session ID but preserve metadata
    session.messages = [];
    delete session.sdkSessionId
    delete session.pendingTurnRecovery
    delete session.activeObjective
    delete session.userInputRequests
    // Reset token usage to zero
    session.tokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    };
    await saveSession(session, workspaceRootPath);
  }
}

/**
 * Get or create the latest session for a workspace
 * Uses listActiveSessions to exclude archived sessions
 */
export async function getOrCreateLatestSession(workspaceRootPath: string): Promise<SessionConfig> {
  const sessions = listActiveSessions(workspaceRootPath);
  if (sessions.length > 0 && sessions[0]) {
    const latest = sessions[0];
    return {
      id: latest.id,
      ...(latest.sdkSessionId !== undefined ? { sdkSessionId: latest.sdkSessionId } : {}),
      workspaceRootPath: latest.workspaceRootPath,
      ...(latest.name !== undefined ? { name: latest.name } : {}),
      createdAt: latest.createdAt,
      lastUsedAt: latest.lastUsedAt,
      ...(latest.createdByApp !== undefined ? { createdByApp: latest.createdByApp } : {}),
      ...(latest.lastUsedByApp !== undefined ? { lastUsedByApp: latest.lastUsedByApp } : {}),
    };
  }
  return createSession(workspaceRootPath);
}

// ============================================================
// Session Metadata Updates
// ============================================================

/**
 * Update SDK session ID for a session
 */
export async function updateSessionSdkId(
  workspaceRootPath: string,
  sessionId: string,
  sdkSessionId: string
): Promise<void> {
  const session = loadSession(workspaceRootPath, sessionId);
  if (session) {
    session.sdkSessionId = sdkSessionId;
    await saveSession(session, workspaceRootPath);
  }
}

/**
 * Check if sdkCwd can be safely updated for a session.
 *
 * sdkCwd is normally immutable because the SDK stores session transcripts at
 * ~/.claude/projects/{cwd-slugified}/. However, it's safe to update sdkCwd if
 * no SDK interaction has occurred yet (no transcripts to preserve).
 *
 * @returns true if sdkCwd can be updated (no messages and no SDK session ID)
 */
export function canUpdateSdkCwd(session: StoredSession): boolean {
  // Safe to update if:
  // 1. No messages have been sent yet (no conversation to preserve)
  // 2. No SDK session ID (no transcript exists at the sdkCwd path)
  return session.messages.length === 0 && !session.sdkSessionId;
}

/**
 * Update session metadata
 */
export async function updateSessionMetadata(
  workspaceRootPath: string,
  sessionId: string,
  updates: { [K in keyof Pick<SessionConfig,
    | 'isFlagged'
    | 'name'
    | 'sessionStatus'
    | 'labels'
    | 'lastReadMessageId'
    | 'hasUnread'
    | 'enabledSourceSlugs'
    | 'workingDirectory'
    | 'sdkCwd'
    | 'permissionMode'
    | 'sharedUrl'
    | 'sharedId'
    | 'model'
    | 'modelRoutePinned'
    | 'llmConnection'
    | 'connectionRoutePinned'
    | 'thinkingLevelPinned'
    | 'isArchived'
    | 'archivedAt'
    | 'projectId'
  >]?: SessionConfig[K] | undefined },
  persistenceRootIdentity?: SessionPersistenceRootIdentity,
): Promise<void> {
  if (persistenceRootIdentity) {
    workspaceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
  }
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  if (updates.isFlagged !== undefined) session.isFlagged = updates.isFlagged;
  if (updates.name !== undefined) session.name = updates.name;
  if (updates.sessionStatus !== undefined) session.sessionStatus = updates.sessionStatus;
  if (updates.labels !== undefined) session.labels = updates.labels;
  if (updates.enabledSourceSlugs !== undefined) session.enabledSourceSlugs = updates.enabledSourceSlugs;
  if (updates.workingDirectory !== undefined) session.workingDirectory = updates.workingDirectory;
  if (updates.sdkCwd !== undefined) session.sdkCwd = updates.sdkCwd;
  if (updates.permissionMode !== undefined) session.permissionMode = updates.permissionMode;
  if ('lastReadMessageId' in updates) setOptional(session, 'lastReadMessageId', updates.lastReadMessageId);
  if ('hasUnread' in updates) setOptional(session, 'hasUnread', updates.hasUnread);
  if ('sharedUrl' in updates) setOptional(session, 'sharedUrl', updates.sharedUrl);
  if ('sharedId' in updates) setOptional(session, 'sharedId', updates.sharedId);
  if ('model' in updates) setOptional(session, 'model', updates.model);
  if (updates.modelRoutePinned !== undefined) session.modelRoutePinned = updates.modelRoutePinned;
  if (updates.llmConnection !== undefined) session.llmConnection = updates.llmConnection;
  if (updates.connectionRoutePinned !== undefined) session.connectionRoutePinned = updates.connectionRoutePinned;
  if (updates.thinkingLevelPinned !== undefined) session.thinkingLevelPinned = updates.thinkingLevelPinned;
  if (updates.isArchived !== undefined) session.isArchived = updates.isArchived;
  if ('archivedAt' in updates) setOptional(session, 'archivedAt', updates.archivedAt);
  if ('projectId' in updates) setOptional(session, 'projectId', updates.projectId);

  await saveSession(session, workspaceRootPath, persistenceRootIdentity);
}

/**
 * Flag a session
 */
export async function flagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: true });
}

/**
 * Unflag a session
 */
export async function unflagSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { isFlagged: false });
}

/**
 * Set session status
 */
export async function setSessionStatus(
  workspaceRootPath: string,
  sessionId: string,
  sessionStatus: SessionStatus
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { sessionStatus });
}

/**
 * Set labels for a session
 */
export async function setSessionLabels(
  workspaceRootPath: string,
  sessionId: string,
  labels: string[]
): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, { labels });
}

/**
 * Set or clear the project binding for a session.
 * Pass `null` to unbind.
 */
export async function setSessionProjectId(
  workspaceRootPath: string,
  sessionId: string,
  projectId: string | null
): Promise<void> {
  const optionalProjectId = projectId === null ? undefined : projectId;
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    ...(optionalProjectId !== undefined ? { projectId: optionalProjectId } : {}),
  });
}

/**
 * Unbind every session that referenced a given projectId.
 * Called when a project is deleted — sessions are preserved, just unlinked.
 * Returns the number of sessions touched.
 */
export async function unbindProjectFromSessions(
  workspaceRootPath: string,
  projectId: string
): Promise<number> {
  const sessions = listSessions(workspaceRootPath);
  let touched = 0;
  for (const meta of sessions) {
    const full = loadSession(workspaceRootPath, meta.id);
    if (full?.projectId === projectId) {
      delete full.projectId
      await saveSession(full, workspaceRootPath);
      touched++;
    }
  }
  return touched;
}

/**
 * Archive a session
 */
export async function archiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: true,
    archivedAt: Date.now(),
  });
}

/**
 * Unarchive a session
 */
export async function unarchiveSession(workspaceRootPath: string, sessionId: string): Promise<void> {
  await updateSessionMetadata(workspaceRootPath, sessionId, {
    isArchived: false,
    archivedAt: undefined,
  });
}
