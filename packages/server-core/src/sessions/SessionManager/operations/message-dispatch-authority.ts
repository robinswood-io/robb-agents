import { generateMessageId } from '@craft-agent/shared/protocol';
import { DelegatedDispatchSupersededError, InternalContinuationSupersededError } from '../runtime-policy.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { isFreshStaleTypedUpwardAgentDelivery as sessionOpIsFreshStaleTypedUpwardAgentDelivery } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { authenticatedInternalContinuationCurrent as sessionOpAuthenticatedInternalContinuationCurrent, consumeAuthenticatedInternalContinuation as sessionOpConsumeAuthenticatedInternalContinuation, delegatedDispatchContinuationCurrent as sessionOpDelegatedDispatchContinuationCurrent, consumeDelegatedDispatchContinuation as sessionOpConsumeDelegatedDispatchContinuation } from './message-authority.ts';
import { stripDisabledAllocatedRoutingFallback as sessionOpStripDisabledAllocatedRoutingFallback } from './start-recovery-dispatch.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';
import { untrackSyntheticAutomaticMessage as sessionOpUntrackSyntheticAutomaticMessage } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { hasAcceptedHumanContinuationQueued as sessionOpHasAcceptedHumanContinuationQueued, cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries } from './create-autonomous-context-limit-handoff.ts';
import type { MessageDispatchAuthorityInput } from './message-dispatch-authority-input.ts';

