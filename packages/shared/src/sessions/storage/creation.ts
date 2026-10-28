import type { SessionConfig, StoredSession } from "../types.ts";
import { assertSessionPersistenceRootIdentity, sessionPersistenceQueue, type SessionPersistenceRootIdentity } from "../persistence-queue.ts";
import { loadSession } from './session-index.ts';
import { ensureSessionDir, ensureSessionsDir, generateSessionId, getSessionPath } from './session-paths.ts';

// ============================================================
// Session CRUD
// ============================================================

/**
 * Create a new session for a workspace
 */
export async function createSession(
  workspaceRootPath: string,
  options?: {
    name?: string;
    workingDirectory?: string;
    permissionMode?: SessionConfig['permissionMode'];
    enabledSourceSlugs?: string[];
    model?: string;
    modelRoutePinned?: boolean;
    llmConnection?: string;
    connectionRoutePinned?: boolean;
    thinkingLevel?: SessionConfig['thinkingLevel'];
    thinkingLevelPinned?: boolean;
    hidden?: boolean;
    sessionStatus?: SessionConfig['sessionStatus'];
    labels?: string[];
    isFlagged?: boolean;
    projectId?: string;
    parentSessionId?: string;
    delegation?: SessionConfig['delegation'];
    taskSlug?: string;
    taskRunId?: string;
    taskNodeId?: string;
    taskDraft?: boolean;
    executionIsolation?: SessionConfig['executionIsolation'];
    missionId?: string;
    missionWorkItemId?: string;
    missionDispatchId?: string;
    missionRole?: SessionConfig['missionRole'];
    missionRouteLockSha256?: string;
    missionOrdinaryRouteLock?: SessionConfig['missionOrdinaryRouteLock'];
    playbookSlug?: string;
    createdByApp?: SessionConfig['createdByApp'];
    lastUsedByApp?: SessionConfig['lastUsedByApp'];
  }
): Promise<SessionConfig> {
  ensureSessionsDir(workspaceRootPath);

  const now = Date.now();
  const sessionId = generateSessionId(workspaceRootPath);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceRootPath, sessionId);

  // Set sdkCwd to initial working directory or session path - this never changes
  // The SDK stores session transcripts at ~/.claude/projects/{cwd-slugified}/
  // If workingDirectory changes later, sdkCwd stays the same to preserve session resumption
  const sdkCwd = options?.workingDirectory ?? getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceRootPath,
    ...(options?.name !== undefined ? { name: options?.name } : {}),
    createdAt: now,
    lastUsedAt: now,
    ...(options?.createdByApp !== undefined ? { createdByApp: options?.createdByApp } : {}),
    ...(options?.lastUsedByApp !== undefined ? { lastUsedByApp: options?.lastUsedByApp } : {}),
    ...(options?.workingDirectory !== undefined ? { workingDirectory: options?.workingDirectory } : {}),
    sdkCwd,
    ...(options?.permissionMode !== undefined ? { permissionMode: options?.permissionMode } : {}),
    ...(options?.enabledSourceSlugs !== undefined ? { enabledSourceSlugs: options?.enabledSourceSlugs } : {}),
    ...(options?.model !== undefined ? { model: options?.model } : {}),
    ...(options?.modelRoutePinned !== undefined ? { modelRoutePinned: options?.modelRoutePinned } : {}),
    ...(options?.llmConnection !== undefined ? { llmConnection: options?.llmConnection } : {}),
    ...(options?.connectionRoutePinned !== undefined ? { connectionRoutePinned: options?.connectionRoutePinned } : {}),
    ...(options?.thinkingLevel !== undefined ? { thinkingLevel: options?.thinkingLevel } : {}),
    ...(options?.thinkingLevelPinned !== undefined ? { thinkingLevelPinned: options?.thinkingLevelPinned } : {}),
    ...(options?.hidden !== undefined ? { hidden: options?.hidden } : {}),
    ...(options?.sessionStatus !== undefined ? { sessionStatus: options?.sessionStatus } : {}),
    ...(options?.labels !== undefined ? { labels: options?.labels } : {}),
    ...(options?.isFlagged !== undefined ? { isFlagged: options?.isFlagged } : {}),
    ...(options?.projectId !== undefined ? { projectId: options?.projectId } : {}),
    ...(options?.parentSessionId !== undefined ? { parentSessionId: options?.parentSessionId } : {}),
    ...(options?.delegation !== undefined ? { delegation: options?.delegation } : {}),
    ...(options?.taskSlug !== undefined ? { taskSlug: options?.taskSlug } : {}),
    ...(options?.taskRunId !== undefined ? { taskRunId: options?.taskRunId } : {}),
    ...(options?.taskNodeId !== undefined ? { taskNodeId: options?.taskNodeId } : {}),
    ...(options?.taskDraft !== undefined ? { taskDraft: options?.taskDraft } : {}),
    ...(options?.executionIsolation !== undefined ? { executionIsolation: options?.executionIsolation } : {}),
    ...(options?.missionId !== undefined ? { missionId: options?.missionId } : {}),
    ...(options?.missionWorkItemId !== undefined ? { missionWorkItemId: options?.missionWorkItemId } : {}),
    ...(options?.missionDispatchId !== undefined ? { missionDispatchId: options?.missionDispatchId } : {}),
    ...(options?.missionRole !== undefined ? { missionRole: options?.missionRole } : {}),
    ...(options?.missionRouteLockSha256 !== undefined ? { missionRouteLockSha256: options?.missionRouteLockSha256 } : {}),
    ...(options?.missionOrdinaryRouteLock !== undefined ? { missionOrdinaryRouteLock: options?.missionOrdinaryRouteLock } : {}),
    ...(options?.playbookSlug !== undefined ? { playbookSlug: options?.playbookSlug } : {}),
  };

  // Save empty session
  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession, workspaceRootPath);

  return session;
}

