import type { SessionOperationContext } from '../operation-context.ts';
import { providerDispatchesAwaitingColdReconciliation, queuedDirectHumanContinuationIndex, isClosedColdResumeStatus } from '../policy.ts';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import type { Message } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, hasAnyRetainedStoppedAgentDelivery as sessionOpHasAnyRetainedStoppedAgentDelivery } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { enqueueUnscheduledQueuedUserInputAnswers as sessionOpEnqueueUnscheduledQueuedUserInputAnswers } from './perform-request-user-input.ts';

export type ColdProviderRollbackSnapshot = {
        messages: Message[];
        messageQueue: ManagedSession['messageQueue'];
        pendingTurnRecovery: PendingTurnRecovery | undefined;
        autoRetryPending: ManagedSession['autoRetryPending'];
        pendingQueuedMessageIds: string[] | undefined;
        pendingAgentDeliveryIds: string[] | undefined;
    } | undefined;

export function publishColdProviderReconciliation(managed: ManagedSession, sessionOperationContext: SessionOperationContext, providerDispatchSnapshotNeedsDurability: boolean, providerDispatchRollbackSnapshot: ColdProviderRollbackSnapshot, providerDispatchQuarantineMessage: Message | undefined, durableRuntimeStateChanged: boolean, retainedMachineInbox: boolean, closedColdResumeStatus: boolean, recoveredConsumedAgentDeliveryNeedsContinuation: boolean, recoveredProviderDispatchNeedsContinuation: boolean): void {
    if (providerDispatchSnapshotNeedsDurability) {
        sessionOperationContext.state.coldProviderReconciliationsInFlight.add(managed.id);
        sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        const reconciliationCancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
        const reconciliationAuthorityEpoch = sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0;
        const reconciliationObjective = managed.activeObjective;
        const reconciliationMessages = managed.messages;
        const reconciliationQueue = managed.messageQueue;
        const reconciliationPending = managed.pendingTurnRecovery;
        const reconciliationAutoRetryPending = managed.autoRetryPending;
        const persistQueued = sessionOperationContext.owner.enqueuePersist(managed);
        const reconciliationPersistenceEpoch = sessionOperationContext.state.sessionPersistenceEpochs.get(managed) ?? 0;
        const reconciliationStructurallyCurrent = () => (sessionOperationContext.state.sessions.get(managed.id) === managed
            && (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) === reconciliationCancellationEpoch
            && (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) === reconciliationAuthorityEpoch
            && managed.activeObjective === reconciliationObjective
            && managed.messages === reconciliationMessages
            && managed.messageQueue === reconciliationQueue
            && managed.pendingTurnRecovery === reconciliationPending
            && managed.autoRetryPending === reconciliationAutoRetryPending);
        const reconciliationStillCurrent = () => (reconciliationStructurallyCurrent()
            && (sessionOperationContext.state.sessionPersistenceEpochs.get(managed) ?? 0) === reconciliationPersistenceEpoch);
        const persistRecovery = persistQueued
            ? sessionOperationContext.owner.flushSessionDurably(managed.id)
            : Promise.reject(new Error('Failed to queue cold provider reconciliation'));
        void persistRecovery.then(() => {
            sessionOperationContext.state.coldProviderReconciliationsInFlight.delete(managed.id);
            // Stop and newer objective/auth transitions own their state even when
            // they race the storage barrier. Never schedule work from the stale
            // pre-race transaction after its write happens to finish.
            if (!reconciliationStructurallyCurrent() || managed.isProcessing) {
                if (!managed.isProcessing && !managed.agent?.isProcessing()
                    && sessionOpEnqueueUnscheduledQueuedUserInputAnswers(sessionOperationContext, managed) > 0) {
                    sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
                }
                return;
            }
            if (!managed.agent?.isProcessing()
                && sessionOpEnqueueUnscheduledQueuedUserInputAnswers(sessionOperationContext, managed) > 0) {
                sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
                return;
            }
            if (providerDispatchesAwaitingColdReconciliation(managed).length > 0) {
                sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error', sessionId: managed.id,
                    error: {
                        code: 'provider_error',
                        title: 'Provider dispatch requires reconciliation',
                        message: 'One or more provider dispatch receipts remain ambiguous. Automatic replay is disabled; use Retry only after verifying the active objective and pending blockers.',
                        actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                        canRetry: true,
                    },
                }, managed.workspace.id);
                return;
            }
            // A persisted direct-human continuation is stronger than the synthetic
            // recovery allocated from the preceding objective. In particular this
            // path cancels a restored auth handoff instead of leaving the FIFO
            // permanently parked behind hasPendingDecision().
            if (queuedDirectHumanContinuationIndex(managed) >= 0) {
                sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
                return;
            }
            if (managed.pendingTurnRecovery
                && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, managed.pendingTurnRecovery)) {
                sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
                if (sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed))
                    return;
                sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
            }
            else if (managed.messageQueue.length > 0) {
                sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
            }
        }, (error: unknown) => {
            sessionOperationContext.state.coldProviderReconciliationsInFlight.delete(managed.id);
            const canRestoreColdSnapshot = reconciliationStillCurrent();
            if (canRestoreColdSnapshot && providerDispatchRollbackSnapshot) {
                managed.messages = providerDispatchRollbackSnapshot.messages;
                managed.messageQueue = providerDispatchRollbackSnapshot.messageQueue;
                managed.pendingTurnRecovery = providerDispatchRollbackSnapshot.pendingTurnRecovery;
                managed.autoRetryPending = providerDispatchRollbackSnapshot.autoRetryPending;
                managed.pendingQueuedMessageIds = providerDispatchRollbackSnapshot.pendingQueuedMessageIds;
                managed.pendingAgentDeliveryIds = providerDispatchRollbackSnapshot.pendingAgentDeliveryIds;
                sessionOperationContext.owner.enqueuePersist(managed);
            }
            if (!canRestoreColdSnapshot) {
                sessionLog.warn('Ignored stale cold provider reconciliation failure after a newer transition won', {
                    sessionId: managed.id,
                    error: error instanceof Error ? error.message : String(error),
                });
                if (!managed.isProcessing && !managed.agent?.isProcessing()
                    && sessionOpEnqueueUnscheduledQueuedUserInputAnswers(sessionOperationContext, managed) > 0) {
                    sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
                }
                return;
            }
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error', sessionId: managed.id,
                error: {
                    code: 'provider_error',
                    title: 'Provider recovery state was not persisted',
                    message: 'The exact provider prompt remains quarantined because its non-replay recovery snapshot could not be made durable. Retry after storage is available.',
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                    canRetry: true,
                },
            }, managed.workspace.id);
            sessionLog.warn('Failed to persist atomic cold provider reconciliation', {
                sessionId: managed.id,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    else if (providerDispatchQuarantineMessage) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        sessionOperationContext.owner["sendEvent"]({
            type: 'typed_error', sessionId: managed.id,
            error: {
                code: 'provider_error',
                title: 'Provider dispatch requires reconciliation',
                message: 'The preserved provider dispatch is ambiguous, stale, blocked, or no longer bound to the active objective. Automatic replay is disabled; resolve the pending blocker or use Retry to reconcile it explicitly.',
                actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                canRetry: true,
            },
        }, managed.workspace.id);
        if (durableRuntimeStateChanged) {
            sessionOperationContext.owner.enqueuePersist(managed);
            void sessionOperationContext.owner.flushSession(managed.id).catch((error: unknown) => {
                sessionLog.warn('Failed to persist provider-acceptance quarantine during restore', {
                    sessionId: managed.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    }
    else if (retainedMachineInbox) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
        sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
        const reconcile = () => {
            if (!sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))
                return;
            void sessionOperationContext.owner.reconcileRetainedTerminalMachineInbox(managed.id).catch((error: unknown) => {
                sessionLog.warn('Retained terminal inbox reconciliation failed', {
                    sessionId: managed.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        };
        if (durableRuntimeStateChanged) {
            sessionOperationContext.owner.enqueuePersist(managed);
            void sessionOperationContext.owner.flushSession(managed.id).then(reconcile, (error: unknown) => {
                sessionLog.warn('Failed to persist durable runtime recovery during restore', {
                    sessionId: managed.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
        else
            setImmediate(reconcile);
    }
    else if (!closedColdResumeStatus && !managed.isProcessing && managed.messageQueue.length) {
        // Re-check at callback time as metadata can change between hydration and
        // dequeue. A direct human row may open a new objective; a machine-only
        // inbox cannot reopen a terminal objective.
        const resumeQueue = () => {
            const current = sessionOperationContext.state.sessions.get(managed.id);
            if (current !== managed || isClosedColdResumeStatus(current))
                return;
            if ((sessionOpHasTerminalObjectiveState(sessionOperationContext, current) && sessionOpHasOnlyMachineInbox(sessionOperationContext, current))
                || (sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, current) && sessionOpHasOnlyMachineInbox(sessionOperationContext, current)))
                return;
            sessionOperationContext.owner["processNextQueuedMessage"](current.id);
        };
        if (durableRuntimeStateChanged) {
            // Queue the cleaned snapshot directly: persistSession would recurse
            // while cold hydration still owns messagesLoaded=false. Dequeue only
            // after fsync so the rejected row cannot return on another restart.
            sessionOperationContext.owner.enqueuePersist(managed);
            void sessionOperationContext.owner.flushSession(managed.id).then(resumeQueue, (error: unknown) => {
                sessionLog.warn('Failed to persist durable runtime recovery during restore', {
                    sessionId: managed.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
        else
            setImmediate(resumeQueue);
    }
    else if (durableRuntimeStateChanged) {
        sessionOperationContext.owner.enqueuePersist(managed);
        void sessionOperationContext.owner.flushSession(managed.id).then(() => {
            if (recoveredConsumedAgentDeliveryNeedsContinuation || recoveredProviderDispatchNeedsContinuation) {
                sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
            }
        }, (error: unknown) => {
            sessionLog.warn('Failed to persist durable runtime recovery during restore', {
                sessionId: managed.id,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
}


