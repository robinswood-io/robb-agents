import { assertSessionPersistenceRootIdentity, type SessionPersistenceRootIdentity } from "../persistence-queue.ts";
import { saveSession } from './creation.ts';
import { loadSession } from './session-index.ts';

// ============================================================
// Pending Plan Execution (Accept & Compact flow)
// ============================================================

/**
 * Set pending plan execution state.
 * Called when user clicks "Accept & Compact" - stores the plan path
 * so it can be executed after compaction, even if the page reloads.
 */
export async function setPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string,
  planPath: string,
  draftInputSnapshot?: string,
  persistenceRootIdentity?: SessionPersistenceRootIdentity,
): Promise<void> {
  if (persistenceRootIdentity) {
    workspaceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
  }
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  session.pendingPlanExecution = {
    planPath,
    ...(draftInputSnapshot !== undefined ? { draftInputSnapshot } : {}),
    awaitingCompaction: true,
    executionDispatched: false,
  };
  await saveSession(session, workspaceRootPath, persistenceRootIdentity);
}

/**
 * Mark compaction as complete for pending plan execution.
 * Called when compaction_complete event fires - sets awaitingCompaction to false
 * so reload recovery knows compaction finished and can trigger execution.
 */
export async function markCompactionComplete(
  workspaceRootPath: string,
  sessionId: string,
  persistenceRootIdentity?: SessionPersistenceRootIdentity,
): Promise<void> {
  if (persistenceRootIdentity) {
    workspaceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
  }
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.awaitingCompaction = false;
  await saveSession(session, workspaceRootPath, persistenceRootIdentity);
}

/**
 * Mark pending plan execution as already dispatched from the UI.
 * This prevents reload recovery from sending the same approval message twice
 * if cleanup fails after the send has already been kicked off.
 */
export async function markPendingPlanExecutionDispatched(
  workspaceRootPath: string,
  sessionId: string,
  persistenceRootIdentity?: SessionPersistenceRootIdentity,
): Promise<void> {
  if (persistenceRootIdentity) {
    workspaceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
  }
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return;

  session.pendingPlanExecution.executionDispatched = true;
  await saveSession(session, workspaceRootPath, persistenceRootIdentity);
}

/**
 * Clear pending plan execution state.
 * Called after plan execution is sent, on new user message, or when
 * the pending execution is no longer relevant.
 */
export async function clearPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string,
  persistenceRootIdentity?: SessionPersistenceRootIdentity,
): Promise<void> {
  if (persistenceRootIdentity) {
    workspaceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
  }
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return;

  delete session.pendingPlanExecution;
  await saveSession(session, workspaceRootPath, persistenceRootIdentity);
}

/**
 * Get pending plan execution state for a session.
 * Used on reload to check if we need to resume plan execution.
 */
export function getPendingPlanExecution(
  workspaceRootPath: string,
  sessionId: string,
  persistenceRootIdentity?: SessionPersistenceRootIdentity,
): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
  if (persistenceRootIdentity) {
    workspaceRootPath = assertSessionPersistenceRootIdentity(persistenceRootIdentity);
  }
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session?.pendingPlanExecution) return null;
  return {
    ...session.pendingPlanExecution,
    executionDispatched: session.pendingPlanExecution.executionDispatched === true,
  };
}