/**
 * Get or create a session with a specific ID
 * Used for --session <id> flag to allow user-defined session IDs
 */
export async function getOrCreateSessionById(
  workspaceRootPath: string,
  sessionId: string
): Promise<SessionConfig> {
  const existing = loadSession(workspaceRootPath, sessionId);
  if (existing) {
    return {
      id: existing.id,
      ...(existing.sdkSessionId !== undefined ? { sdkSessionId: existing.sdkSessionId } : {}),
      workspaceRootPath: existing.workspaceRootPath,
      ...(existing.name !== undefined ? { name: existing.name } : {}),
      createdAt: existing.createdAt,
      lastUsedAt: existing.lastUsedAt,
      ...(existing.createdByApp !== undefined ? { createdByApp: existing.createdByApp } : {}),
      ...(existing.lastUsedByApp !== undefined ? { lastUsedByApp: existing.lastUsedByApp } : {}),
      ...(existing.sdkCwd !== undefined ? { sdkCwd: existing.sdkCwd } : {}),
      ...(existing.workingDirectory !== undefined ? { workingDirectory: existing.workingDirectory } : {}),
    };
  }

  if (sessionPersistenceQueue.isRetired(sessionId, workspaceRootPath)) {
    throw new Error(`Session ID was deleted during this app run and cannot be reused: ${sessionId}`);
  }

  // Create new session with the specified ID
  ensureSessionsDir(workspaceRootPath);

  // Create session directory with all subdirectories (plans, attachments)
  ensureSessionDir(workspaceRootPath, sessionId);

  const now = Date.now();
  // Set sdkCwd to session path - this never changes (ensures SDK can find session transcripts)
  const sdkCwd = getSessionPath(workspaceRootPath, sessionId);

  const session: SessionConfig = {
    id: sessionId,
    workspaceRootPath,
    sdkCwd,
    createdAt: now,
    lastUsedAt: now,
  };

  const storedSession: StoredSession = {
    ...session,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  };
  await saveSession(storedSession, workspaceRootPath);

  return session;
}

/**
 * Save session immediately using the persistence queue.
 * Enqueues the session and flushes to ensure immediate write.
 *
 * This unified approach ensures all session writes go through the same
 * async code path, which is more reliable on Windows.
 *
 * Writes in JSONL format: line 1 = header, lines 2+ = messages
 */
export async function saveSession(
  session: StoredSession,
  persistenceRootPath: string = session.workspaceRootPath,
  persistenceRootIdentity?: SessionPersistenceRootIdentity,
): Promise<void> {
  if (persistenceRootIdentity) {
    persistenceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
  }
  sessionPersistenceQueue.enqueue(session, persistenceRootPath, persistenceRootIdentity);
  await sessionPersistenceQueue.flush(session.id, persistenceRootPath);
}