export function prepareMessageDispatchAuthority(
    input: MessageDispatchAuthorityInput
) {
    const {
        existingMessageId,
        queuedDispatchToken,
        activeMessageState,
        sessionOperationContext,
        sessionId,
        managed,
        authenticatedInternalContinuationToken,
        delegatedDispatchContinuationToken,
        explicitRetryIntentAtEntry,
        queuedItem,
        explicitRetryAllowanceToken,
    } = input;
// A queued agent delivery crosses several asynchronous preparation seams
    // before its durable receipt advances from queued to processing. Claim the
    // exact private dequeue synchronously, before the first await, so the
    // original append cannot mistake an owned turn for an abandoned row.
    const queuedAgentDeliveryDispatch = existingMessageId && queuedDispatchToken
        && activeMessageState.options?.internalOrigin?.kind === 'agent-message'
        ? sessionOperationContext.state.queuedAgentDeliveryDispatches.get(existingMessageId)
        : undefined;
    if (queuedAgentDeliveryDispatch
        && queuedAgentDeliveryDispatch.sessionId === sessionId
        && queuedAgentDeliveryDispatch.dispatchToken === queuedDispatchToken
        && queuedAgentDeliveryDispatch.deliveryId === activeMessageState.options?.internalOrigin?.deliveryId
        && sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === queuedDispatchToken) {
        if (sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)) {
            throw new Error(`Target session objective is terminal (${managed.activeObjective?.terminalState}); no agent message was queued. Reuse its completed result. A new delegation is valid only when the objective or version genuinely changed, and grants no new authority.`);
        }
        queuedAgentDeliveryDispatch.claimed = true;
        queuedAgentDeliveryDispatch.claimDurable = false;
        queuedAgentDeliveryDispatch.attemptsBeforeClaim = managed.messages.find(message => message.id === existingMessageId)?.agentDelivery?.attempts;
    }
    const assertFreshAgentDeliveryTargetActive = () => {
        if (activeMessageState.options?.internalOrigin?.kind === 'agent-message' && !existingMessageId
            && sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)) {
            throw new Error(`Target session objective is terminal (${managed.activeObjective?.terminalState}); no agent message was queued. Reuse its completed result. A new delegation is valid only when the objective or version genuinely changed, and grants no new authority.`);
        }
        if (sessionOpIsFreshStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, activeMessageState.options, existingMessageId)) {
            throw new Error('This agent message belongs to a superseded delegated objective and was not queued. Continue only from the sender and recipient current objectives; do not retry or request permission for the stale handoff.');
        }
    };
    assertFreshAgentDeliveryTargetActive();
    const authenticatedInternalContinuationKind = activeMessageState.options?.internalOrigin?.kind === 'auth-result'
        || activeMessageState.options?.internalOrigin?.kind === 'auth-retry'
        ? activeMessageState.options.internalOrigin.kind : undefined;
    const delegatedDispatchSender = activeMessageState.options?.internalOrigin?.kind === 'spawned-session'
        ? activeMessageState.options.internalOrigin.senderSessionId
        : undefined;
    const assertAuthenticatedInternalContinuation = () => {
        const supplied = authenticatedInternalContinuationToken !== undefined
            || authenticatedInternalContinuationKind !== undefined;
        if (supplied && !sessionOpAuthenticatedInternalContinuationCurrent(sessionOperationContext, authenticatedInternalContinuationToken, managed, authenticatedInternalContinuationKind)) {
            sessionOpConsumeAuthenticatedInternalContinuation(sessionOperationContext, authenticatedInternalContinuationToken);
            throw new InternalContinuationSupersededError('The authenticated internal continuation was superseded by a newer objective or runtime.');
        }
        if (delegatedDispatchContinuationToken !== undefined
            && !sessionOpDelegatedDispatchContinuationCurrent(sessionOperationContext, delegatedDispatchContinuationToken, managed, delegatedDispatchSender)) {
            sessionOpConsumeDelegatedDispatchContinuation(sessionOperationContext, delegatedDispatchContinuationToken);
            throw new DelegatedDispatchSupersededError('The delegated child dispatch was superseded by a newer parent objective or runtime.');
        }
    };
    assertAuthenticatedInternalContinuation();
    const recoveredCleanRetryAtEntry = activeMessageState.options?.automaticRecovery?.cause === 'user_retry'
        && explicitRetryIntentAtEntry?.grantNewAllowance === false
        && explicitRetryIntentAtEntry.cleanBoundaryMessageId === activeMessageState.options.automaticRecovery.dispatchId
        && explicitRetryIntentAtEntry.cleanContinuationId === activeMessageState.options.automaticRecovery.cleanContinuationId;
    const supersedableAutomaticRecovery = !!activeMessageState.options?.automaticRecovery
        && (activeMessageState.options.automaticRecovery.cause !== 'user_retry' || recoveredCleanRetryAtEntry);
    const sanitizeDisabledQueuedFallbackAtAdmission = (): boolean => {
        const provenance = activeMessageState.options?.automaticRecovery;
        const pending = managed.pendingTurnRecovery;
        if (!provenance || provenance.cause === 'user_retry' || !pending
            || pending.recoveryDispatch?.id !== provenance.dispatchId)
            return false;
        const sanitized = sessionOpStripDisabledAllocatedRoutingFallback(sessionOperationContext, managed, pending);
        if (!sanitized.changed)
            return false;
        const dispatch = sanitized.pending.recoveryDispatch!;
        const prompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, sanitized.pending, dispatch);
        activeMessageState.message = prompt;
        if (activeMessageState.options?.internalOrigin?.kind === 'browser-fallback') {
            const { internalOrigin: _disabledFallbackOrigin, ...sanitizedOptions } = activeMessageState.options;
            activeMessageState.options = sanitizedOptions;
        }
        if (queuedItem) {
            queuedItem.message = prompt;
            if (queuedItem.options?.internalOrigin?.kind === 'browser-fallback') {
                const { internalOrigin: _disabledFallbackOrigin, ...sanitizedOptions } = queuedItem.options;
                queuedItem.options = sanitizedOptions;
            }
        }
        return true;
    };
    const durableMessageId = (): string => {
        const privateRetryBoundary = explicitRetryAllowanceToken
            ? sessionOperationContext.state.explicitRetryAllowanceTokens.get(explicitRetryAllowanceToken)?.cleanBoundaryMessageId
            : undefined;
        const dispatchId = supersedableAutomaticRecovery
            ? activeMessageState.options?.automaticRecovery?.dispatchId
            : activeMessageState.options?.automaticRecovery?.cause === 'user_retry'
                && privateRetryBoundary === activeMessageState.options.automaticRecovery.dispatchId
                ? privateRetryBoundary
                : undefined;
        return dispatchId && !managed.messages.some(candidate => candidate.id === dispatchId)
            ? dispatchId
            : generateMessageId();
    };
    const cancellationEpochBeforeDispatch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
    const stopRequestedBeforeDispatch = managed.stopRequested === true;
    const lastMessageRoleBeforeDispatch = managed.lastMessageRole;
    const automaticStateBeforeDispatch = supersedableAutomaticRecovery ? {
        lastMessageAt: managed.lastMessageAt,
        streamingText: managed.streamingText,
        pendingRuntimeProviderFallback: managed.pendingRuntimeProviderFallback,
        turnStartFinalMessageId: managed.turnStartFinalMessageId,
        waitDiagnosticBoundary: managed.waitDiagnosticBoundary,
        lastSentMessage: managed.lastSentMessage,
        lastSentAttachments: managed.lastSentAttachments,
        lastSentStoredAttachments: managed.lastSentStoredAttachments,
        lastSentOptions: managed.lastSentOptions,
        wasInterrupted: managed.wasInterrupted,
    } : undefined;
    const removeSyntheticAutomaticMessage = (): boolean => {
        const synthetic = activeMessageState.syntheticAutomaticMessage;
        if (!synthetic?.hidden || synthetic.role !== 'user')
            return false;
        if (synthetic.providerDispatch)
            return false;
        sessionOpUntrackSyntheticAutomaticMessage(sessionOperationContext, managed, synthetic);
        const index = managed.messages.indexOf(synthetic);
        if (index < 0)
            return false;
        managed.messages.splice(index, 1);
        activeMessageState.syntheticAutomaticMessage = undefined;
        return true;
    };
    const restoreStartedAutomaticDispatch = (): boolean => {
        const startedDispatch = supersedableAutomaticRecovery
            ? managed.pendingTurnRecovery?.recoveryDispatch
            : undefined;
        if (startedDispatch?.phase !== 'started')
            return false;
        const allocatedDispatch = { ...startedDispatch, phase: 'allocated' as const };
        delete allocatedDispatch.startedAt;
        managed.pendingTurnRecovery = {
            ...managed.pendingTurnRecovery!,
            recoveryDispatch: allocatedDispatch,
        };
        return true;
    };
    const automaticRecoverySuperseded = () => supersedableAutomaticRecovery && (sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
        || sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext, managed));
    const finishSupersededAutomaticRecovery = async (): Promise<boolean> => {
        if (!automaticRecoverySuperseded()
            || !sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext, managed, activeMessageState.options!.automaticRecovery!))
            return false;
        removeSyntheticAutomaticMessage();
        if (activeMessageState.automaticDispatchGeneration !== undefined
            && managed.processingGeneration === activeMessageState.automaticDispatchGeneration) {
            sessionOperationContext.owner["setProcessing"](managed, false);
            if (automaticStateBeforeDispatch) {
                managed.lastMessageAt = automaticStateBeforeDispatch.lastMessageAt;
                managed.streamingText = automaticStateBeforeDispatch.streamingText;
                managed.pendingRuntimeProviderFallback = automaticStateBeforeDispatch.pendingRuntimeProviderFallback;
                managed.turnStartFinalMessageId = automaticStateBeforeDispatch.turnStartFinalMessageId;
                managed.waitDiagnosticBoundary = automaticStateBeforeDispatch.waitDiagnosticBoundary;
                managed.lastSentMessage = automaticStateBeforeDispatch.lastSentMessage;
                managed.lastSentAttachments = automaticStateBeforeDispatch.lastSentAttachments;
                managed.lastSentStoredAttachments = automaticStateBeforeDispatch.lastSentStoredAttachments;
                managed.lastSentOptions = automaticStateBeforeDispatch.lastSentOptions;
                managed.wasInterrupted = sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext, managed)
                    ? true
                    : automaticStateBeforeDispatch.wasInterrupted;
            }
        }
        if (queuedDispatchToken && sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === queuedDispatchToken) {
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
        }
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }
        else if (!managed.isProcessing && managed.activeObjective
            && managed.activeObjective.terminalState !== 'active') {
            await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'complete', managed.processingGeneration);
        }
        return true;
    };
    return {
        queuedAgentDeliveryDispatch,
        assertFreshAgentDeliveryTargetActive,
        assertAuthenticatedInternalContinuation,
        recoveredCleanRetryAtEntry,
        supersedableAutomaticRecovery,
        sanitizeDisabledQueuedFallbackAtAdmission,
        durableMessageId,
        cancellationEpochBeforeDispatch,
        stopRequestedBeforeDispatch,
        lastMessageRoleBeforeDispatch,
        removeSyntheticAutomaticMessage,
        restoreStartedAutomaticDispatch,
        automaticRecoverySuperseded,
        finishSupersededAutomaticRecovery,
    };
}
