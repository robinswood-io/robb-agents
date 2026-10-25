import type { SessionOperationContext } from '../operation-context.ts';
import { validAllocatedRecoveryDispatch, persistenceRootFor, isClosedColdResumeStatus } from '../policy.ts';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { loadSession as loadStoredSession } from '@craft-agent/shared/sessions';
import { storedToMessage } from '@craft-agent/core/types';
import { orderAutonomousRestartFrontier } from '../../autonomous-session-admission';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { repairPersistedFalseCompletion } from '../session-creation.ts';
import { resolveEffectiveSessionSourceSelection } from '../source-selection.ts';
import { isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked } from './pending-recovery-belongs-to-current-objective.ts';
import { isCleanSetupPersistenceFenced as sessionOpIsCleanSetupPersistenceFenced, clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry } from './start-recovery-dispatch.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, hasAnyRetainedStoppedAgentDelivery as sessionOpHasAnyRetainedStoppedAgentDelivery } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { getPendingUserInputResponse as sessionOpGetPendingUserInputResponse } from './user-input-recovery.ts';
import { restoreDurableRuntimeState as sessionOpRestoreDurableRuntimeState } from './restore-durable-runtime-state.ts';

async function sessionOpDrainDeferredAutomaticSessions(sessionOperationContext: SessionOperationContext): Promise<void> {
    if (sessionOperationContext.state.shuttingDown)
        return;
    if (sessionOperationContext.state.automaticAdmissionDrain)
        return sessionOperationContext.state.automaticAdmissionDrain;
    const operation = (async () => {
        const candidates = orderAutonomousRestartFrontier([...sessionOperationContext.state.deferredAutomaticSessions]
            .map(id => sessionOperationContext.state.sessions.get(id)).filter((s): s is ManagedSession => !!s), id => sessionOperationContext.state.sessions.get(id));
        for (const managed of candidates) {
            if (sessionOperationContext.state.shuttingDown)
                return;
            if (sessionOperationContext.state.sessions.get(managed.id) !== managed)
                continue;
            if (sessionOperationContext.state.deferredAutomaticRetryTimers.has(managed.id))
                continue;
            if (managed.isProcessing) {
                sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
                continue;
            }
            const allocatedSetupRecovery = managed.pendingTurnRecovery
                ? validAllocatedRecoveryDispatch(managed.pendingTurnRecovery)
                : undefined;
            const setupBlocked = sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, allocatedSetupRecovery);
            const setupPersistenceFenced = sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, allocatedSetupRecovery);
            const terminalMachineInbox = (sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
                && managed.messageQueue.length > 0 && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
                || (sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, managed) && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed));
            const humanPendingRecovery = managed.pendingTurnRecovery?.lastCause === 'user_retry'
                || !!sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true);
            // Before lazy hydration the transcript/FIFO proof is unavailable, but
            // an answered request in metadata is enough to require the fail-closed
            // resume path below to load and authenticate it. Treating the empty
            // header-only queue as terminal here would discard a durable answer
            // without ever examining its canonical row.
            const terminalAnsweredUserInputHint = sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
                && managed.userInputRequests?.some(request => (request.status === 'answered'
                    && request.sessionId === managed.id
                    && request.originWorkspaceId === managed.workspace.id
                    && request.objectiveUserMessageId === managed.activeObjective?.userMessageId)) === true;
            const terminalPendingRecovery = sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
                && managed.messageQueue.length === 0 && !!managed.pendingTurnRecovery
                && !humanPendingRecovery && !terminalAnsweredUserInputHint;
            if (!setupBlocked && !setupPersistenceFenced
                && (isClosedColdResumeStatus(managed) || terminalMachineInbox || terminalPendingRecovery)) {
                sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
                sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
                continue;
            }
            try {
                const allocated = allocatedSetupRecovery;
                const cleanRetryOwnsProviderBoundary = !!allocated?.cleanContinuationId;
                if (cleanRetryOwnsProviderBoundary)
                    await sessionOperationContext.owner["resumePendingTurnAfterRestart"](managed.id);
                else if (managed.messageQueue.length)
                    sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
                else if (managed.pendingTurnRecovery)
                    await sessionOperationContext.owner["resumePendingTurnAfterRestart"](managed.id);
                else
                    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
                if (managed.isProcessing || sessionOperationContext.state.queuedMessageDispatches.has(managed.id)
                    || !sessionOperationContext.state.deferredAutomaticSessions.has(managed.id)) {
                    sessionOpClearDeferredAutomaticRetry(sessionOperationContext, managed.id);
                }
            }
            catch (error) {
                sessionLog.error('Deferred automatic admission failed', { sessionId: managed.id, error: error instanceof Error ? error.message : String(error) });
                if (!sessionOperationContext.state.shuttingDown && sessionOperationContext.state.sessions.get(managed.id) === managed
                    && !managed.stopRequested && !sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
                    && (managed.messageQueue.length > 0 || !!managed.pendingTurnRecovery)) {
                    sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
                    sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](managed.id);
                }
                else {
                    sessionOpClearDeferredAutomaticRetry(sessionOperationContext, managed.id);
                }
            }
            finally {
                if (!managed.isProcessing && !sessionOperationContext.state.queuedMessageDispatches.has(managed.id)
                    && !sessionOperationContext.state.retryTurnsInFlight.has(managed.id))
                    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
            }
        }
    })();
    sessionOperationContext.state.automaticAdmissionDrain = operation;
    try {
        await operation;
    }
    finally {
        if (sessionOperationContext.state.automaticAdmissionDrain === operation)
            sessionOperationContext.state.automaticAdmissionDrain = undefined;
        if (sessionOperationContext.state.automaticAdmissionDrainWakeRequested) {
            sessionOperationContext.state.automaticAdmissionDrainWakeRequested = false;
            sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
        }
    }
}

