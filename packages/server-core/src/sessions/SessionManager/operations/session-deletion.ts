import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor } from '../policy.ts';
import { CompletedChatArchiveError } from '../../completed-chat-retention';
import { unregisterSessionScopedToolCallbacks, clearObjectiveEvidenceGate, destroyContextualGmailSessionState } from '@craft-agent/shared/agent';
import { deleteSessionAtomically as deleteStoredSessionAtomically, SessionPersistenceRootIdentityError, sessionPersistenceQueue } from '@craft-agent/shared/sessions';
import { sessionLog } from '../runtime-platform.ts';
import { quiesceSessionForDeletion as sessionOpQuiesceSessionForDeletion } from './quiesce-session-for-deletion.ts';
import { clearAdminRememberApprovalsForSession as sessionOpClearAdminRememberApprovalsForSession, clearPendingPermissionRequestsForSession as sessionOpClearPendingPermissionRequestsForSession } from './expire-pending-permission-request.ts';

async function sessionOpDeleteSession(sessionOperationContext: SessionOperationContext, sessionId: string, retentionArchive?: () => boolean): Promise<void> {
    const existing = sessionOperationContext.state.sessionDeletionsInFlight.get(sessionId);
    if (existing) {
        await existing;
        // An explicit human deletion must not be weakened by joining a
        // conditional retention attempt that ultimately restored the session.
        if (!retentionArchive && sessionOperationContext.state.sessions.has(sessionId)) {
            await sessionOperationContext.owner.deleteSession(sessionId);
        }
        return;
    }
    if (sessionOperationContext.state.shuttingDown)
        throw new Error('Cannot delete a session while the session manager is shutting down');
    // Register ownership before the implementation can synchronously detach
    // the session or trigger a re-entrant shutdown/delete callback. The
    // deferred promise keeps that registration ordered first without delaying
    // performSessionDeletion itself to another microtask.
    let resolveDeletion!: () => void;
    let rejectDeletion!: (error: unknown) => void;
    const deletion = new Promise<void>((resolve, reject) => {
        resolveDeletion = resolve;
        rejectDeletion = reject;
    });
    let tracked!: Promise<void>;
    tracked = deletion.finally(() => {
        if (sessionOperationContext.state.sessionDeletionsInFlight.get(sessionId) === tracked) {
            sessionOperationContext.state.sessionDeletionsInFlight.delete(sessionId);
        }
    });
    sessionOperationContext.state.sessionDeletionsInFlight.set(sessionId, tracked);
    void sessionOpPerformSessionDeletion(sessionOperationContext, sessionId, retentionArchive).then(resolveDeletion, rejectDeletion);
    await tracked;
}

