import type { PendingTurnRecovery } from '../../../../../shared/src/sessions/types/turn-recovery.ts';
import type { ProviderDispatchWriteAhead } from '../../../../../core/src/types/message/message-store.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import type { SessionOperationContext } from '../operation-context.ts';
import { exactProviderDispatchAcceptanceUnknown } from '../policy.ts';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import type { ManagedSession } from '../managed-session.ts';
import { pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';

/** Replace one exact live provider uncertainty with non-replay work. The
 * original prompt is retired in the same durable transition that either
 * allocates a generic inspection continuation or releases a newer visible
 * human turn already committed behind it. */
async function sessionOpReconcileLiveProviderDispatchUncertainty(sessionOperationContext: SessionOperationContext, managed: ManagedSession, message: Message, cancellationEpoch: number): Promise<boolean> {
    const marker = message.providerDispatch;
    const objective = managed.activeObjective;
    const objectiveId = objective?.objectiveId ?? objective?.userMessageId;
    if (!marker || !exactProviderDispatchAcceptanceUnknown(message)
        || marker.userStoppedAt !== undefined
        || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
        || managed.stopRequested)
        return false;
    const currentBound = !!objective
        && marker.objectiveId === objectiveId
        && marker.objectiveUserMessageId === objective.userMessageId
        && !!managed.pendingTurnRecovery
        && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, managed.pendingTurnRecovery);
    const messageIndex = managed.messages.indexOf(message);
    const laterCurrentHuman = objective && managed.messages.find((candidate, index) => (index > messageIndex
        && candidate.id === objective.userMessageId
        && candidate.role === 'user' && !candidate.hidden && !candidate.isPending
        && !candidate.internalOrigin && !candidate.agentDelivery));
    const laterVisibleHuman = managed.messages.find((candidate, index) => (index > messageIndex
        && candidate.role === 'user' && !candidate.hidden && !candidate.isPending
        && !candidate.internalOrigin && !candidate.agentDelivery));
    if (!currentBound && !laterCurrentHuman)
        return false;
    const previousMessages = structuredClone(managed.messages);
    const previousQueue = structuredClone(managed.messageQueue);
    const previousRecovery = managed.pendingTurnRecovery
        ? structuredClone(managed.pendingTurnRecovery) : undefined;
    const previousAutoRetryPending = managed.autoRetryPending
        ? structuredClone(managed.autoRetryPending) : undefined;
    try {
        if (laterVisibleHuman?.isQueued === true
            && managed.messageQueue.some(item => item.messageId === laterVisibleHuman.id)) {
            const retiredAt = Date.now();
            const tombstone: NonNullable<Message['providerDispatch']> = omitUndefined<ProviderDispatchWriteAhead>({
                ...marker,
                state: 'retired-uncertain',
                acceptedAt: undefined,
                retiredAt,
                retirementReason: 'superseded-by-new-human-objective',
            });
            delete message.providerDispatch;
            managed.messages.push({
                id: generateMessageId(), role: 'info', hidden: true,
                content: 'Provider dispatch receipt retired before a newer durable human turn.',
                timestamp: retiredAt, providerDispatch: tombstone,
            });
            message.isQueued = false;
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== message.id);
            // The visible FIFO row is already the durable successor. Do not mint a
            // competing synthetic recovery or carry the old turn's continuation
            // checkpoint into that newer human instruction.
        }
        else if (laterCurrentHuman && !currentBound) {
            const tombstone: NonNullable<Message['providerDispatch']> = omitUndefined<ProviderDispatchWriteAhead>({
                ...marker,
                state: 'retired-uncertain',
                acceptedAt: undefined,
                retiredAt: Date.now(),
                retirementReason: 'superseded-by-new-human-objective',
            });
            // Keep the audit receipt on a separate inert row. The original closure
            // still owns `message` and may run its exact-WAL cleanup while unwinding;
            // separating the tombstone prevents that cleanup from erasing the
            // durable supersession proof.
            delete message.providerDispatch;
            managed.messages.push({
                id: generateMessageId(), role: 'info', hidden: true,
                content: 'Provider dispatch receipt retired after a newer human objective superseded it.',
                timestamp: tombstone.retiredAt!, providerDispatch: tombstone,
            });
            message.isQueued = false;
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== message.id);
            const pending = managed.pendingTurnRecovery;
            if (!pending || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending)) {
                throw new Error('The superseding human objective has no exact recovery binding');
            }
            managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
                ...pending,
                lastCause: 'app_restart',
                continuationRequired: true,
                recoveryDispatch: undefined,
            });
            const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'runtime_error', undefined, undefined, 'automatic');
            if (!queued) {
                throw new Error('The superseding human objective could not allocate a generic continuation');
            }
        }
        else {
            const retiredAt = Date.now();
            const tombstone: NonNullable<Message['providerDispatch']> = {
                ...marker,
                state: 'retired-uncertain',
                retiredAt,
                retirementReason: laterVisibleHuman
                    ? 'superseded-by-new-human-objective'
                    : 'live-nonreplay-reconciliation',
            };
            delete message.providerDispatch;
            managed.messages.push({
                id: generateMessageId(), role: 'info', hidden: true,
                content: 'Provider dispatch receipt retired after live non-replay reconciliation.',
                timestamp: retiredAt, providerDispatch: tombstone,
            });
            message.isQueued = false;
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== message.id);
            if (message.agentDelivery) {
                message.agentDelivery.status = 'processed';
                message.agentDelivery.providerDispatchUncertainAt ??= marker.acceptedAt ?? marker.markedAt;
            }
            if (message.internalOrigin?.kind === 'source-activation'
                && managed.autoRetryPending?.sourceActivationId === message.internalOrigin.sourceActivationId) {
                managed.autoRetryPending!.providerStarted = true;
            }
            if (message.hidden && !message.agentDelivery
                && message.internalOrigin?.kind !== 'source-activation'
                && message.internalOrigin?.kind !== 'user-input') {
                sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext, managed, message);
                managed.messages.splice(messageIndex, 1);
            }
            managed.pendingTurnRecovery = omitUndefined<PendingTurnRecovery>({
                ...managed.pendingTurnRecovery!,
                lastCause: 'app_restart',
                continuationRequired: true,
                recoveryDispatch: undefined,
            });
            const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'runtime_error', undefined, undefined, 'automatic');
            if (!queued)
                throw new Error('The provider uncertainty could not allocate a generic continuation');
        }
        if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
            || managed.stopRequested) {
            throw new Error('Provider uncertainty reconciliation was cancelled');
        }
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('Provider uncertainty reconciliation could not be queued for durable storage');
        }
        await sessionOperationContext.owner.flushSessionDurably(managed.id);
        if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpoch
            || managed.stopRequested) {
            throw new Error('Provider uncertainty reconciliation was cancelled after persistence');
        }
        return true;
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
            catch { /* restored in-memory WAL remains the admission barrier */ }
        }
        throw error;
    }
}

function sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext: SessionOperationContext, managed: ManagedSession, message: Message | undefined): void {
    if (!message)
        return;
    const tracked = sessionOperationContext.state.syntheticAutomaticMessagesInFlight.get(managed);
    if (!tracked)
        return;
    tracked.delete(message);
    if (!tracked.size)
        sessionOperationContext.state.syntheticAutomaticMessagesInFlight.delete(managed);
}

/**
 * Return the first durable provider write-ahead fence. Even a malformed or
 * stale identity remains a fail-closed replay barrier; only an exact live
 * callback or an explicit Retry may reconcile it.
 */
function sessionOpProviderDispatchAcceptanceUnknown(_sessionOperationContext: SessionOperationContext, managed: ManagedSession): Message | undefined {
    return managed.messages.find(message => (message.role === 'user'
        && message.providerDispatch?.state === 'acceptance-unknown'));
}

function sessionOpProviderDispatchAdmissionBarrier(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Message | undefined {
    const unknown = sessionOpProviderDispatchAcceptanceUnknown(sessionOperationContext, managed);
    if (unknown)
        return unknown;
    const objective = managed.activeObjective;
    const objectiveId = objective?.objectiveId ?? objective?.userMessageId;
    return managed.messages.find(message => (message.role === 'user' && message.providerDispatch?.state === 'accepted'
        && (!exactProviderDispatchAcceptanceUnknown(message)
            || (message.providerDispatch.objectiveId === objectiveId
                && message.providerDispatch.objectiveUserMessageId === objective?.userMessageId))));
}

function sessionOpRemoveInFlightSyntheticAutomaticMessages(sessionOperationContext: SessionOperationContext, managed: ManagedSession, retainQueued = false): number {
    const tracked = sessionOperationContext.state.syntheticAutomaticMessagesInFlight.get(managed);
    if (!tracked?.size)
        return 0;
    let removed = 0;
    const removedIds = new Set<string>();
    const retained = new Set<Message>();
    for (const message of tracked) {
        if (message.role !== 'user' || !message.hidden)
            continue;
        // Once the write-ahead is durable the provider may already own this
        // exact prompt. Stop may hide it from admission, but must not erase the
        // only crash-safe evidence preventing an automatic replay.
        if (message.providerDispatch) {
            retained.add(message);
            continue;
        }
        if (retainQueued && message.isQueued) {
            retained.add(message);
            continue;
        }
        const index = managed.messages.indexOf(message);
        if (index >= 0) {
            managed.messages.splice(index, 1);
            removedIds.add(message.id);
            removed++;
        }
    }
    const startedDispatch = managed.pendingTurnRecovery?.recoveryDispatch;
    if (startedDispatch?.phase === 'started' && removedIds.has(startedDispatch.id)) {
        const allocatedDispatch = { ...startedDispatch, phase: 'allocated' as const };
        delete allocatedDispatch.startedAt;
        managed.pendingTurnRecovery = {
            ...managed.pendingTurnRecovery!,
            recoveryDispatch: allocatedDispatch,
        };
    }
    if (retained.size)
        sessionOperationContext.state.syntheticAutomaticMessagesInFlight.set(managed, retained);
    else
        sessionOperationContext.state.syntheticAutomaticMessagesInFlight.delete(managed);
    return removed;
}

export { sessionOpReconcileLiveProviderDispatchUncertainty as reconcileLiveProviderDispatchUncertainty };
export { sessionOpUntrackSyntheticAutomaticMessage as untrackSyntheticAutomaticMessage };
export { sessionOpProviderDispatchAcceptanceUnknown as providerDispatchAcceptanceUnknown };
export { sessionOpProviderDispatchAdmissionBarrier as providerDispatchAdmissionBarrier };
export { sessionOpRemoveInFlightSyntheticAutomaticMessages as removeInFlightSyntheticAutomaticMessages };