// Cold-persist hydration. Mirrors the messages/queue-recovery half of
// loadMessagesFromDisk but skips the metadata field syncs. Sets
// messagesLoaded=true so subsequent persistSession calls take the fast path.
// Subsequent ensureMessagesLoaded calls also short-circuit, which is fine —
// queue recovery has already run here.
function sessionOpHydrateMessagesForColdPersist(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    sessionLog.debug(`Cold-load triggered for persistSession on ${managed.id}`);
    const stored = loadStoredSession(persistenceRootFor(managed), managed.id);
    if (stored) {
        managed.messages = (stored.messages || []).map(storedToMessage);
        managed.tokenUsage = stored.tokenUsage;
        // Deferred-load fields (intentionally undefined after startup, see
        // loadSessionsFromDisk). Populate from disk only if not already set in
        // memory — a caller may have mutated them via setSessionSources etc.
        if (managed.enabledSourceSlugs === undefined) {
            Object.assign(managed, resolveEffectiveSessionSourceSelection(stored.enabledSourceSlugs, loadWorkspaceConfig(managed.workspace.rootPath)?.defaults?.enabledSourceSlugs));
        }
        if (managed.lastReadMessageId === undefined)
            managed.lastReadMessageId = stored.lastReadMessageId;
        if (managed.hasUnread === undefined)
            managed.hasUnread = stored.hasUnread;
        if (managed.sharedUrl === undefined)
            managed.sharedUrl = stored.sharedUrl;
        if (managed.sharedId === undefined)
            managed.sharedId = stored.sharedId;
        if (managed.transferredSessionSummary === undefined)
            managed.transferredSessionSummary = stored.transferredSessionSummary;
        if (managed.transferredSessionSummaryApplied === undefined)
            managed.transferredSessionSummaryApplied = stored.transferredSessionSummaryApplied;
        if (managed.autonomyEvents === undefined)
            managed.autonomyEvents = stored.autonomyEvents;
        repairPersistedFalseCompletion(managed);
        sessionOpRestoreDurableRuntimeState(sessionOperationContext, managed);
        sessionLog.debug(`Cold-hydrated ${managed.messages.length} messages for session ${managed.id}`);
    }
    managed.messagesLoaded = true;
}

export { sessionOpDrainDeferredAutomaticSessions as drainDeferredAutomaticSessions };
export { sessionOpHydrateMessagesForColdPersist as hydrateMessagesForColdPersist };