async function sessionOpPerformSessionDeletion(sessionOperationContext: SessionOperationContext, sessionId: string, retentionArchive?: () => boolean): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        sessionLog.warn(`Cannot delete session: ${sessionId} not found`);
        return;
    }
    // Get workspace root before detaching the session.
    const workspaceRootPath = managed.workspace.rootPath;
    const persistenceRootPath = managed.persistenceRootPath;
    const stopRequestedBeforeDeletion = managed.stopRequested;
    const wasProcessingBeforeDeletion = managed.isProcessing;
    const quiescence = {
        effectsStarted: false,
        runtimeTeardownStarted: false,
        runtimeTeardownProven: false,
    };
    // Linearize deletion before the first await. Removing the runtime entry
    // invalidates ownsStop()/new RPC work, while the persistence tombstone
    // rejects callbacks that still hold this exact ManagedSession snapshot.
    sessionOperationContext.state.retiringSessions.add(managed);
    sessionOperationContext.state.sessions.delete(sessionId);
    const persistenceRetirement = sessionPersistenceQueue.retire(sessionId, persistenceRootPath);
    const restoreSession = async (keepRetired = false, persistRestoredState = true): Promise<void> => {
        // Even a synchronous abort/archive failure can arrive before the normal
        // retirement await below. Drain the already-started writer first so
        // reactivation cannot race or mask the original deletion error.
        await persistenceRetirement;
        if (!keepRetired)
            sessionPersistenceQueue.reactivate(sessionId, persistenceRootPath);
        // Once quiescence has produced any effect, rollback remains fail-closed
        // even if runtime teardown was ultimately proven: an admitted operation
        // may already have changed this object before the drain. Keep both
        // persistence and runtime admissions retired, but put the object back in
        // the map so deletion can be retried (and a clean application restart can
        // recover the untouched transcript).
        managed.stopRequested = keepRetired
            ? true
            : quiescence.runtimeTeardownProven ? false : stopRequestedBeforeDeletion;
        if (!keepRetired)
            sessionOperationContext.state.retiringSessions.delete(managed);
        sessionOperationContext.state.sessions.set(sessionId, managed);
        if (keepRetired || !persistRestoredState)
            return;
        if (sessionOperationContext.owner["persistSession"](managed)) {
            try {
                await sessionOperationContext.owner.flushSession(sessionId);
            }
            catch (persistError) {
                sessionLog.error(`Failed to restore session ${sessionId} after deletion failure:`, persistError);
            }
        }
    };
    let deletionCommitted = false;
    let committedDeletionError: unknown;
    let rollbackPersistenceSafe = true;
    try {
        // Prove that no already-admitted runtime callback can still write a
        // sidecar/tmp file or approve work before moving the live directory.
        await sessionOpQuiesceSessionForDeletion(sessionOperationContext, managed, quiescence, wasProcessingBeforeDeletion);
        // Pending writes were cancelled synchronously when retirement started.
        // Runtime drains above may have attempted one final (rejected) snapshot;
        // now wait for every writer admitted before the retirement tombstone.
        await persistenceRetirement;
        // Internal retention archives the complete directory only after the
        // persistence queue is quiescent. Its callback is the atomic filesystem
        // linearization point and may still cancel the retirement.
        if (retentionArchive) {
            const verifiedRoot = persistenceRootFor(managed);
            if (verifiedRoot !== persistenceRootPath) {
                throw new SessionPersistenceRootIdentityError(`Session persistence root changed before retention: ${sessionId}`);
            }
            if (!retentionArchive()) {
                await restoreSession(quiescence.effectsStarted);
                return;
            }
            // The retention callback atomically moved the complete directory.
            deletionCommitted = true;
        }
        else {
            const verifiedRoot = persistenceRootFor(managed);
            if (verifiedRoot !== persistenceRootPath) {
                throw new SessionPersistenceRootIdentityError(`Session persistence root changed before deletion: ${sessionId}`);
            }
            const deletion = deleteStoredSessionAtomically(verifiedRoot, sessionId);
            if (!deletion.committed) {
                rollbackPersistenceSafe = deletion.failureReason !== 'unsafe-path';
                throw new Error(`Could not atomically remove session files for ${sessionId}`);
            }
            deletionCommitted = true;
            if (!deletion.durable) {
                sessionLog.warn(`Session ${sessionId} was detached but its deletion rename was not fully durable`);
            }
        }
    }
    catch (error) {
        if (error instanceof SessionPersistenceRootIdentityError) {
            rollbackPersistenceSafe = false;
        }
        if (retentionArchive && error instanceof CompletedChatArchiveError && error.committed) {
            deletionCommitted = true;
            committedDeletionError = error;
        }
        // Rollback is safe only before the atomic directory move committed. Once
        // committed, recreating the source would produce an incomplete duplicate.
        if (!deletionCommitted) {
            await restoreSession(quiescence.effectsStarted || !rollbackPersistenceSafe, rollbackPersistenceSafe);
        }
        if (!deletionCommitted)
            throw error;
    }
    const cleanupAfterCommit = async (label: string, operation: () => void | Promise<void>): Promise<void> => {
        try {
            await operation();
        }
        catch (error) {
            sessionLog.warn(`Post-commit ${label} failed for deleted session ${sessionId}:`, error);
        }
    };
    // Everything below is best-effort: the directory is already absent from
    // live storage and this method must return successfully so retention can
    // write its durable archivedAt receipt.
    if (managed.sharedId && !retentionArchive) {
        await cleanupAfterCommit('share revocation', async () => {
            const { VIEWER_URL } = await import('@craft-agent/shared/branding');
            const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
            if (!response.ok)
                sessionLog.warn(`Failed to revoke share for ${sessionId}: HTTP ${response.status}`);
            else
                sessionLog.info(`Revoked share for deleted session ${sessionId}`);
        });
    }
    await cleanupAfterCommit('pending state cleanup', () => {
        const timer = sessionOperationContext.state.deltaFlushTimers.get(sessionId);
        if (timer)
            clearTimeout(timer);
        sessionOperationContext.state.deltaFlushTimers.delete(sessionId);
        sessionOperationContext.state.pendingDeltas.delete(sessionId);
        sessionOpClearAdminRememberApprovalsForSession(sessionOperationContext, sessionId);
        sessionOpClearPendingPermissionRequestsForSession(sessionOperationContext, sessionId);
    });
    await cleanupAfterCommit('tool callback cleanup', () => {
        unregisterSessionScopedToolCallbacks(sessionId);
        clearObjectiveEvidenceGate(sessionId);
    });
    await cleanupAfterCommit('browser cleanup', async () => {
        try {
            await sessionOperationContext.owner.getBrowserPaneManagerForSession(sessionId)?.destroyForSession(sessionId);
        }
        finally {
            sessionOperationContext.state.remoteBpms.delete(sessionId);
            sessionOperationContext.state.browserHostByCanvas.delete(sessionId);
        }
    });
    await cleanupAfterCommit('context cleanup', () => destroyContextualGmailSessionState(sessionId));
    await cleanupAfterCommit('automatic retry cleanup', () => {
        if (managed.autoRetryTimer)
            clearTimeout(managed.autoRetryTimer);
        managed.autoRetryTimer = undefined;
        managed.autoRetryPending = undefined;
    });
    await cleanupAfterCommit('execution proof cleanup', () => sessionOperationContext.state.executionProofCollector.discard(sessionId));
    await cleanupAfterCommit('automation metadata cleanup', () => {
        sessionOperationContext.state.automationSystems.get(workspaceRootPath)?.removeSessionMetadata(sessionId);
    });
    // Notify all windows for this workspace that the session was deleted
    await cleanupAfterCommit('deletion notification', () => {
        sessionOperationContext.owner["sendEvent"]({ type: 'session_deleted', sessionId }, managed.workspace.id);
        sessionOperationContext.owner["emitUnreadSummaryChanged"]();
    });
    sessionLog.info(`Deleted session ${sessionId}`);
    if (committedDeletionError) {
        sessionLog.warn(`Session ${sessionId} archive committed despite a publication error; continuing with the durable retention receipt`, {
            error: committedDeletionError instanceof Error ? committedDeletionError.message : String(committedDeletionError),
            archivePath: committedDeletionError instanceof CompletedChatArchiveError
                ? committedDeletionError.archivePath
                : undefined,
        });
    }
}

export { sessionOpDeleteSession as deleteSession };
export { sessionOpPerformSessionDeletion as performSessionDeletion };
