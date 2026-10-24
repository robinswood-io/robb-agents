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
    name: options?.name,
    createdAt: now,
    lastUsedAt: now,
    createdByApp: options?.createdByApp,
    lastUsedByApp: options?.lastUsedByApp,
    workingDirectory: options?.workingDirectory,
    sdkCwd,
    permissionMode: options?.permissionMode,
    enabledSourceSlugs: options?.enabledSourceSlugs,
    model: options?.model,
    modelRoutePinned: options?.modelRoutePinned,
    llmConnection: options?.llmConnection,
    connectionRoutePinned: options?.connectionRoutePinned,
    thinkingLevel: options?.thinkingLevel,
    thinkingLevelPinned: options?.thinkingLevelPinned,
    hidden: options?.hidden,
    sessionStatus: options?.sessionStatus,
    labels: options?.labels,
    isFlagged: options?.isFlagged,
    projectId: options?.projectId,
    parentSessionId: options?.parentSessionId,
    delegation: options?.delegation,
    taskSlug: options?.taskSlug,
    taskRunId: options?.taskRunId,
    taskNodeId: options?.taskNodeId,
    taskDraft: options?.taskDraft,
    executionIsolation: options?.executionIsolation,
    missionId: options?.missionId,
    missionWorkItemId: options?.missionWorkItemId,
    missionDispatchId: options?.missionDispatchId,
    missionRole: options?.missionRole,
    missionRouteLockSha256: options?.missionRouteLockSha256,
    missionOrdinaryRouteLock: options?.missionOrdinaryRouteLock,
    playbookSlug: options?.playbookSlug,
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
      sdkSessionId: existing.sdkSessionId,
      workspaceRootPath: existing.workspaceRootPath,
      name: existing.name,
      createdAt: existing.createdAt,
      lastUsedAt: existing.lastUsedAt,
      createdByApp: existing.createdByApp,
      lastUsedByApp: existing.lastUsedByApp,
      sdkCwd: existing.sdkCwd,
      workingDirectory: existing.workingDirectory,
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
