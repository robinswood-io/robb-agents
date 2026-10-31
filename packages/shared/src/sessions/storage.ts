/** Session persistence: paths, durable creation, deletion, metadata and plans. */
export type { SessionConfig } from './types.ts';
export {
  assertSessionPersistenceRootIdentity,
  captureSessionPersistenceRootIdentity,
  captureSessionPersistenceRootPath,
  SessionPersistenceRootIdentityError,
  sessionPersistenceQueue,
  getHeaderMetadataSignature,
} from './persistence-queue.js'
export type { SessionPersistenceRootIdentity } from './persistence-queue.js'
export { ensureSessionsDir, getSessionPath, getSessionFilePath, ensureSessionDir, getSessionAttachmentsPath, getSessionPlansPath, getSessionDataPath, getSessionDownloadsPath, generateSessionId } from './storage/session-paths.ts';
export { createSession, getOrCreateSessionById, saveSession } from './storage/creation.ts';
export { loadSession, listSessions, deleteSession } from './storage/session-index.ts';
export { purgeSessionDeletionQuarantine } from './storage/deletion-quarantine.ts';
export type { AtomicSessionDeletionResult, AtomicSessionDeletionTestHooks } from './storage/atomic-deletion.ts';
export { deleteSessionAtomically } from './storage/atomic-deletion.ts';
export { clearSessionMessages, getOrCreateLatestSession, updateSessionSdkId, canUpdateSdkCwd, updateSessionMetadata, flagSession, unflagSession, setSessionStatus, setSessionLabels, setSessionProjectId, unbindProjectFromSessions, archiveSession, unarchiveSession } from './storage/metadata.ts';
export { setPendingPlanExecution, markCompactionComplete, markPendingPlanExecutionDispatched, clearPendingPlanExecution, getPendingPlanExecution } from './storage/pending-plan.ts';
export { listFlaggedSessions, listCompletedSessions, listInboxSessions, listArchivedSessions, listActiveSessions, deleteOldArchivedSessions } from './storage/session-queries.ts';
export { formatPlanAsMarkdown, parsePlanFromMarkdown } from './storage/plan-format.ts';
export { savePlanToFile, loadPlanFromFile, loadPlanFromPath, listPlanFiles, deletePlanFile, getMostRecentPlanFile, ensureAttachmentsDir } from './storage/plan-files.ts';
