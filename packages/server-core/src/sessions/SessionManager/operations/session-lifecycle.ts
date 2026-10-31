import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor, reconcileCompletedChatRetention } from '../policy.ts';
import { abandonCompletedChatArchive, archiveCompletedChatDirectory, captureCompletedChatMemory, CompletedChatArchiveError, finalizeCompletedChatArchive, hasProtectedChatWorktree, isCompletedChatDue, prepareCompletedChatArchive, readCompletedChatMemory, reopenCompletedChat } from '../../completed-chat-retention';
import { existsSync } from 'fs';
import { getWorkspaces } from '@craft-agent/shared/config';
import { loadSession as loadStoredSession, getSessionPath as getSessionStoragePath, captureSessionPersistenceRootPath, SessionPersistenceRootIdentityError } from '@craft-agent/shared/sessions';
import type { SessionStatus } from '@craft-agent/shared/sessions';
import { storedToMessage } from '@craft-agent/core/types';
import { loadStatusConfig } from '@craft-agent/shared/statuses/storage';
import { getProjectLearningPolicy } from '../../project-learning';
import { resolveLifecycleStartStatus, resolveLifecycleTerminalStatus } from '../../session-status-lifecycle';
import type { SessionLifecycleStopReason } from '../../session-status-lifecycle';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { pruneAutoRetryTombstones } from '../source-activation.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner } from './track-session-operation.ts';
import { hasRunningBackgroundTasks as sessionOpHasRunningBackgroundTasks } from './evict-idle-session-runtimes.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';

async function sessionOpFlagSession(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.isFlagged = true;
            // Persist in-memory state directly to avoid race with pending queue writes
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            // Notify all windows for this workspace
            sessionOperationContext.owner["sendEvent"]({ type: 'session_flagged', sessionId }, managed.workspace.id);
            // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
            // directories created after the watcher started.
            // https://github.com/oven-sh/bun/issues/15939
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
        });
}

async function sessionOpUnflagSession(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.isFlagged = false;
            // Persist in-memory state directly to avoid race with pending queue writes
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            // Notify all windows for this workspace
            sessionOperationContext.owner["sendEvent"]({ type: 'session_unflagged', sessionId }, managed.workspace.id);
            // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
            // directories created after the watcher started.
            // https://github.com/oven-sh/bun/issues/15939
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
        });
}

async function sessionOpArchiveSession(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.isArchived = true;
            managed.archivedAt = Date.now();
            // Persist in-memory state directly to avoid race with pending queue writes
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            // Notify all windows for this workspace
            sessionOperationContext.owner["sendEvent"]({ type: 'session_archived', sessionId }, managed.workspace.id);
            sessionOperationContext.owner["emitUnreadSummaryChanged"]();
        });
}

async function sessionOpUnarchiveSession(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            managed.isArchived = false;
            managed.archivedAt = undefined;
            // Persist in-memory state directly to avoid race with pending queue writes
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            // Notify all windows for this workspace
            sessionOperationContext.owner["sendEvent"]({ type: 'session_unarchived', sessionId }, managed.workspace.id);
            sessionOperationContext.owner["emitUnreadSummaryChanged"]();
        });
}

