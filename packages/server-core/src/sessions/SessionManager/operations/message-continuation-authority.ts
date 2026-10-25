import { isExactQueuedSourceActivation, cancelSourceActivationPending } from '../policy.ts';
import { sessionLog } from '../runtime-platform.ts';
import { isSourceActivationOriginCurrent } from '../source-activation.ts';
import { revokePendingToolPermissionsForDirectContinuation as sessionOpRevokePendingToolPermissionsForDirectContinuation, dropDeferredSourceActivations as sessionOpDropDeferredSourceActivations } from './repair-legacy-synthetic-objective-authority.ts';
import type { MessageContinuationAuthorityInput } from './message-continuation-authority-input.ts';

// Cleanup is returned only for a refused continuation; accepted messages stay synchronous.
export function applyMessageContinuationAuthority(
    input: MessageContinuationAuthorityInput
): Promise<void> | undefined {
    const {
        directHumanContinuation,
        sessionOperationContext,
        managed,
        activeMessageState,
        authenticatedSourceActivation,
        existingMessageId,
        sourceActivationDispatchToken,
        sourceActivationCancellationEpochAtEntry,
        ownsQueuedDispatch,
        queuedItem,
        sessionId,
    } = input;
if (directHumanContinuation) {
        sessionOperationContext.state.objectiveAuthorityEpochs.set(managed, (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) + 1);
    }
    // Revoke outstanding provider permission capabilities synchronously before
    // redirecting the old turn or crossing any further await. Defer the full
    // durable handoff transition (questions/auth/recovery state) to the
    // serialized persistence fence below so a failed flush can still roll it
    // back without perturbing FIFO and stop-race invariants.
    if (directHumanContinuation)
        sessionOpRevokePendingToolPermissionsForDirectContinuation(sessionOperationContext, managed);
    if (directHumanContinuation) {
        // A newly accepted human instruction always wins over a delayed source
        // restart. Cancel its timer and remove any durable queued row before the
        // human acknowledgement flush, so a crash cannot resurrect the marker.
        sessionOpDropDeferredSourceActivations(sessionOperationContext, managed, true);
        if (managed.pendingTurnRecovery?.recoveryDispatch) {
            managed.pendingTurnRecovery = {
                ...managed.pendingTurnRecovery,
                waitingForPermission: undefined,
                recoveryDispatch: undefined,
            };
        }
    }
    if (activeMessageState.options?.internalOrigin?.kind === 'source-activation') {
        const pendingSourceActivation = managed.autoRetryPending;
        const liveCapabilityMatches = authenticatedSourceActivation && !existingMessageId
            && !!pendingSourceActivation
            && pendingSourceActivation.dispatchToken === sourceActivationDispatchToken
            && pendingSourceActivation.dispatchInFlight === true
            && pendingSourceActivation.cancelled === false
            && pendingSourceActivation.cancellationEpoch === sourceActivationCancellationEpochAtEntry
            && pendingSourceActivation.generation === managed.processingGeneration
            && isSourceActivationOriginCurrent(managed.activeObjective, activeMessageState.options.internalOrigin);
        const queuedCapabilityMatches = ownsQueuedDispatch && !!existingMessageId && !!queuedItem
            && queuedItem.messageId === existingMessageId
            && isExactQueuedSourceActivation(managed, queuedItem);
        if (!liveCapabilityMatches && !queuedCapabilityMatches) {
            if (authenticatedSourceActivation)
                cancelSourceActivationPending(managed, pendingSourceActivation);
            if (existingMessageId) {
                const staleIndex = managed.messages.findIndex(candidate => candidate.id === existingMessageId
                    && candidate.role === 'user' && candidate.isQueued === true
                    && candidate.internalOrigin?.kind === 'source-activation');
                if (staleIndex >= 0)
                    managed.messages.splice(staleIndex, 1);
            }
            if (ownsQueuedDispatch)
                sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            sessionOperationContext.owner["persistSession"](managed);
            return finishRejectedSourceActivation(input);
        }
    }
    return undefined;
}

async function finishRejectedSourceActivation(
    input: MessageContinuationAuthorityInput
): Promise<void> {
    const { managed, sessionOperationContext, sessionId } = input;
await sessionOperationContext.owner.flushSession(sessionId);
    if (!managed.isProcessing && managed.messageQueue.length > 0)
        sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
    sessionLog.info(`sendMessage: refused stale or unbound source-activation continuation for ${sessionId}`);
    return;
}
