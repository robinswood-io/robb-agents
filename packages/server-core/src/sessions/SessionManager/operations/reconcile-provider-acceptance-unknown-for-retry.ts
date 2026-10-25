import type { SessionOperationContext } from '../operation-context.ts';
import { exactProviderDispatchAcceptanceUnknown, cancelSourceActivationPending } from '../policy.ts';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { hasObjectiveContinuationProvenance } from '../../turn-recovery';
import type { ManagedSession } from '../managed-session.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { getPendingUserInputResponse as sessionOpGetPendingUserInputResponse } from './user-input-recovery.ts';
import { untrackSyntheticAutomaticMessage as sessionOpUntrackSyntheticAutomaticMessage, reconcileLiveProviderDispatchUncertainty as sessionOpReconcileLiveProviderDispatchUncertainty } from './reconcile-live-provider-dispatch-uncertainty.ts';

/** Publish the verified receipt on the existing final; no extra message or turn. */
function sessionOpApplyValidatedNativeOutcome(sessionOperationContext: SessionOperationContext, managed: ManagedSession, finalMessage: Message, declaration: NonNullable<Message['objectiveOutcome']>): void {
    finalMessage.objectiveOutcome = declaration;
    sessionOperationContext.owner["sendEvent"]({
        type: 'text_complete', sessionId: managed.id, text: finalMessage.content,
        isIntermediate: finalMessage.isIntermediate, turnId: finalMessage.turnId,
        parentToolUseId: finalMessage.parentToolUseId, timestamp: finalMessage.timestamp,
        messageId: finalMessage.id, routingMeta: finalMessage.routingMeta,
        objectiveOutcome: declaration, objectiveOutcomeError: null,
    }, managed.workspace.id);
}

/** Remove a recovery from cold automatic admission while retaining its exact
 * counters and authority for a later explicit Retry of the public anchor. */
function sessionOpMovePendingRecoveryToExplicitRetrySnapshot(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): boolean {
    const objective = managed.activeObjective;
    if (!objective || managed.pendingTurnRecovery !== pending
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return false;
    objective.interruptedTurnRecovery = {
        objectiveId: objective.objectiveId ?? objective.userMessageId,
        userMessageId: objective.lastUserMessageId ?? objective.userMessageId,
        recovery: structuredClone(pending),
    };
    managed.pendingTurnRecovery = undefined;
    return true;
}

function sessionOpClearPendingTurnRecovery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, preserveValidationStop = false): void {
    if (preserveValidationStop && managed.activeObjective
        && managed.activeObjective.terminalState !== 'complete_verified' && sessionOpHasValidationExhaustionMarker(sessionOperationContext, managed)) {
        if (!managed.pendingTurnRecovery
            || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, managed.pendingTurnRecovery)) {
            managed.activeObjective.interruptedTurnRecovery = undefined;
            managed.pendingTurnRecovery = undefined;
            sessionOpReleaseSettledMissionRecoveryOwnership(sessionOperationContext, managed);
            return;
        }
        managed.pendingTurnRecovery!.validationExhausted = true;
        managed.activeObjective.terminalState = 'exhausted';
        // Stop is newer authority than an answer whose provider turn was already
        // dequeued. Preserve the prospective Retry reserve, but remove this
        // consumed hidden row from automatic restart admission.
        const pending = managed.pendingTurnRecovery;
        const response = sessionOpGetPendingUserInputResponse(sessionOperationContext, managed, true);
        const responseRows = response?.responseMessageId
            ? managed.messages.filter(message => message.id === response.responseMessageId)
            : [];
        const exactConsumedResponse = responseRows.length === 1
            && responseRows[0]!.isQueued !== true
            && !managed.messageQueue.some(item => item.messageId === response!.responseMessageId);
        if (exactConsumedResponse
            && !sessionOpMovePendingRecoveryToExplicitRetrySnapshot(sessionOperationContext, managed, pending)) {
            // Never leave an unauthenticated pending marker behind merely because
            // a future refactor changes provenance between the two checks above.
            managed.activeObjective.interruptedTurnRecovery = undefined;
            managed.pendingTurnRecovery = undefined;
        }
        sessionOpReleaseSettledMissionRecoveryOwnership(sessionOperationContext, managed);
        return;
    }
    if (preserveValidationStop && managed.activeObjective && managed.pendingTurnRecovery) {
        // Preserve known counters without leaving a restart/admission marker.
        // The snapshot belongs to this objective and its latest accepted anchor;
        // a later explicit Retry must authenticate both before reusing it.
        if (!sessionOpMovePendingRecoveryToExplicitRetrySnapshot(sessionOperationContext, managed, managed.pendingTurnRecovery)) {
            managed.activeObjective.interruptedTurnRecovery = undefined;
            managed.pendingTurnRecovery = undefined;
        }
    }
    else if (!preserveValidationStop && managed.activeObjective) {
        managed.activeObjective.interruptedTurnRecovery = undefined;
        managed.pendingTurnRecovery = undefined;
    }
    else {
        managed.pendingTurnRecovery = undefined;
    }
    sessionOpReleaseSettledMissionRecoveryOwnership(sessionOperationContext, managed);
}

