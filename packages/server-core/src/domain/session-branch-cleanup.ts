export interface BranchRollbackManagedSession {
  agent?: { destroy?: () => void | Promise<void> } | null | undefined
  poolServer?: { stop?: () => void | Promise<void> } | undefined
}

interface RollbackParams {
  managed: BranchRollbackManagedSession
  workspaceRootPath: string
  sessionId: string
  deleteFromRuntimeSessions: (sessionId: string) => void
  deleteStoredSession: (workspaceRootPath: string, sessionId: string) => void | boolean | Promise<void | boolean>
}

/**
 * Best-effort rollback when branch creation fails during backend preflight.
 * Ensures no orphan child session remains in memory or persistent storage.
 */
export async function rollbackFailedBranchCreation(params: RollbackParams): Promise<void> {
  const { managed, workspaceRootPath, sessionId, deleteFromRuntimeSessions, deleteStoredSession } = params

  try {
    await managed.agent?.destroy?.()
  } catch {
    // Best-effort cleanup
  }
  managed.agent = null

  if (managed.poolServer) {
    try {
      await managed.poolServer.stop?.()
    } catch {
      // Best-effort cleanup
    }
    delete managed.poolServer;
  }

  deleteFromRuntimeSessions(sessionId)

  try {
    await deleteStoredSession(workspaceRootPath, sessionId)
  } catch {
    // Best-effort rollback: runtime cleanup is the critical path.
  }
}
