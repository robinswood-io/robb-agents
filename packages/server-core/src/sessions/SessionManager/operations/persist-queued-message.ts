import { releaseSourceActivationClaim, rehydrateObjectiveEvidence } from '../policy.ts';
import type { Message } from '@craft-agent/core/types';
import { sessionLog } from '../runtime-platform.ts';
import { serializeDirectHumanSupersession as sessionOpSerializeDirectHumanSupersession } from './message-authority.ts';
import { consumeLiveDirectHumanContinuation as sessionOpConsumeLiveDirectHumanContinuation } from './create-autonomous-context-limit-handoff.ts';
import { finishAgentDeliveryAppend as sessionOpFinishAgentDeliveryAppend } from './settle-queued-agent-delivery-dispatch.ts';
import { emitUserInputChanged as sessionOpEmitUserInputChanged } from './perform-request-user-input.ts';
import { supersedeHumanHandoffsForDirectContinuation as sessionOpSupersedeHumanHandoffsForDirectContinuation } from './resolve-objective-mutation-authority.ts';
import type { QueuedMessageInput } from './queued-message-input.ts';

export async function persistQueuedMessage(
  input: Pick<QueuedMessageInput, 'options' | 'existingMessageId' | 'sessionOperationContext' | 'managed' | 'stoppedFreshAgentDeliveryError' | 'directHumanContinuation' | 'stoppedDirectHumanError' | 'directHumanStopWon' | 'freshAgentDeliveryStopWon' | 'sourceActivationOrigin' | 'sourceActivationDispatchToken' | 'sessionId'>,
  steered: boolean,
  userMessage: Message,
  steeringMessage: string,
  finishToolAdmissionRebind: ((committed: boolean) => void) | undefined,
) {
    const { options, existingMessageId, sessionOperationContext, managed, stoppedFreshAgentDeliveryError, directHumanContinuation, stoppedDirectHumanError, directHumanStopWon, freshAgentDeliveryStopWon, sourceActivationOrigin, sourceActivationDispatchToken, sessionId } = input;
    const tracksFreshAgentDeliveryAppend = options?.internalOrigin?.kind === 'agent-message'
        && !existingMessageId && !steered;
    if (tracksFreshAgentDeliveryAppend)
        sessionOperationContext.state.agentDeliveryAppendsInFlight.add(userMessage.id);
    const finishFreshAgentDeliveryAppend = () => {
        if (tracksFreshAgentDeliveryAppend)
            sessionOpFinishAgentDeliveryAppend(sessionOperationContext, userMessage.id);
    };
    const rejectStoppedFreshAgentDelivery = async (): Promise<never> => {
        // A sender retries only when no durable ACK was published. Stop may win
        // after this receipt was appended but before its acceptance flush
        // returns, so remove that exact object from both inbox representations
        // and fsync the deletion before rejecting the sender.
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
        const messageIndex = managed.messages.indexOf(userMessage);
        if (messageIndex >= 0)
            managed.messages.splice(messageIndex, 1);
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('The stopped agent delivery could not be removed from durable storage');
        }
        await sessionOperationContext.owner.flushSession(managed.id);
        throw stoppedFreshAgentDeliveryError();
    };
    // A direct human continuation revokes obsolete permission/auth handoffs
    // even when the provider accepted it as an in-flight steer. Otherwise an
    // approval minted for the previous objective could execute afterwards.
    const fenceDirectContinuation = directHumanContinuation;
    const rejectStoppedDirectContinuation = async (): Promise<never> => {
        // The visible row is appended before the serialized durability section.
        // Stop can therefore win while this send waits for an older direct
        // continuation transaction, or while its own flush is in progress.
        // Remove this exact, never-ACKed row and fsync the removal: otherwise a
        // later processing-stop callback or cold start can execute it.
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
        const messageIndex = managed.messages.indexOf(userMessage);
        if (messageIndex >= 0)
            managed.messages.splice(messageIndex, 1);
        const correlatedSteer = managed.pendingUserSteers?.get(steeringMessage);
        if (correlatedSteer?.queued.messageId === userMessage.id) {
            managed.pendingUserSteers?.delete(steeringMessage);
            if (managed.activeObjective === correlatedSteer.objectiveAfter) {
                managed.activeObjective = correlatedSteer.objectiveBefore;
                // Stop owns recovery cancellation; never resurrect its previous
                // automatic allowance while rolling back an unacknowledged steer.
                if (managed.pendingTurnRecovery?.userMessageId === userMessage.id) {
                    managed.pendingTurnRecovery = undefined;
                }
                rehydrateObjectiveEvidence(managed);
            }
        }
        sessionOpConsumeLiveDirectHumanContinuation(sessionOperationContext, managed, userMessage.id);
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('The stopped message could not be removed from durable storage');
        }
        await sessionOperationContext.owner.flushSession(managed.id);
        throw stoppedDirectHumanError();
    };
    const persistQueuedTurn = async () => {
        if (fenceDirectContinuation && directHumanStopWon()) {
            await rejectStoppedDirectContinuation();
        }
        if (freshAgentDeliveryStopWon()) {
            await rejectStoppedFreshAgentDelivery();
        }
        const directHumanSupersession = fenceDirectContinuation
            ? sessionOpSupersedeHumanHandoffsForDirectContinuation(sessionOperationContext, managed)
            : undefined;
        const supersededUserInput = directHumanSupersession?.userInputChanged ?? false;
        const rollbackFailedDirectSupersession = directHumanSupersession?.rollbackFailedDurability;
        sessionOperationContext.owner["persistSession"](managed);
        // Force a synchronous flush so the user message is genuinely on disk
        // before we tell the renderer "accepted" — `persistSession` only
        // enqueues with a 500ms debounce. (#616 reliability fix.)
        try {
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        catch (error) {
            if (fenceDirectContinuation) {
                // The renderer was never acknowledged and no live capability was
                // minted. Remove this exact uncommitted row so a processing-stop
                // callback cannot treat in-memory state as durable human authority.
                managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
                const messageIndex = managed.messages.indexOf(userMessage);
                if (messageIndex >= 0 && userMessage.isQueued)
                    managed.messages.splice(messageIndex, 1);
                rollbackFailedDirectSupersession?.();
                sessionOperationContext.owner["persistSession"](managed);
                try {
                    await sessionOperationContext.owner.flushSession(managed.id);
                }
                catch (rollbackError) {
                    sessionLog.warn('Failed to flush rejected direct continuation rollback', {
                        sessionId: managed.id,
                        messageId: userMessage.id,
                        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                    });
                }
            }
            if (sourceActivationOrigin) {
                managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
                const messageIndex = managed.messages.indexOf(userMessage);
                if (messageIndex >= 0)
                    managed.messages.splice(messageIndex, 1);
                releaseSourceActivationClaim(managed, sourceActivationDispatchToken);
                sessionOperationContext.owner["persistSession"](managed);
                try {
                    await sessionOperationContext.owner.flushSession(managed.id);
                }
                catch { /* The timer catch retains the bounded retry capability. */ }
            }
            throw error;
        }
        if (supersededUserInput)
            sessionOpEmitUserInputChanged(sessionOperationContext, managed);
    };
    try {
        if (fenceDirectContinuation)
            await sessionOpSerializeDirectHumanSupersession(sessionOperationContext, managed, persistQueuedTurn);
        else
            await persistQueuedTurn();
    }
    catch (error) {
        finishToolAdmissionRebind?.(false);
        // A preceding concurrent continuation may already be durable but its
        // wake was fenced by this transaction. Do not strand that exact row.
        if (fenceDirectContinuation && !managed.isProcessing && !managed.stopRequested
            && !sessionOperationContext.state.directHumanSupersessionsInFlight.has(managed)) {
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }
        finishFreshAgentDeliveryAppend();
        throw error;
    }
    if (freshAgentDeliveryStopWon()) {
        await rejectStoppedFreshAgentDelivery();
    }
    finishToolAdmissionRebind?.(true);
    return { finishFreshAgentDeliveryAppend, fenceDirectContinuation, rejectStoppedDirectContinuation };
}