function sessionOpReleaseSettledMissionRecoveryOwnership(sessionOperationContext: SessionOperationContext, managed: ManagedSession): void {
    if (managed.pendingTurnRecovery)
        return;
    sessionOperationContext.state.missionPendingTurnRecoveryClaims.delete(managed.id);
    sessionOperationContext.state.missionRuntimeOwnedRestoredRecoverySessionIds.delete(managed.id);
}

/** Move an exhausted validated continuation out of the startup replay slot
 * while retaining its exact budget and remaining work for an authenticated
 * user Retry. */
function sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const objective = managed.activeObjective;
    const pending = managed.pendingTurnRecovery;
    if (!objective || !pending?.exhaustedAt || !hasObjectiveContinuationProvenance(pending)
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return false;
    objective.terminalState = 'exhausted';
    objective.interruptedTurnRecovery = {
        objectiveId: objective.objectiveId ?? objective.userMessageId,
        userMessageId: objective.lastUserMessageId ?? objective.userMessageId,
        recovery: structuredClone(pending),
    };
    managed.pendingTurnRecovery = undefined;
    return true;
}

function sessionOpHasPreservedInterruptedObjectiveContinuation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const stopped = managed.activeObjective?.interruptedTurnRecovery?.recovery;
    return sessionOpHasBoundInterruptedTurnRecovery(sessionOperationContext, managed)
        && managed.activeObjective?.terminalState === 'exhausted'
        && !!stopped?.exhaustedAt && hasObjectiveContinuationProvenance(stopped);
}

function sessionOpHasBoundInterruptedTurnRecovery(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const objective = managed.activeObjective;
    const stopped = objective?.interruptedTurnRecovery;
    return !managed.pendingTurnRecovery && !!objective && !!stopped
        && stopped.objectiveId === (objective.objectiveId ?? objective.userMessageId)
        && stopped.userMessageId === (objective.lastUserMessageId ?? objective.userMessageId)
        && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, stopped.recovery);
}

function sessionOpGetInterruptedTurnRecovery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, userMessageId: string): PendingTurnRecovery | undefined {
    const objective = managed.activeObjective;
    const stopped = objective?.interruptedTurnRecovery;
    return stopped && stopped.objectiveId === (objective.objectiveId ?? objective.userMessageId)
        && stopped.userMessageId === userMessageId
        && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, stopped.recovery) ? stopped.recovery : undefined;
}

/** Explicit Retry may retire an ambiguous/corrupt set, but it may never pick
 * one candidate to replay. Preserve every receipt as an inert tombstone and
 * durably remove all FIFO authority before the fresh generic Retry starts. */