async function sessionOpSetSessionStatus(sessionOperationContext: SessionOperationContext, sessionId: string, sessionStatus: SessionStatus, assertActivePreparation?: () => void): Promise<void> {
    if (sessionOperationContext.state.retentionDeleting.has(sessionId))
        throw new Error('This completed chat is being removed by retention');
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (managed)
        return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
            sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            // Invalidate the previous completion before a reopening is persisted.
            if (sessionStatus !== 'done')
                reopenCompletedChat(persistenceRootFor(managed), sessionId);
            managed.sessionStatus = sessionStatus;
            sessionOperationContext.owner["setMetadataWriteGuard"](managed);
            // Persist in-memory state directly to avoid race with pending queue writes
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            assertActivePreparation?.();
            // Notify all windows for this workspace
            sessionOperationContext.owner["sendEvent"]({ type: 'session_status_changed', sessionId, sessionStatus }, managed.workspace.id);
            // Workaround: Bun's fs.watch({ recursive: true }) on Linux doesn't track
            // directories created after the watcher started.
            // https://github.com/oven-sh/bun/issues/15939
            const watcher = sessionOperationContext.state.configWatchers.get(managed.workspace.rootPath);
            watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`);
            if (sessionStatus === 'done')
                sessionOpScheduleCompletedChatRetention(sessionOperationContext);
        });
}

function sessionOpStartCompletedChatRetention(sessionOperationContext: SessionOperationContext): void {
    sessionOperationContext.state.retentionStopping = false;
    sessionOpScheduleCompletedChatRetention(sessionOperationContext);
    sessionOperationContext.state.completedChatRetentionTimer = setInterval(() => sessionOpScheduleCompletedChatRetention(sessionOperationContext), 60 * 60 * 1000);
    sessionOperationContext.state.completedChatRetentionTimer.unref?.();
}

function sessionOpScheduleCompletedChatRetention(sessionOperationContext: SessionOperationContext): void {
    if (sessionOperationContext.state.retentionStopping || sessionOperationContext.state.completedChatRetentionSweep)
        return;
    sessionOperationContext.state.completedChatRetentionSweep = sessionOpSweepCompletedChats(sessionOperationContext).catch((error: unknown) => {
        sessionLog.warn('Completed-chat retention failed; chats preserved', { error: String(error) });
    }).finally(() => { delete sessionOperationContext.state.completedChatRetentionSweep; });
}

function sessionOpCanRetainCompletedChat(sessionOperationContext: SessionOperationContext, managed: ManagedSession, detachedForDeletion = false): boolean {
    const ownsSession = sessionOperationContext.state.sessions.get(managed.id) === managed
        || (detachedForDeletion && sessionOperationContext.state.retiringSessions.has(managed));
    // Expired/terminal source-activation tombstones are not live work and must
    // not pin an otherwise completed chat forever.
    pruneAutoRetryTombstones(managed, Date.now());
    const sourceActivation = managed.autoRetryPending;
    const hasLiveSourceActivation = managed.autoRetryTimer !== undefined
        || !!sourceActivation && (!sourceActivation.cancelled
            || !sourceActivation.committed || sourceActivation.dispatchInFlight);
    const hasQueuedAgentDeliveryDispatch = [...sessionOperationContext.state.queuedAgentDeliveryDispatches.values()]
        .some(dispatch => dispatch.sessionId === managed.id);
    const hasVolatileAdmission = sessionOperationContext.state.deferredAutomaticSessions.has(managed.id)
        || sessionOperationContext.state.automaticAdmissionReservations.has(managed.id)
        || sessionOperationContext.state.queuedMessageDispatches.has(managed.id)
        || hasQueuedAgentDeliveryDispatch
        || sessionOperationContext.state.deferredAutomaticRetryTimers.has(managed.id)
        || sessionOperationContext.state.retryTurnsInFlight.has(managed.id)
        || sessionOperationContext.state.restartRecoveriesInFlight.has(managed.id)
        || sessionOperationContext.state.coldProviderReconciliationsInFlight.has(managed.id)
        || sessionOperationContext.state.providerRetryReconciliationTransactions.has(managed.id)
        || sessionOperationContext.state.providerLiveReconciliationTransactions.has(managed.id)
        || hasLiveSourceActivation;
    const hasVolatileTransaction = (sessionOperationContext.state.sessionOperationsInFlight.get(managed)?.size ?? 0) > 0
        || sessionOperationContext.state.directHumanSupersessionsInFlight.has(managed)
        || sessionOperationContext.state.directHumanSupersessionTransactions.has(managed)
        || sessionOperationContext.state.sourceActivationTransactions.has(managed)
        || sessionOperationContext.state.toolAdmissionTransactions.has(managed)
        || (sessionOperationContext.state.runtimeDisposalsInFlight.get(managed.id)?.size ?? 0) > 0
        || (sessionOperationContext.state.runtimeDisposalBarriers.get(managed.id)?.size ?? 0) > 0;
    return ownsSession && !sessionOperationContext.state.retentionStopping && !sessionOperationContext.state.shuttingDown
        && (!managed.stopRequested || detachedForDeletion)
        && managed.sessionStatus === 'done' && !managed.isProcessing
        && !hasVolatileAdmission && !hasVolatileTransaction
        && (!managed.activeObjective || managed.activeObjective.terminalState === 'complete_verified')
        && !managed.messageQueue.length && !sessionOpHasRunningBackgroundTasks(sessionOperationContext, managed)
        && !sessionOperationContext.state.agentRefreshLocks.has(managed.id) && !sessionOpHasPendingDecision(sessionOperationContext, managed)
        && !sessionOperationContext.owner["hasPendingUserInput"](managed) && !sessionOpHasQueuedUserInput(sessionOperationContext, managed)
        && !managed.pendingQueuedMessageIds?.length
        && !managed.pendingAgentDeliveryIds?.length && !managed.pendingTurnRecovery
        && ![...sessionOperationContext.state.pendingPermissionRequests.values()].some(request => request.sessionId === managed.id)
        && ![...sessionOperationContext.state.sessions.values()].some(child => {
            if (child.id === managed.id || child.workspace.id !== managed.workspace.id
                || !(child.isProcessing || child.stopRequested || child.messageQueue.length || sessionOpHasRunningBackgroundTasks(sessionOperationContext, child)
                    || sessionOpHasPendingDecision(sessionOperationContext, child) || sessionOpHasQueuedUserInput(sessionOperationContext, child)
                    || child.pendingQueuedMessageIds?.length || child.pendingAgentDeliveryIds?.length || child.pendingTurnRecovery
                    || child.activeObjective && child.activeObjective.terminalState !== 'complete_verified'))
                return false;
            const seen = new Set<string>();
            let parentId = child.parentSessionId;
            while (parentId && !seen.has(parentId)) {
                if (parentId === managed.id)
                    return true;
                seen.add(parentId);
                const parent = sessionOperationContext.state.sessions.get(parentId);
                if (!parent || parent.workspace.id !== managed.workspace.id)
                    return false;
                parentId = parent.parentSessionId;
            }
            return false;
        });
}

async function sessionOpSweepCompletedChats(sessionOperationContext: SessionOperationContext, now = Date.now(), archiveChat: typeof archiveCompletedChatDirectory = archiveCompletedChatDirectory): Promise<void> {
    // Reconcile write-ahead receipts independently of the live session map.
    // A successfully renamed session is intentionally absent from that map on
    // restart, but its durable target still proves the archive commit.
    const roots = new Set(getWorkspaces().map(workspace => (captureSessionPersistenceRootPath(workspace.rootPath))));
    for (const managed of sessionOperationContext.state.sessions.values()) {
        try {
            roots.add(persistenceRootFor(managed));
        }
        catch (error) {
            sessionLog.warn('Skipped completed-chat reconciliation for a replaced workspace root', {
                sessionId: managed.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    for (const root of roots)
        reconcileCompletedChatRetention(root);
    // Sequential work keeps historical transcripts out of memory after each capture.
    for (const managed of [...sessionOperationContext.state.sessions.values()]) {
        if (sessionOperationContext.state.retentionStopping)
            return;
        // Retention owns session files and receipts. Use the same captured
        // physical root as persistence/deletion so a retargeted workspace alias
        // cannot redirect archival to a homonymous session in another root.
        try {
            const root = persistenceRootFor(managed);
            const assertRoot = (): string => {
                const verifiedRoot = persistenceRootFor(managed);
                if (verifiedRoot !== root) {
                    throw new SessionPersistenceRootIdentityError(`Completed-chat persistence root changed: ${managed.id}`);
                }
                return verifiedRoot;
            };
            if (managed.sessionStatus !== 'done') {
                reopenCompletedChat(root, managed.id, now);
                continue;
            }
            if (!sessionOpCanRetainCompletedChat(sessionOperationContext, managed))
                continue;
            const receipt = readCompletedChatMemory(root, managed.id);
            const policy = await getProjectLearningPolicy(root);
            assertRoot();
            if (!policy.enabled) {
                if (receipt?.archiveIntent) {
                    abandonCompletedChatArchive(root, managed.id, receipt.archiveIntent.targetPath);
                }
                continue;
            }
            if (!sessionOpCanRetainCompletedChat(sessionOperationContext, managed))
                continue;
            if (receipt && !receipt.reopenedAt && !receipt.deletedAt
                && receipt.lastActivityAt === managed.lastMessageAt && receipt.projectId === managed.projectId
                && !isCompletedChatDue(receipt, now))
                continue;
            assertRoot();
            const stored = managed.messagesLoaded ? undefined : loadStoredSession(root, managed.id);
            if (!managed.messagesLoaded && !stored)
                throw new Error('Transcript unavailable; retention blocked');
            const memory = captureCompletedChatMemory(root, {
                id: managed.id, ...(managed.name !== undefined ? { name: managed.name } : {}), ...(managed.projectId !== undefined ? { projectId: managed.projectId } : {}),
                lastMessageAt: managed.lastMessageAt,
                messages: managed.messagesLoaded ? managed.messages : stored!.messages.map(storedToMessage),
            }, now);
            if (!isCompletedChatDue(memory, now))
                continue;
            if (hasProtectedChatWorktree(getSessionStoragePath(root, managed.id))) {
                sessionLog.warn('Completed chat contains a repository/worktree; preserving it', { sessionId: managed.id });
                if (memory.archiveIntent) {
                    abandonCompletedChatArchive(root, managed.id, memory.archiveIntent.targetPath);
                }
                continue;
            }
            // Keep reopening available during persistence. A human instruction
            // accepted while this await yields must cancel the pending purge.
            await sessionOperationContext.owner.flushSession(managed.id);
            assertRoot();
            if (!sessionOpCanRetainCompletedChat(sessionOperationContext, managed))
                continue;
            sessionOperationContext.state.retentionDeleting.add(managed.id);
            try {
                // Re-read and verify the durable receipt immediately before deletion.
                assertRoot();
                const confirmed = captureCompletedChatMemory(root, {
                    id: managed.id, ...(managed.name !== undefined ? { name: managed.name } : {}), ...(managed.projectId !== undefined ? { projectId: managed.projectId } : {}),
                    lastMessageAt: managed.lastMessageAt,
                    messages: managed.messagesLoaded ? managed.messages : loadStoredSession(root, managed.id)!.messages.map(storedToMessage),
                }, now);
                if (!isCompletedChatDue(confirmed, now))
                    continue;
                assertRoot();
                const planned = prepareCompletedChatArchive(root, confirmed, now);
                const intent = planned.archiveIntent;
                if (!intent)
                    throw new Error('Completed-chat archive intent was not persisted');
                let archivePath: string | undefined;
                await sessionOperationContext.owner.deleteSession(managed.id, () => {
                    if (!sessionOpCanRetainCompletedChat(sessionOperationContext, managed, true))
                        return false;
                    const verifiedRoot = persistenceRootFor(managed);
                    if (verifiedRoot !== root) {
                        throw new SessionPersistenceRootIdentityError(`Completed-chat persistence root changed before archive: ${managed.id}`);
                    }
                    // Linearization point: guard and atomic move run without yielding,
                    // before any permission/queue/runtime cleanup can erase new intent.
                    try {
                        archivePath = archiveChat(root, getSessionStoragePath(root, managed.id), managed.id, intent.targetPath, intent);
                    }
                    catch (error) {
                        // The move may have committed even when its durability check or
                        // rollback failed. Preserve that exact destination so deletion
                        // can finish the receipt without recreating the live source.
                        if (error instanceof CompletedChatArchiveError && error.committed) {
                            archivePath = error.archivePath ?? intent.targetPath;
                        }
                        throw error;
                    }
                    return true;
                });
                if (!archivePath) {
                    abandonCompletedChatArchive(root, managed.id, intent.targetPath);
                    continue;
                }
                if (existsSync(getSessionStoragePath(root, managed.id)))
                    throw new Error('Chat archival did not complete');
                if (archivePath !== intent.targetPath)
                    throw new Error('Chat archival used an unexpected destination');
                finalizeCompletedChatArchive(root, managed.id, archivePath);
                sessionLog.info('Completed chat archived with all attachments preserved', { sessionId: managed.id, archivePath });
            }
            finally {
                sessionOperationContext.state.retentionDeleting.delete(managed.id);
            }
        }
        catch (error) {
            sessionLog.warn('Completed-chat retention skipped', { sessionId: managed.id, error: String(error) });
        }
        finally {
            // Every path, including unopened/active/young/corrupt chats, yields.
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }
}

async function sessionOpBeginAutomaticSessionStatusLifecycle(sessionOperationContext: SessionOperationContext, managed: ManagedSession, explicitRetry = false, assertActivePreparation?: () => void): Promise<void> {
    const config = loadStatusConfig(managed.workspace.rootPath);
    const startStatus = resolveLifecycleStartStatus(config, explicitRetry ? undefined : managed.sessionStatus);
    managed.turnLifecycleManagedStatus = undefined;
    if (!startStatus)
        return;
    if (managed.sessionStatus !== startStatus) {
        await sessionOperationContext.owner.setSessionStatus(managed.id, startStatus, assertActivePreparation);
    }
    assertActivePreparation?.();
    managed.turnLifecycleManagedStatus = startStatus;
}

async function sessionOpFinishAutomaticSessionStatusLifecycle(sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: SessionLifecycleStopReason, assertStopOwnership?: () => void): Promise<void> {
    const lifecycleOwnedStatus = managed.turnLifecycleManagedStatus;
    managed.turnLifecycleManagedStatus = undefined;
    if (!lifecycleOwnedStatus || managed.sessionStatus !== lifecycleOwnedStatus)
        return;
    const config = loadStatusConfig(managed.workspace.rootPath);
    const terminalStatus = resolveLifecycleTerminalStatus(config, reason);
    if (terminalStatus && terminalStatus !== managed.sessionStatus) {
        await sessionOperationContext.owner.setSessionStatus(managed.id, terminalStatus, assertStopOwnership);
    }
}

export { sessionOpFlagSession as flagSession };
export { sessionOpUnflagSession as unflagSession };
export { sessionOpArchiveSession as archiveSession };
export { sessionOpUnarchiveSession as unarchiveSession };
export { sessionOpSetSessionStatus as setSessionStatus };
export { sessionOpStartCompletedChatRetention as startCompletedChatRetention };
export { sessionOpScheduleCompletedChatRetention as scheduleCompletedChatRetention };
export { sessionOpCanRetainCompletedChat as canRetainCompletedChat };
export { sessionOpSweepCompletedChats as sweepCompletedChats };
export { sessionOpBeginAutomaticSessionStatusLifecycle as beginAutomaticSessionStatusLifecycle };
export { sessionOpFinishAutomaticSessionStatusLifecycle as finishAutomaticSessionStatusLifecycle };
