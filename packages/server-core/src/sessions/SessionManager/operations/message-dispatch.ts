import { setOptional } from '@craft-agent/shared/utils/json';
import { scheduleQueuedMessageDispatch } from './queued-message-scheduling.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { hasUnscheduledQueuedUserInput, queuedDirectHumanContinuationIndex, queuedDirectHumanContinuationIndexForId, validAllocatedRecoveryDispatch, cleanSetupRetryDelayMs, isClosedColdResumeStatus } from '../policy.ts';
import { sessionLog } from '../runtime-platform.ts';
import { CLEAN_RETRY_CONDITIONAL_SETUP_FAILURE_CLASSES, CLEAN_RETRY_NEVER_SETUP_FAILURE_CLASSES, CLEAN_RETRY_SETUP_FAILURE_CLASSES, MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES, MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES } from '../user-input-authority.ts';
import { providerDispatchAdmissionBarrier as sessionOpProviderDispatchAdmissionBarrier } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { dropDeferredSourceActivations as sessionOpDropDeferredSourceActivations, hasPendingDecision as sessionOpHasPendingDecision, hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { isExactQueuedCleanRecoveryDispatch as sessionOpIsExactQueuedCleanRecoveryDispatch, fenceCleanSetupPersistence as sessionOpFenceCleanSetupPersistence, isCleanSetupPersistenceFenced as sessionOpIsCleanSetupPersistenceFenced } from './start-recovery-dispatch.ts';
import { resumeAllocatedRecoveryDispatch as sessionOpResumeAllocatedRecoveryDispatch } from './dispatch-allocated-clean-retry.ts';
import { liveDirectHumanContinuationIndex as sessionOpLiveDirectHumanContinuationIndex, cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries } from './create-autonomous-context-limit-handoff.ts';
import { hasAnyRetainedStoppedAgentDelivery as sessionOpHasAnyRetainedStoppedAgentDelivery, hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, exactQueuedAgentDeliveryReceipt as sessionOpExactQueuedAgentDeliveryReceipt } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { isAutonomousMessage as sessionOpIsAutonomousMessage } from './is-current-delegated-descendant.ts';
import { cancelPendingAuthForHumanContinuation as sessionOpCancelPendingAuthForHumanContinuation, downgradeColdAuthResumePermission as sessionOpDowngradeColdAuthResumePermission } from './downgrade-cold-auth-resume-permission.ts';
import { isStaleTypedUpwardAgentDelivery as sessionOpIsStaleTypedUpwardAgentDelivery, quarantineStaleTypedUpwardAgentDelivery as sessionOpQuarantineStaleTypedUpwardAgentDelivery, releasableUpwardAgentDeliverySenderId as sessionOpReleasableUpwardAgentDeliverySenderId } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { queuedHumanIndex as sessionOpQueuedHumanIndex } from './exact-user-input-response.ts';

function sessionOpProcessNextQueuedMessage(sessionOperationContext: SessionOperationContext, sessionId: string): void {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed || sessionOperationContext.state.directHumanSupersessionsInFlight.has(managed))
        return;
    if (sessionOperationContext.state.strongCancellationStops.get(sessionId)?.managed === managed)
        return;
    // No FIFO row may implicitly reconcile a crash between provider write and
    // acknowledgement. Explicit Retry owns the only durable reconciliation.
    if (sessionOpProviderDispatchAdmissionBarrier(sessionOperationContext, managed)
        || sessionOperationContext.state.coldProviderReconciliationsInFlight.has(sessionId)
        || sessionOperationContext.state.providerStopTransitionsInFlight.has(sessionId))
        return;
    const isColdAuthHumanContinuation = sessionOperationContext.state.coldAuthHumanContinuationSessions.has(managed);
    const queuedHumanSupersedesSourceActivation = queuedDirectHumanContinuationIndex(managed) >= 0;
    if (sessionOpDropDeferredSourceActivations(sessionOperationContext, managed, queuedHumanSupersedesSourceActivation)) {
        sessionOperationContext.owner["persistSession"](managed);
        void sessionOperationContext.owner.flushSession(sessionId).catch((error: unknown) => {
            sessionLog.warn('Failed to flush stale source-activation cancellation', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }
    const canAdvanceQueue = !sessionOperationContext.state.shuttingDown && !managed.stopRequested && !managed.isProcessing;
    const cleanRetryDispatch = managed.pendingTurnRecovery
        ? validAllocatedRecoveryDispatch(managed.pendingTurnRecovery)
        : undefined;
    const cleanRecoveryCandidates = canAdvanceQueue && cleanRetryDispatch?.cleanContinuationId
        && managed.pendingTurnRecovery
        ? managed.messageQueue.filter(item => (item.options?.automaticRecovery?.dispatchId === cleanRetryDispatch.id
            || item.messageId === cleanRetryDispatch.id))
        : [];
    const exactCleanRecoveryRows = cleanRetryDispatch && managed.pendingTurnRecovery
        ? cleanRecoveryCandidates.filter(item => sessionOpIsExactQueuedCleanRecoveryDispatch(sessionOperationContext, managed, managed.pendingTurnRecovery!, cleanRetryDispatch, item))
        : [];
    // Exactly one rebuilt envelope may represent a clean allocation. Any
    // collision — including an old-host generic row keyed only by messageId,
    // an attachment-bearing copy, or duplicate exact envelopes — is removed
    // durably before reconstructing one host-owned dispatch.
    const invalidCleanRecoveryRows = cleanRecoveryCandidates.length === 1
        && exactCleanRecoveryRows.length === 1
        ? []
        : cleanRecoveryCandidates;
    if (invalidCleanRecoveryRows.length && cleanRetryDispatch && managed.pendingTurnRecovery) {
        // Fail closed before dequeue/start. A stale row with the right dispatch
        // id is not a capability; remove only synthetic rows that cannot be a
        // human answer or agent receipt, then durably rebuild from the allocation.
        const invalidSet = new Set(invalidCleanRecoveryRows);
        managed.messageQueue = managed.messageQueue.filter(item => !invalidSet.has(item));
        let unsafeIdentityCollision = false;
        const inspectedMessageIds = new Set<string>();
        for (const item of invalidCleanRecoveryRows) {
            if (!item.messageId)
                continue;
            if (inspectedMessageIds.has(item.messageId))
                continue;
            inspectedMessageIds.add(item.messageId);
            const rows = managed.messages.filter(message => message.id === item.messageId);
            const row = rows[0];
            const removableSynthetic = rows.length === 1 && item.messageId === cleanRetryDispatch.id
                && !!row && row.role === 'user' && row.hidden === true && row.isQueued === true
                && !row.isPending && !row.agentDelivery
                && (row.internalOrigin === undefined || row.internalOrigin.kind === 'browser-fallback')
                && !managed.userInputRequests?.some(request => request.responseMessageId === row.id);
            if (removableSynthetic) {
                managed.messages.splice(managed.messages.indexOf(row), 1);
            }
            else {
                unsafeIdentityCollision = true;
                for (const candidate of rows)
                    candidate.isQueued = false;
            }
        }
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        sessionOperationContext.state.cleanRetrySetupPersistenceFences.set(sessionId, cleanRetryDispatch.id);
        if (unsafeIdentityCollision)
            sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, cleanRetryDispatch.id);
        const enqueued = sessionOperationContext.owner["persistSession"](managed);
        if (!enqueued) {
            sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, cleanRetryDispatch.id);
            return;
        }
        void sessionOperationContext.owner.flushSession(sessionId).then(() => {
            if (unsafeIdentityCollision || sessionOperationContext.state.sessions.get(sessionId) !== managed
                || managed.pendingTurnRecovery?.recoveryDispatch?.id !== cleanRetryDispatch.id)
                return;
            if (sessionOperationContext.state.cleanRetrySetupPersistenceFences.get(sessionId) === cleanRetryDispatch.id) {
                sessionOperationContext.state.cleanRetrySetupPersistenceFences.delete(sessionId);
            }
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }).catch((error: unknown) => {
            sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, cleanRetryDispatch.id);
            sessionLog.warn('Failed to persist stale clean-boundary FIFO quarantine', {
                sessionId,
                dispatchId: cleanRetryDispatch.id,
                error: error instanceof Error ? error.message : String(error),
            });
        });
        return;
    }
    const exactCleanRecoveryQueued = !!cleanRetryDispatch
        && cleanRecoveryCandidates.length === 1 && exactCleanRecoveryRows.length === 1;
    const setupPersistenceFenced = sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, cleanRetryDispatch);
    if (canAdvanceQueue && setupPersistenceFenced
        && queuedDirectHumanContinuationIndex(managed) < 0) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        return;
    }
    const durableSetupDelayMs = cleanSetupRetryDelayMs(cleanRetryDispatch);
    if (canAdvanceQueue && !!cleanRetryDispatch?.cleanContinuationId
        && queuedDirectHumanContinuationIndex(managed) < 0
        && (sessionOperationContext.state.deferredAutomaticRetryTimers.has(sessionId) || durableSetupDelayMs > 0)) {
        sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
        if (!sessionOperationContext.state.deferredAutomaticRetryTimers.has(sessionId)) {
            sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](sessionId, durableSetupDelayMs);
        }
        return;
    }
    const cleanBoundaryNeedsReconstruction = !!cleanRetryDispatch?.cleanContinuationId
        && (cleanRetryDispatch.origin === 'retry' || !exactCleanRecoveryQueued);
    if (canAdvanceQueue && cleanBoundaryNeedsReconstruction
        && managed.activeObjective?.terminalState === 'active'
        && !sessionOperationContext.owner["hasPendingUserInput"](managed) && !sessionOpHasPendingDecision(sessionOperationContext, managed)
        && queuedDirectHumanContinuationIndex(managed) < 0) {
        // Never let a generic FIFO row cross a pending clean provider seam. The
        // exact recovered Retry obtains a one-use private capability above and
        // every legitimate machine delivery remains queued behind it.
        if (!sessionOperationContext.state.deferredAutomaticRetryTimers.has(sessionId)
            && !sessionOperationContext.state.retryTurnsInFlight.has(sessionId)) {
            // The shared resume helper owns lineage/capacity admission before the
            // low-level provider seam. A failed claim leaves the candidate deferred.
            if (!sessionOpResumeAllocatedRecoveryDispatch(sessionOperationContext, managed, managed.pendingTurnRecovery!)) {
                sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
                sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
            }
        }
        return;
    }
    const liveDirectIndex = canAdvanceQueue ? sessionOpLiveDirectHumanContinuationIndex(sessionOperationContext, managed) : -1;
    // Cold FIFO state is evidence, not fresh authority. A configured-closed or
    // terminal session may be reopened only by the exact message accepted by a
    // live send in this process, never by an older persisted row.
    if (canAdvanceQueue && (isClosedColdResumeStatus(managed) || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
        || sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, managed))
        && liveDirectIndex < 0) {
        if (managed.messageQueue.length && managed.messageQueue.every(item => sessionOpIsAutonomousMessage(sessionOperationContext, item.options))
            && managed.pendingTurnRecovery) {
            sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
        }
        return;
    }
    let durableQueueChanged = false;
    if (canAdvanceQueue && queuedDirectHumanContinuationIndex(managed) >= 0
        && sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext, managed)) {
        durableQueueChanged = true;
    }
    if (canAdvanceQueue && queuedDirectHumanContinuationIndex(managed) === 0
        && sessionOpCancelPendingAuthForHumanContinuation(sessionOperationContext, managed)) {
        if (isColdAuthHumanContinuation)
            sessionOpDowngradeColdAuthResumePermission(sessionOperationContext, managed);
        sessionOperationContext.state.coldAuthHumanContinuationSessions.delete(managed);
        durableQueueChanged = true;
    }
    if (durableQueueChanged) {
        // sendMessage performs the synchronous durability fence before model
        // preparation. Queue a write now as well so a concurrent stop cannot
        // resurrect the obsolete auth handoff or its allow-all authority.
        sessionOperationContext.owner["persistSession"](managed);
    }
    if (sessionOperationContext.state.shuttingDown || managed.stopRequested || managed.isProcessing
        || hasUnscheduledQueuedUserInput(managed)
        || (sessionOperationContext.owner["hasPendingUserInput"](managed) && liveDirectIndex < 0) || sessionOpHasPendingDecision(sessionOperationContext, managed)
        || sessionOperationContext.state.queuedMessageDispatches.has(sessionId) || managed.messageQueue.length === 0)
        return;
    // A hydration callback may have been scheduled while the objective was
    // still active, then run after immutable ancestry terminalized it. Machine
    // rows remain durable Retry context; they must not re-enter admission.
    if (((sessionOpHasTerminalObjectiveState(sessionOperationContext, managed) && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
        || sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, managed)) && liveDirectIndex < 0) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        return;
    }
    // Revalidate synthetic authority at dequeue too: callers other than the
    // normal processing-stop path can drain a restored or deferred inbox.
    if (sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext, managed)) {
        sessionOperationContext.owner["persistSession"](managed);
        if (managed.messageQueue.length === 0) {
            const cancellationGeneration = managed.processingGeneration;
            void sessionOperationContext.owner.flushSession(sessionId).catch((error: unknown) => {
                sessionLog.warn('Failed to flush stale automatic recovery cancellation', {
                    sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }).finally(() => {
                if (!managed.isProcessing && managed.processingGeneration === cancellationGeneration) {
                    void sessionOperationContext.owner["onProcessingStopped"](sessionId, 'complete', cancellationGeneration);
                }
            });
            return;
        }
    }
    const currentLiveDirectIndex = sessionOpLiveDirectHumanContinuationIndex(sessionOperationContext, managed);
    let nextIndex = (isClosedColdResumeStatus(managed) || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
        || sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, managed))
        && currentLiveDirectIndex >= 0 ? currentLiveDirectIndex : 0;
    let selectedQueueItem = managed.messageQueue[nextIndex]!;
    if (sessionOpIsStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, selectedQueueItem)) {
        void sessionOpQuarantineStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, selectedQueueItem, undefined, nextIndex);
        return;
    }
    let selectedDeliveryReceipt = sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, selectedQueueItem);
    let selectedDeliverySetup = selectedDeliveryReceipt?.agentDelivery;
    const queuedHumanWhileDeliveryHeld = selectedDeliverySetup?.status === 'queued'
        && (selectedDeliverySetup.setupFailureCount !== undefined
            || Number.isFinite(selectedDeliverySetup.setupPersistenceFencedAt)
            || sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(sessionId) === selectedDeliverySetup.id)
        ? sessionOpQueuedHumanIndex(sessionOperationContext, managed)
        : -1;
    if (queuedHumanWhileDeliveryHeld >= 0 && queuedHumanWhileDeliveryHeld !== nextIndex) {
        nextIndex = queuedHumanWhileDeliveryHeld;
        selectedQueueItem = managed.messageQueue[nextIndex]!;
        selectedDeliveryReceipt = undefined;
        selectedDeliverySetup = undefined;
    }
    if (selectedDeliverySetup?.status === 'queued'
        && (Number.isFinite(selectedDeliverySetup.setupPersistenceFencedAt)
            || sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(sessionId) === selectedDeliverySetup.id)) {
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        sessionOperationContext.owner["sendEvent"]({
            type: 'typed_error', sessionId,
            error: {
                code: 'provider_error', title: 'Agent delivery state requires confirmation',
                message: 'The queued agent delivery has an unconfirmed persistence rollback. No provider will start; use Retry after storage is available.',
                actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
            },
        }, managed.workspace.id);
        return;
    }
    if (selectedDeliverySetup?.status === 'queued'
        && selectedDeliverySetup.setupFailureCount !== undefined) {
        const setupFailureLimit = selectedDeliverySetup.lastSetupFailureClass
            && CLEAN_RETRY_NEVER_SETUP_FAILURE_CLASSES.has(selectedDeliverySetup.lastSetupFailureClass)
            ? 1
            : selectedDeliverySetup.lastSetupFailureClass
                && CLEAN_RETRY_CONDITIONAL_SETUP_FAILURE_CLASSES.has(selectedDeliverySetup.lastSetupFailureClass)
                ? MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES
                : MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES;
        const malformedSetupState = !Number.isSafeInteger(selectedDeliverySetup.setupFailureCount)
            || selectedDeliverySetup.setupFailureCount <= 0
            || selectedDeliverySetup.setupFailureCount > MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES
            || !selectedDeliverySetup.lastSetupFailureClass
            || !CLEAN_RETRY_SETUP_FAILURE_CLASSES.has(selectedDeliverySetup.lastSetupFailureClass);
        const shouldBeBlocked = malformedSetupState
            || selectedDeliverySetup.setupFailureCount >= setupFailureLimit;
        if (shouldBeBlocked && !Number.isFinite(selectedDeliverySetup.setupRetryBlockedAt)) {
            selectedDeliverySetup.setupFailureCount = Math.min(MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES, Math.max(1, Number.isSafeInteger(selectedDeliverySetup.setupFailureCount)
                ? selectedDeliverySetup.setupFailureCount : setupFailureLimit));
            setOptional(selectedDeliverySetup, "lastSetupFailureClass", CLEAN_RETRY_SETUP_FAILURE_CLASSES.has(selectedDeliverySetup.lastSetupFailureClass ?? '') ? selectedDeliverySetup.lastSetupFailureClass : 'unknown');
            selectedDeliverySetup.setupRetryBlockedAt = Date.now();
            delete selectedDeliverySetup.setupRetryNotBefore;
            sessionOperationContext.owner["persistSession"](managed);
        }
        if (Number.isFinite(selectedDeliverySetup.setupRetryBlockedAt)) {
            sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            sessionOperationContext.owner["sendEvent"]({
                type: 'typed_error', sessionId,
                error: {
                    code: 'provider_error', title: 'Agent delivery setup paused',
                    message: `The queued agent delivery remains safe, but provider setup is paused (${selectedDeliverySetup.lastSetupFailureClass ?? 'unknown'}). Resolve the provider issue, then Retry.`,
                    actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                },
            }, managed.workspace.id);
            return;
        }
        const setupDelayMs = Math.max(0, (selectedDeliverySetup.setupRetryNotBefore ?? Date.now()) - Date.now());
        if (setupDelayMs > 0 || sessionOperationContext.state.deferredAutomaticRetryTimers.has(sessionId)) {
            sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
            if (!sessionOperationContext.state.deferredAutomaticRetryTimers.has(sessionId)) {
                sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](sessionId, setupDelayMs);
            }
            return;
        }
    }
    let actionableUpwardSenderId = sessionOpReleasableUpwardAgentDeliverySenderId(sessionOperationContext, managed, selectedQueueItem);
    const staleTypedUpwardDelivery = sessionOpIsStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, selectedQueueItem);
    let autonomous = sessionOpIsAutonomousMessage(sessionOperationContext, selectedQueueItem.options);
    if (autonomous && staleTypedUpwardDelivery) {
        void sessionOpQuarantineStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, selectedQueueItem, undefined, nextIndex);
        return;
    }
    if (autonomous && !sessionOperationContext.owner["claimAutomaticAdmission"](managed, actionableUpwardSenderId)) {
        // A held machine delivery cannot lend itself the authority of a later
        // human message. Admit that human record alone and retain the machine FIFO.
        nextIndex = sessionOpQueuedHumanIndex(sessionOperationContext, managed);
        if (nextIndex < 0)
            return;
        selectedQueueItem = managed.messageQueue[nextIndex]!;
        actionableUpwardSenderId = undefined;
        autonomous = false;
    }
    const dispatchToken = Symbol('queued-message-dispatch');
    sessionOperationContext.state.queuedMessageDispatches.set(sessionId, dispatchToken);
    const selectedDirectHumanId = selectedQueueItem.messageId
        && queuedDirectHumanContinuationIndexForId(managed, selectedQueueItem.messageId) === nextIndex
        ? selectedQueueItem.messageId : undefined;
    const next = managed.messageQueue.splice(nextIndex, 1)[0]!;
    const selectedLiveDirectId = currentLiveDirectIndex === nextIndex ? selectedDirectHumanId : undefined;
    const dispatchGeneration = managed.processingGeneration;
    const queuedAgentDelivery = next.messageId
        ? managed.messages.find(message => message.id === next.messageId)?.agentDelivery
        : undefined;
    if (next.messageId && next.options?.internalOrigin?.kind === 'agent-message'
        && queuedAgentDelivery?.status === 'queued'
        && queuedAgentDelivery.id === next.options.internalOrigin.deliveryId) {
        sessionOperationContext.state.queuedAgentDeliveryDispatches.set(next.messageId, {
            sessionId,
            deliveryId: queuedAgentDelivery.id,
            dispatchToken,
            claimed: false,
            claimDurable: false,
            providerStarted: false,
            dispatchSettled: false,
        });
    }
    sessionLog.info('replay queued', {
        sessionId,
        messageId: next.messageId,
        queueLengthAfterShift: managed.messageQueue.length,
    });
    // Process message (use setImmediate to allow current stack to clear)
    scheduleQueuedMessageDispatch(managed, sessionOperationContext, dispatchGeneration, sessionId, dispatchToken, next, nextIndex, selectedDirectHumanId, selectedLiveDirectId, actionableUpwardSenderId, autonomous);
}

export { sessionOpProcessNextQueuedMessage as processNextQueuedMessage };