async function sessionOpRetireAmbiguousProviderDispatchesForRetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, messages: Message[], cancellationEpoch: number): Promise<'turn'> {
    if (!messages.length || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
        || managed.stopRequested || managed.isProcessing) {
        throw new Error('Retry was cancelled before ambiguous provider reconciliation');
    }
    const previousMessages = structuredClone(managed.messages);
    const previousQueue = structuredClone(managed.messageQueue);
    const previousRecovery = managed.pendingTurnRecovery
        ? structuredClone(managed.pendingTurnRecovery) : undefined;
    const previousAutoRetryPending = managed.autoRetryPending
        ? structuredClone(managed.autoRetryPending) : undefined;
    const retiredAt = Date.now();
    try {
        for (const message of messages) {
            const marker = message.providerDispatch;
            if (!marker || (marker.state !== 'acceptance-unknown'
                && marker.state !== 'accepted' && marker.state !== 'retired-accepted'))
                continue;
            const tombstone: NonNullable<Message['providerDispatch']> = {
                ...marker,
                state: 'retired-uncertain',
                acceptedAt: undefined,
                retiredAt,
                retirementReason: 'explicit-retry-reconciliation',
            };
            // Keep the uncertain-effect audit receipt, but never on the exact
            // provider envelope. A stale SDK recovery reconstructs user history;
            // leaving a tombstoned hidden prompt in that history could inject the
            // possibly-consumed payload again even though admission ignores the
            // tombstone state.
            delete message.providerDispatch;
            managed.messages.push({
                id: generateMessageId(), role: 'info', hidden: true,
                content: 'Provider dispatch receipt retired by explicit Retry without replay.',
                timestamp: retiredAt, providerDispatch: tombstone,
            });
            message.isQueued = false;
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== message.id);
            if (message.agentDelivery) {
                message.agentDelivery.status = 'processed';
                message.agentDelivery.providerDispatchUncertainAt ??= marker.acceptedAt ?? marker.markedAt;
            }
            const dispatch = managed.pendingTurnRecovery?.recoveryDispatch;
            if (dispatch?.id === message.id) {
                managed.pendingTurnRecovery = {
                    ...managed.pendingTurnRecovery!,
                    recoveryDispatch: undefined,
                };
            }
            if (message.internalOrigin?.kind === 'source-activation') {
                const sourcePending = managed.autoRetryPending;
                if (sourcePending && sourcePending.sourceActivationId === message.internalOrigin.sourceActivationId) {
                    sourcePending.providerStarted = true;
                }
                cancelSourceActivationPending(managed);
            }
            if (message.hidden && !message.agentDelivery
                && message.internalOrigin?.kind !== 'source-activation'
                && message.internalOrigin?.kind !== 'user-input') {
                sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext, managed, message);
                const messageIndex = managed.messages.indexOf(message);
                if (messageIndex >= 0)
                    managed.messages.splice(messageIndex, 1);
            }
        }
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('Ambiguous provider reconciliation could not be queued for durable storage');
        }
        await sessionOperationContext.owner.flushSessionDurably(managed.id);
        if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
            || managed.stopRequested) {
            throw new Error('Retry was cancelled during ambiguous provider reconciliation');
        }
        return 'turn';
    }
    catch (error) {
        managed.messages = previousMessages;
        managed.messageQueue = previousQueue;
        managed.pendingTurnRecovery = previousRecovery;
        managed.autoRetryPending = previousAutoRetryPending;
        if (sessionOperationContext.owner["persistSession"](managed)) {
            try {
                await sessionOperationContext.owner.flushSessionDurably(managed.id);
            }
            catch { /* restored in-memory barriers remain fail-closed */ }
        }
        throw error;
    }
}

/** Reconcile one crash-safe provider uncertainty only inside explicit Retry. */
async function sessionOpReconcileProviderAcceptanceUnknownForRetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, cancellationEpoch: number, assertStillUnblocked?: () => void): Promise<'turn' | undefined> {
    const objective = managed.activeObjective;
    const currentObjectiveId = objective?.objectiveId ?? objective?.userMessageId;
    const unknown = managed.messages.filter(message => (message.role === 'user'
        && (message.providerDispatch?.state === 'acceptance-unknown'
            || message.providerDispatch?.state === 'accepted'
            || (message.providerDispatch?.state === 'retired-accepted'
                && message.providerDispatch.objectiveId === currentObjectiveId
                && message.providerDispatch.objectiveUserMessageId === objective?.userMessageId))));
    if (!unknown.length)
        return undefined;
    if (unknown.length !== 1 || !exactProviderDispatchAcceptanceUnknown(unknown[0]!)) {
        return sessionOpRetireAmbiguousProviderDispatchesForRetry(sessionOperationContext, managed, unknown, cancellationEpoch);
    }
    const message = unknown[0]!;
    const marker = message.providerDispatch!;
    if (!objective || marker.objectiveId !== currentObjectiveId
        || marker.objectiveUserMessageId !== objective.userMessageId) {
        throw new Error('Provider acceptance belongs to a different objective and requires manual reconciliation');
    }
    if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
        || managed.stopRequested || managed.isProcessing) {
        throw new Error('Retry was cancelled before provider acceptance reconciliation');
    }
    const previousMessages = structuredClone(managed.messages);
    const previousQueue = structuredClone(managed.messageQueue);
    const previousRecovery = managed.pendingTurnRecovery
        ? structuredClone(managed.pendingTurnRecovery) : undefined;
    const previousAutoRetryPending = managed.autoRetryPending
        ? { ...managed.autoRetryPending } : undefined;
    delete message.providerDispatch;
    const result = 'turn' as const;
    if (message.agentDelivery) {
        // The child result may already have reached the provider. Explicit Retry
        // reconciles the parent objective from current state; it never redelivers
        // this exact durable receipt and risks duplicating a mutation.
        message.agentDelivery.status = 'processed';
        message.agentDelivery.providerDispatchUncertainAt ??= marker.acceptedAt ?? marker.markedAt;
        message.isQueued = false;
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== message.id);
    }
    else if (message.hidden) {
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== message.id);
        message.isQueued = false;
        if (message.internalOrigin?.kind !== 'user-input') {
            sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext, managed, message);
            managed.messages.splice(managed.messages.indexOf(message), 1);
        }
        const dispatch = managed.pendingTurnRecovery?.recoveryDispatch;
        if (dispatch?.id === message.id) {
            // This exact provider prompt may already have been consumed. Returning
            // its durable dispatch to `allocated` would let cold startup recreate
            // and replay it after a crash between this fsync and the new generic
            // Retry allocation. Consume the identity now; Retry allocates a fresh
            // inspection continuation only after this transaction commits.
            managed.pendingTurnRecovery = {
                ...managed.pendingTurnRecovery!,
                recoveryDispatch: undefined,
            };
        }
        if (message.internalOrigin?.kind === 'source-activation') {
            cancelSourceActivationPending(managed);
        }
    }
    try {
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('Provider acceptance reconciliation could not be queued for durable storage');
        }
        await sessionOperationContext.owner.flushSessionDurably(managed.id);
        assertStillUnblocked?.();
        if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
            || managed.stopRequested) {
            throw new Error('Retry was cancelled during provider acceptance reconciliation');
        }
    }
    catch (error) {
        managed.messages = previousMessages;
        managed.messageQueue = previousQueue;
        managed.pendingTurnRecovery = previousRecovery;
        managed.autoRetryPending = previousAutoRetryPending;
        if (sessionOperationContext.owner["persistSession"](managed)) {
            try {
                await sessionOperationContext.owner.flushSessionDurably(managed.id);
            }
            catch { /* the restored in-memory barrier remains fail-closed */ }
        }
        throw error;
    }
    if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
        || managed.stopRequested) {
        throw new Error('Retry was cancelled after provider acceptance reconciliation');
    }
    return result;
}

