import { setOptional } from '@craft-agent/shared/utils/json';
import { enqueueRecoveredMessageInTranscriptOrder } from '../policy.ts';
import { recoveredInternalMessageOptions } from '../../agent-delivery.ts';
import type { Message } from '@craft-agent/core/types';
import { untrackSyntheticAutomaticMessage as sessionOpUntrackSyntheticAutomaticMessage } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { completeQueuedAgentDeliveryDispatch as sessionOpCompleteQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';

export function installProviderTurnHooks(
    providerTurnInput: ProviderTurnInput
) {
    const {
        sessionOperationContext,
        managed,
        activeProviderState,
        activeMessageState,
        userMessage,
        agent,
    } = providerTurnInput;
// A backend may emit local validation or preparation events before it has
    // handed the prompt to its provider runtime. Production backends expose an
    // explicit boundary; older test/third-party backends retain the historical
    // first-event fallback until they implement that contract.
    const hasExplicitProviderHandoff = !providerTurnInput.localCompactCommand && 'onProviderHandoff' in agent;
    const hasExplicitProviderWriteAhead = !providerTurnInput.localCompactCommand && 'onBeforeProviderDispatch' in agent;
    activeProviderState.providerHandoffCancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
    const exactProviderHandoffAgent = agent;
    const providerDispatchObjectiveId = managed.activeObjective?.objectiveId
        ?? managed.activeObjective?.userMessageId
        ?? userMessage.id;
    const providerDispatchObjectiveUserMessageId = managed.activeObjective?.userMessageId
        ?? userMessage.id;
    activeProviderState.exactProviderWriteAheadMatches = (): boolean => {
        const current = userMessage.providerDispatch;
        const expected = activeProviderState.providerWriteAheadMarker;
        return !!current && !!expected
            && current.schemaVersion === expected.schemaVersion
            && current.state === expected.state
            && current.messageId === expected.messageId
            && current.objectiveId === expected.objectiveId
            && current.objectiveUserMessageId === expected.objectiveUserMessageId
            && current.generation === expected.generation
            && current.cancellationEpoch === expected.cancellationEpoch
            && current.markedAt === expected.markedAt
            && current.acceptedAt === expected.acceptedAt;
    };
    activeProviderState.rollbackProviderWriteAhead = async (): Promise<boolean> => {
        if (!activeProviderState.exactProviderWriteAheadMatches())
            return false;
        delete userMessage.providerDispatch;
        if (userMessage.agentDelivery?.status === 'processed'
            && Number.isFinite(userMessage.agentDelivery.providerDispatchUncertainAt)) {
            // Stop may have conservatively consumed the receipt while the exact
            // preflight rejection/abort-before-write proof was still in flight.
            // That proof makes the receipt replay-safe again, but it remains a
            // retained typed inbox item and gains no autonomous authority.
            userMessage.agentDelivery.status = 'queued';
            userMessage.isQueued = true;
            delete userMessage.agentDelivery.providerDispatchUncertainAt;
            if (providerTurnInput.deliveryAttemptsBeforePreparation !== undefined) {
                userMessage.agentDelivery.attempts = providerTurnInput.deliveryAttemptsBeforePreparation;
            }
            if (!managed.messageQueue.some(item => item.messageId === userMessage.id)) {
                enqueueRecoveredMessageInTranscriptOrder(managed, {
                    message: userMessage.content,
                    messageId: userMessage.id,
                    ...(userMessage.attachments !== undefined ? { storedAttachments: userMessage.attachments } : {}),
                    options: recoveredInternalMessageOptions(userMessage),
                });
            }
        }
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            setOptional(userMessage, "providerDispatch", activeProviderState.providerWriteAheadMarker);
            throw new Error('The provider dispatch rollback could not be queued for durable storage');
        }
        try {
            await sessionOperationContext.owner.flushSessionDurably(managed.id);
        }
        catch (error) {
            // A failed deletion is not proof that the preceding write-ahead was
            // removed. Restore the in-memory fence and remain fail-closed.
            setOptional(userMessage, "providerDispatch", activeProviderState.providerWriteAheadMarker);
            sessionOperationContext.owner["persistSession"](managed);
            throw error;
        }
        return true;
    };
    activeProviderState.clearAcceptedProviderWriteAhead = async (): Promise<boolean> => {
        if (userMessage.providerDispatch?.state !== 'accepted'
            || !activeProviderState.exactProviderWriteAheadMatches())
            return false;
        const acceptedMarker = userMessage.providerDispatch;
        delete userMessage.providerDispatch;
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            userMessage.providerDispatch = acceptedMarker;
            throw new Error('The durable provider acceptance proof could not be cleared');
        }
        try {
            await sessionOperationContext.owner.flushSessionDurably(managed.id);
            activeProviderState.providerWriteAheadMarker = undefined;
        }
        catch (error) {
            userMessage.providerDispatch = acceptedMarker;
            sessionOperationContext.owner["persistSession"](managed);
            throw error;
        }
        return true;
    };
    activeProviderState.providerWriteAheadCallback = async () => {
        if (!activeProviderState.providerHandoffArmed
            || sessionOperationContext.state.shuttingDown
            || sessionOperationContext.state.sessions.get(providerTurnInput.sessionId) !== managed
            || managed.agent !== exactProviderHandoffAgent
            || managed.processingGeneration !== providerTurnInput.myGeneration
            || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== activeProviderState.providerHandoffCancellationEpoch) {
            throw new Error('Provider dispatch was cancelled before its durable write-ahead');
        }
        const marker: NonNullable<Message['providerDispatch']> = {
            schemaVersion: 1,
            state: 'acceptance-unknown',
            messageId: userMessage.id,
            objectiveId: providerDispatchObjectiveId,
            objectiveUserMessageId: providerDispatchObjectiveUserMessageId,
            generation: providerTurnInput.myGeneration,
            cancellationEpoch: activeProviderState.providerHandoffCancellationEpoch,
            markedAt: Date.now(),
        };
        if (userMessage.providerDispatch) {
            if (!activeProviderState.exactProviderWriteAheadMatches()) {
                throw new Error('A different provider dispatch fence already owns this message');
            }
            activeProviderState.providerWriteAheadReturned = true;
            return;
        }
        activeProviderState.providerWriteAheadMarker = marker;
        userMessage.providerDispatch = marker;
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            delete userMessage.providerDispatch;
            activeProviderState.providerWriteAheadMarker = undefined;
            throw new Error('The provider dispatch write-ahead could not be queued for durable storage');
        }
        await sessionOperationContext.owner.flushSessionDurably(managed.id);
        if (!activeProviderState.exactProviderWriteAheadMatches()) {
            throw new Error('The provider dispatch write-ahead changed before provider dispatch');
        }
        if (!activeProviderState.providerHandoffArmed
            || sessionOperationContext.state.shuttingDown
            || sessionOperationContext.state.sessions.get(providerTurnInput.sessionId) !== managed
            || managed.agent !== exactProviderHandoffAgent
            || managed.processingGeneration !== providerTurnInput.myGeneration
            || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== activeProviderState.providerHandoffCancellationEpoch) {
            await activeProviderState.rollbackProviderWriteAhead();
            throw new Error('Provider dispatch was cancelled before its provider write');
        }
        activeProviderState.providerWriteAheadReturned = true;
    };
    const markProviderDispatchUncertainOnce = () => {
        if (!activeProviderState.providerHandoffArmed
            || sessionOperationContext.state.shuttingDown
            || sessionOperationContext.state.sessions.get(providerTurnInput.sessionId) !== managed
            || managed.agent !== exactProviderHandoffAgent
            || managed.processingGeneration !== providerTurnInput.myGeneration
            || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== activeProviderState.providerHandoffCancellationEpoch)
            return;
        const exactDispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(userMessage.id);
        if (exactDispatch && exactDispatch.dispatchToken === providerTurnInput.queuedDispatchToken
            && exactDispatch.providerStarted !== true) {
            exactDispatch.providerDispatchUncertain = true;
        }
    };
    activeProviderState.providerDispatchRejectedCallback = () => {
        if (!activeProviderState.providerHandoffArmed || activeProviderState.chatStarted
            || sessionOperationContext.state.shuttingDown
            || sessionOperationContext.state.sessions.get(providerTurnInput.sessionId) !== managed
            || managed.agent !== exactProviderHandoffAgent
            || managed.processingGeneration !== providerTurnInput.myGeneration
            || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== activeProviderState.providerHandoffCancellationEpoch
            || !activeProviderState.exactProviderWriteAheadMatches())
            return;
        activeProviderState.providerDispatchRejected = true;
    };
    const rejectProviderHandoffFailClosed = (error: unknown) => {
        // Until the ACK snapshot crosses its durable barrier, the preceding WAL
        // remains the only crash-safe truth. Keep live admission aligned with
        // that acceptance-unknown state before waking a silent provider loop.
        if (userMessage.providerDispatch?.state === 'accepted'
            && activeProviderState.exactProviderWriteAheadMatches()) {
            const acceptanceUnknown = {
                ...userMessage.providerDispatch,
                state: 'acceptance-unknown' as const,
            };
            delete acceptanceUnknown.acceptedAt;
            userMessage.providerDispatch = acceptanceUnknown;
            activeProviderState.providerWriteAheadMarker = acceptanceUnknown;
            sessionOperationContext.owner["persistSession"](managed);
        }
        activeProviderState.rejectProviderHandoffDurabilityFailure(error);
    };
    const commitProviderHandoffOnce = () => {
        if (activeProviderState.chatStarted || activeProviderState.providerHandoffDurabilityPromise)
            return;
        if (!activeProviderState.providerHandoffArmed
            || sessionOperationContext.state.shuttingDown
            || sessionOperationContext.state.sessions.get(providerTurnInput.sessionId) !== managed
            || managed.agent !== exactProviderHandoffAgent
            || managed.processingGeneration !== providerTurnInput.myGeneration
            || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== activeProviderState.providerHandoffCancellationEpoch)
            return;
        // A write-ahead capable backend may acknowledge only the exact marker
        // captured for this message/objective/generation. A stale callback from
        // an older turn cannot clear a newer non-replay fence.
        if (hasExplicitProviderWriteAhead && !activeProviderState.exactProviderWriteAheadMatches())
            return;
        const acknowledgedMarker = activeProviderState.exactProviderWriteAheadMatches()
            ? { ...userMessage.providerDispatch!, state: 'accepted' as const, acceptedAt: Date.now() }
            : undefined;
        if (acknowledgedMarker) {
            userMessage.providerDispatch = acknowledgedMarker;
            activeProviderState.providerWriteAheadMarker = acknowledgedMarker;
        }
        const admittedSetupDispatch = managed.pendingTurnRecovery?.recoveryDispatch;
        if (admittedSetupDispatch?.phase === 'started'
            && admittedSetupDispatch.id === userMessage.id
            && admittedSetupDispatch.setupFailureCount !== undefined) {
            delete admittedSetupDispatch.setupFailureCount;
            delete admittedSetupDispatch.lastSetupFailureClass;
            delete admittedSetupDispatch.setupRetryNotBefore;
            delete admittedSetupDispatch.setupRetryBlockedAt;
            delete admittedSetupDispatch.setupPersistenceFencedAt;
            if (sessionOperationContext.state.cleanRetrySetupPersistenceFences.get(providerTurnInput.sessionId) === admittedSetupDispatch.id) {
                sessionOperationContext.state.cleanRetrySetupPersistenceFences.delete(providerTurnInput.sessionId);
            }
        }
        if (providerTurnInput.sourceActivationOrigin && managed.autoRetryPending?.sourceActivationId === providerTurnInput.sourceActivationOrigin.sourceActivationId) {
            managed.autoRetryPending.providerStarted = true;
        }
        sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext, managed, activeMessageState.syntheticAutomaticMessage);
        if (userMessage.agentDelivery) {
            delete userMessage.agentDelivery.setupFailureCount;
            delete userMessage.agentDelivery.lastSetupFailureClass;
            delete userMessage.agentDelivery.setupRetryNotBefore;
            delete userMessage.agentDelivery.setupRetryBlockedAt;
            delete userMessage.agentDelivery.setupPersistenceFencedAt;
            if (sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(providerTurnInput.sessionId) === userMessage.agentDelivery.id) {
                sessionOperationContext.state.agentDeliverySetupPersistenceFences.delete(providerTurnInput.sessionId);
            }
            const exactDispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(userMessage.id);
            if (exactDispatch && exactDispatch.dispatchToken === providerTurnInput.queuedDispatchToken) {
                exactDispatch.providerStarted = true;
            }
            sessionOpCompleteQueuedAgentDeliveryDispatch(sessionOperationContext, userMessage.id, providerTurnInput.queuedDispatchToken);
        }
        if (!acknowledgedMarker) {
            activeProviderState.chatStarted = true;
            return;
        }
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            activeProviderState.providerHandoffDurabilityPromise = Promise.reject(new Error('The provider handoff acknowledgement could not be queued for durable storage'));
            void activeProviderState.providerHandoffDurabilityPromise.catch(rejectProviderHandoffFailClosed);
            return;
        }
        activeProviderState.providerHandoffDurabilityPromise = (async () => {
            await sessionOperationContext.owner.flushSessionDurably(managed.id);
            if (!activeProviderState.exactProviderWriteAheadMatches()) {
                throw new Error('The provider handoff acknowledgement changed before becoming durable');
            }
            if (!activeProviderState.providerHandoffArmed
                || sessionOperationContext.state.shuttingDown
                || sessionOperationContext.state.sessions.get(providerTurnInput.sessionId) !== managed
                || managed.agent !== exactProviderHandoffAgent
                || managed.processingGeneration !== providerTurnInput.myGeneration
                || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== activeProviderState.providerHandoffCancellationEpoch) {
                throw new Error('Provider handoff became durable after the turn was cancelled');
            }
            activeProviderState.chatStarted = true;
        })();
        // The backend callback is synchronous and may be followed by silence.
        // Observe rejection immediately; the original promise is still awaited
        // at the next event/stream boundary and follows the fail-closed path.
        void activeProviderState.providerHandoffDurabilityPromise.catch(rejectProviderHandoffFailClosed);
    };
    if (hasExplicitProviderHandoff) {
        activeProviderState.providerHandoffAgent = agent;
        activeProviderState.providerHandoffCallback = commitProviderHandoffOnce;
        activeProviderState.previousProviderHandoffCallback = agent.onProviderHandoff;
        agent.onProviderHandoff = activeProviderState.providerHandoffCallback;
        if ('onProviderDispatchUncertain' in agent) {
            activeProviderState.providerDispatchUncertainCallback = markProviderDispatchUncertainOnce;
            activeProviderState.previousProviderDispatchUncertainCallback = agent.onProviderDispatchUncertain;
            agent.onProviderDispatchUncertain = activeProviderState.providerDispatchUncertainCallback;
        }
        if (hasExplicitProviderWriteAhead) {
            activeProviderState.previousProviderWriteAheadCallback = agent.onBeforeProviderDispatch;
            agent.onBeforeProviderDispatch = activeProviderState.providerWriteAheadCallback;
        }
        if ('onProviderDispatchRejected' in agent) {
            activeProviderState.previousProviderDispatchRejectedCallback = agent.onProviderDispatchRejected;
            agent.onProviderDispatchRejected = activeProviderState.providerDispatchRejectedCallback;
        }
    }
    return { hasExplicitProviderHandoff, commitProviderHandoffOnce };
}