/** A validation stop retains its diagnostic and budget for an explicit retry. */
function sessionOpHasExhaustedValidation(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    return managed.activeObjective?.terminalState === 'exhausted' && sessionOpHasValidationExhaustionMarker(sessionOperationContext, managed);
}

function sessionOpHasValidationExhaustionMarker(sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    const pending = managed.pendingTurnRecovery;
    return !!pending?.exhaustedAt && (pending.validationExhausted === true
        || pending.budgetHistoryUnavailable === true
        || (pending.lastCause === 'tool_checkpoint' && !hasObjectiveContinuationProvenance(pending))
        || pending.lastCause === 'objective_incomplete' || pending.lastCause === 'evidence_gate');
}

function sessionOpRunLiveProviderDispatchReconciliation(sessionOperationContext: SessionOperationContext, managed: ManagedSession, message: Message, cancellationEpoch: number): Promise<boolean> {
    const existing = sessionOperationContext.state.providerLiveReconciliationTransactions.get(managed.id);
    if (existing)
        return existing;
    let transaction!: Promise<boolean>;
    transaction = (async () => {
        try {
            return await sessionOpReconcileLiveProviderDispatchUncertainty(sessionOperationContext, managed, message, cancellationEpoch);
        }
        finally {
            if (sessionOperationContext.state.providerLiveReconciliationTransactions.get(managed.id) === transaction) {
                sessionOperationContext.state.providerLiveReconciliationTransactions.delete(managed.id);
            }
        }
    })();
    sessionOperationContext.state.providerLiveReconciliationTransactions.set(managed.id, transaction);
    return transaction;
}

function sessionOpTrackSyntheticAutomaticMessage(sessionOperationContext: SessionOperationContext, managed: ManagedSession, message: Message): void {
    const tracked = sessionOperationContext.state.syntheticAutomaticMessagesInFlight.get(managed) ?? new Set<Message>();
    tracked.add(message);
    sessionOperationContext.state.syntheticAutomaticMessagesInFlight.set(managed, tracked);
}

export { sessionOpApplyValidatedNativeOutcome as applyValidatedNativeOutcome };
export { sessionOpMovePendingRecoveryToExplicitRetrySnapshot as movePendingRecoveryToExplicitRetrySnapshot };
export { sessionOpClearPendingTurnRecovery as clearPendingTurnRecovery };
export { sessionOpReleaseSettledMissionRecoveryOwnership as releaseSettledMissionRecoveryOwnership };
export { sessionOpPreserveInterruptedObjectiveContinuation as preserveInterruptedObjectiveContinuation };
export { sessionOpHasPreservedInterruptedObjectiveContinuation as hasPreservedInterruptedObjectiveContinuation };
export { sessionOpHasBoundInterruptedTurnRecovery as hasBoundInterruptedTurnRecovery };
export { sessionOpGetInterruptedTurnRecovery as getInterruptedTurnRecovery };
export { sessionOpRetireAmbiguousProviderDispatchesForRetry as retireAmbiguousProviderDispatchesForRetry };
export { sessionOpReconcileProviderAcceptanceUnknownForRetry as reconcileProviderAcceptanceUnknownForRetry };
export { sessionOpHasExhaustedValidation as hasExhaustedValidation };
export { sessionOpHasValidationExhaustionMarker as hasValidationExhaustionMarker };
export { sessionOpRunLiveProviderDispatchReconciliation as runLiveProviderDispatchReconciliation };
export { sessionOpTrackSyntheticAutomaticMessage as trackSyntheticAutomaticMessage };
