import { prepareMessageDispatchAuthority } from './message-dispatch-authority.ts';
import { resolveMessageRetryAdmission } from './message-retry-admission.ts';
import { claimMessageSourceActivation } from './message-source-activation-claim.ts';
import { applyMessageContinuationAuthority } from './message-continuation-authority.ts';
import { prepareSessionMessageTurn } from './prepare-session-message-turn.ts';
import { runSessionMessageTurn } from './run-session-message-turn.ts';
import { applyOperationsTurnPolicy } from './apply-operations-turn-policy.ts';

import { enqueueSessionMessage } from './enqueue-session-message.ts';
import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import { hasPendingLocalUserInput, queuedDirectHumanContinuationIndex, persistenceRootFor, repairLegacyContextualObjectiveAuthority, isDirectHumanContinuation } from '../policy.ts';

import { reopenCompletedChat } from '../../completed-chat-retention';

import { clearPendingPlanExecution as clearStoredPendingPlanExecution } from '@craft-agent/shared/sessions';

import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol';
import { CodedError } from '@craft-agent/shared/protocol';
import type { StoredAttachment } from '@craft-agent/core/types';

import type { ManagedSession } from '../managed-session.ts';

import { sessionLog } from '../runtime-platform.ts';
import { InternalContinuationSupersededError } from '../runtime-policy.ts';

import type { SourceActivationOrigin } from '../source-activation.ts';
import { isSourceActivationOriginCurrent } from '../source-activation.ts';

import { isCostLimitContinuationAnswer } from '../user-input-authority.ts';

import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, repairLegacySyntheticObjectiveAuthority as sessionOpRepairLegacySyntheticObjectiveAuthority, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { releasableUpwardAgentDeliverySenderId as sessionOpReleasableUpwardAgentDeliverySenderId, isStaleTypedUpwardAgentDelivery as sessionOpIsStaleTypedUpwardAgentDelivery, quarantineStaleTypedUpwardAgentDelivery as sessionOpQuarantineStaleTypedUpwardAgentDelivery } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { consumeAuthenticatedInternalContinuation as sessionOpConsumeAuthenticatedInternalContinuation } from './message-authority.ts';

import { providerDispatchAdmissionBarrier as sessionOpProviderDispatchAdmissionBarrier } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { consumeLiveDirectHumanContinuation as sessionOpConsumeLiveDirectHumanContinuation } from './create-autonomous-context-limit-handoff.ts';
import { setLastMessageClientId as sessionOpSetLastMessageClientId } from './runtime-host.ts';
import { settleQueuedAgentDeliveryDispatch as sessionOpSettleQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import { cancelPendingAuthForHumanContinuation as sessionOpCancelPendingAuthForHumanContinuation } from './downgrade-cold-auth-resume-permission.ts';
import { isAutonomousMessage as sessionOpIsAutonomousMessage } from './is-current-delegated-descendant.ts';
import { exactQueuedAgentDeliveryReceipt as sessionOpExactQueuedAgentDeliveryReceipt } from './restore-pre-ack-agent-delivery-dequeues.ts';

import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';

async function sessionOpPerformSendMessage(sessionOperationContext: SessionOperationContext, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions, existingMessageId?: string, _isAuthRetry?: boolean, 
/**
 * Internal hook fired after the user message has been pushed to
 * `managed.messages` and persisted to disk, but before the model-streaming
 * work begins. The RPC handler uses this to send a synchronous "accepted"
 * ack to the client so a crash mid-stream doesn't lose the user message
 * (#616). Pre-persist errors still reject the outer promise as before.
 */
onAck?: (messageId: string) => void, 
/**
 * Optional transport context. The `sessions.sendMessage` RPC handler passes
 * `{ callerClientId: ctx.clientId }` so the SM can pin the desktop client
 * that should host this session's browser tools. Pass undefined when calling
 * directly (tests, intra-server flows) to leave the existing pin in place.
 */
rpcContext?: {
    callerClientId?: string;
}, 
/** Private dequeue ownership, never supplied by RPC or persisted as authority. */
queuedDispatchToken?: symbol, 
/** Original private FIFO entry, retained intact if preparation is deferred. */
queuedItem?: ManagedSession['messageQueue'][number], 
/** Cancellation fence captured by the private Retry operation before hydration. */
retryCancellationEpoch?: number, 
/** One-use private capability minted by explicit Retry or its exact
 * host-authenticated cold reconstruction. */
explicitRetryAllowanceToken?: symbol, 
/** One-use private capability minted only by a source_activated event. */
sourceActivationDispatchToken?: symbol, 
/** One-use private capability minted by an exact auth completion/retry. */
authenticatedInternalContinuationToken?: symbol, 
/** One-use private capability minted by the delegating parent immediately before child dispatch. */
delegatedDispatchContinuationToken?: symbol): Promise<void> {
    if (sessionOperationContext.state.shuttingDown)
        throw new Error('The application is closing; the saved turn will resume after restart');
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        throw new Error(`Session ${sessionId} not found`);
    }
    sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
    const activeMessageState: SessionMessageState = { message, options, syntheticAutomaticMessage: undefined, automaticDispatchGeneration: undefined };
    const explicitRetryIntentAtEntry = explicitRetryAllowanceToken
        ? sessionOperationContext.state.explicitRetryAllowanceTokens.get(explicitRetryAllowanceToken)
        : undefined;
    const authenticatedRetryDispatch = !!explicitRetryIntentAtEntry
        || !!queuedDispatchToken && sessionOperationContext.state.permissionInboxRetryDispatches.has(queuedDispatchToken);
    if ((sessionOperationContext.state.providerRetryReconciliationTransactions.has(sessionId)
        || sessionOperationContext.state.providerLiveReconciliationTransactions.has(sessionId)) && !authenticatedRetryDispatch) {
        throw new CodedError('CAPABILITY_UNAVAILABLE', 'Provider reconciliation is still being persisted; wait for that exact turn before sending more work.');
    }
    // A queued agent delivery crosses several asynchronous preparation seams
    // before its durable receipt advances from queued to processing. Claim the
    // exact private dequeue synchronously, before the first await, so the
    // original append cannot mistake an owned turn for an abandoned row.
    const {
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
    } = prepareMessageDispatchAuthority({
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
    });
    if (sessionOperationContext.state.retentionDeleting.has(sessionId))
        throw new Error('This completed chat is being removed by retention');
    if (managed.sessionStatus === 'done')
        reopenCompletedChat(persistenceRootFor(managed), sessionId);
    let authenticatedSourceActivation = false;
    const sourceActivationCancellationEpochAtEntry = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
    const expectedAnchor = activeMessageState.options?.expectedSessionAnchor;
    const assertExpectedAnchor = () => {
        if (!expectedAnchor)
            return;
        const actualLastFinalMessageId = managed.lastFinalMessageId ?? null;
        const contextMatches = !managed.isProcessing
            && managed.messages.length === expectedAnchor.messageCount
            && actualLastFinalMessageId === expectedAnchor.lastFinalMessageId
            && managed.lastMessageAt === expectedAnchor.lastMessageAt;
        if (!contextMatches) {
            throw new CodedError('SESSION_CONTEXT_CHANGED', 'The conversation changed before the offline message could be appended');
        }
    };
    if (expectedAnchor) {
        // The Remote outbox contract must be side-effect-free when its reviewed
        // anchor is stale. Once loaded, the guard and in-memory append run without
        // an await, so another turn cannot slip between them. Clearing the
        // in-memory plan field makes the same atomic JSONL flush persist both the
        // accepted message and plan cancellation; a rejected guard writes neither.
        await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
        sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
        assertExpectedAnchor();
        managed.pendingPlanExecution = undefined;
        sessionOpSetLastMessageClientId(sessionOperationContext, sessionId, rpcContext?.callerClientId);
    }
    else {
        sessionOpSetLastMessageClientId(sessionOperationContext, sessionId, rpcContext?.callerClientId);
        // Source-activation auto-retry dedup (craft-agents-oss#804). Matching text
        // from a legacy renderer (or a user) is never provenance. Only the private
        // capability minted by processEvent may preserve the current objective.
        const claimedSourceActivation = claimMessageSourceActivation({
        activeMessageState,
        existingMessageId,
        queuedDispatchToken,
        managed,
        sourceActivationDispatchToken,
        sessionId,
    });
        if (claimedSourceActivation === undefined) return;
        authenticatedSourceActivation = claimedSourceActivation;
        // Clear any pending plan execution state when a new user message is sent.
        // This acts as a safety valve - if the user moves on, we don't want to
        // auto-execute an old plan later.
        if (activeMessageState.options?.automaticRecovery?.cause !== 'user_retry') {
            await clearStoredPendingPlanExecution(persistenceRootFor(managed), sessionId, managed.persistenceRootIdentity);
            assertAuthenticatedInternalContinuation();
        }
        // Ensure messages are loaded before we try to add new ones
        await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
        sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
        assertAuthenticatedInternalContinuation();
    }
    // Mixed-version histories may contain a metadata-less host fallback that
    // an older build promoted to objective root. Repair it before any retry,
    // routing or tool-authority decision observes the current turn.
    if (sessionOpRepairLegacySyntheticObjectiveAuthority(sessionOperationContext, managed)) {
        sessionLog.warn('Repaired legacy synthetic objective authority before send', {
            sessionId: managed.id,
            objectiveId: managed.activeObjective?.objectiveId,
        });
    }
    if (repairLegacyContextualObjectiveAuthority(managed)) {
        sessionLog.warn('Repaired legacy contextual objective root before send', {
            sessionId: managed.id,
            objectiveId: managed.activeObjective?.objectiveId,
        });
    }
    sanitizeDisabledQueuedFallbackAtAdmission();
    assertAuthenticatedInternalContinuation();
    if (sessionOperationContext.state.providerStopTransitionsInFlight.has(managed.id)
        || (!managed.isProcessing && (sessionOpProviderDispatchAdmissionBarrier(sessionOperationContext, managed)
            || sessionOperationContext.state.coldProviderReconciliationsInFlight.has(managed.id)))) {
        throw new CodedError('CAPABILITY_UNAVAILABLE', 'The previous provider dispatch may already have been accepted. Use Retry to reconcile that exact turn before sending more work.');
    }
    // Hydration above may yield while the target finishes. Recheck before
    // evaluating its current admission state.
    assertFreshAgentDeliveryTargetActive();
    if (sessionOperationContext.state.shuttingDown)
        throw new Error('The application is closing; the saved turn will resume after restart');
    if (retryCancellationEpoch !== undefined && (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== retryCancellationEpoch) {
        throw new Error('Retry was cancelled by Stop');
    }
    const ownsQueuedDispatch = queuedDispatchToken !== undefined && sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === queuedDispatchToken;
    if (queuedDispatchToken !== undefined && !ownsQueuedDispatch) {
        if (queuedAgentDeliveryDispatch)
            queuedAgentDeliveryDispatch.claimed = false;
        sessionOpSettleQueuedAgentDeliveryDispatch(sessionOperationContext, existingMessageId, queuedDispatchToken);
        return;
    }
    if (await finishSupersededAutomaticRecovery())
        return;
    const directHumanContinuation = isDirectHumanContinuation(managed, activeMessageState.message, activeMessageState.options, existingMessageId);
    const directHumanStopWon = () => directHumanContinuation && (stopRequestedBeforeDispatch
        || managed.stopRequested === true
        || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpochBeforeDispatch);
    const freshAgentDelivery = activeMessageState.options?.internalOrigin?.kind === 'agent-message'
        && !!activeMessageState.options.internalOrigin.deliveryId && !existingMessageId;
    const freshAgentDeliveryStopWon = () => freshAgentDelivery && (stopRequestedBeforeDispatch
        || managed.stopRequested === true
        || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpochBeforeDispatch);
    const stoppedDirectHumanError = () => new Error('The message was cancelled by Stop; resend it after the session is idle');
    const stoppedFreshAgentDeliveryError = () => new Error('The agent delivery was cancelled by Stop before acknowledgement; the sender may retry it');
    if (directHumanStopWon())
        throw stoppedDirectHumanError();
    if (freshAgentDeliveryStopWon())
        throw stoppedFreshAgentDeliveryError();
    const refusedContinuation = applyMessageContinuationAuthority({
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
    });
    if (refusedContinuation) {
        await refusedContinuation;
        return;
    }
    const sourceActivationOrigin = activeMessageState.options?.internalOrigin?.kind === 'source-activation'
        ? activeMessageState.options.internalOrigin as SourceActivationOrigin
        : undefined;
    const sourceActivationStillCurrent = (): boolean => {
        if (!sourceActivationOrigin)
            return true;
        if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.sessions.get(sessionId) !== managed || managed.stopRequested
            || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== sourceActivationCancellationEpochAtEntry
            || !isSourceActivationOriginCurrent(managed.activeObjective, sourceActivationOrigin)
            || queuedDirectHumanContinuationIndex(managed) >= 0)
            return false;
        if (!authenticatedSourceActivation)
            return true;
        const pending = managed.autoRetryPending;
        return !!pending && pending.dispatchToken === sourceActivationDispatchToken
            && !pending.cancelled && (pending.dispatchInFlight || pending.committed)
            && pending.cancellationEpoch === sourceActivationCancellationEpochAtEntry;
    };
    if (!managed.stopRequested && !managed.isProcessing
        && existingMessageId && directHumanContinuation
        && sessionOpCancelPendingAuthForHumanContinuation(sessionOperationContext, managed)) {
        // The cancellation and the accepted continuation must survive together.
        // Otherwise another restart reconstructs the auth handoff and strands the
        // already-durable user row behind it again.
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        if (sessionOperationContext.state.shuttingDown || sessionOperationContext.state.sessions.get(sessionId) !== managed || managed.stopRequested
            || (queuedDispatchToken !== undefined && sessionOperationContext.state.queuedMessageDispatches.get(sessionId) !== queuedDispatchToken))
            return;
    }
    // A Retry of a restored permission inbox uses its original delivery options.
    // Its exact private dequeue token authenticates that user
    // intent; no public option or message text can mint the exemption.
    const authorizedRetryDispatch = ownsQueuedDispatch && sessionOperationContext.state.permissionInboxRetryDispatches.has(queuedDispatchToken!);
    const autonomousMessage = (sessionOpIsAutonomousMessage(sessionOperationContext, activeMessageState.options) || recoveredCleanRetryAtEntry)
        && !authorizedRetryDispatch;
    // processNextQueuedMessage authenticates a typed upward result before it
    // reserves the dequeue. Recompute the same proof here against the owned
    // dispatch: sendMessage is a second admission boundary and must neither
    // lose that narrowly-scoped dependency release nor trust a caller-supplied
    // message type without the durable queued receipt.
    const actionableUpwardSenderId = ownsQueuedDispatch && queuedItem
        ? sessionOpReleasableUpwardAgentDeliverySenderId(sessionOperationContext, managed, queuedItem, queuedDispatchToken)
        : undefined;
    const staleTypedUpwardDelivery = ownsQueuedDispatch && queuedItem
        ? sessionOpIsStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, queuedItem, queuedDispatchToken)
        : false;
    if (autonomousMessage && staleTypedUpwardDelivery && queuedItem) {
        await sessionOpQuarantineStaleTypedUpwardAgentDelivery(sessionOperationContext, managed, queuedItem, queuedDispatchToken);
        return;
    }
    const admissionBlocked = autonomousMessage
        && !sessionOperationContext.owner["claimAutomaticAdmission"](managed, actionableUpwardSenderId);
    const ownsLiveDirectDispatch = ownsQueuedDispatch && !!existingMessageId && directHumanContinuation
        && !!sessionOperationContext.state.liveDirectHumanContinuationIds.get(managed)?.has(existingMessageId);
    const queuedUserInputBlocked = hasPendingLocalUserInput(managed)
        || (!ownsLiveDirectDispatch && sessionOperationContext.owner["hasPendingUserInput"](managed));
    if (ownsQueuedDispatch && (admissionBlocked || managed.stopRequested || queuedUserInputBlocked || sessionOpHasPendingDecision(sessionOperationContext, managed))) {
        if (!managed.messageQueue.some(item => existingMessageId ? item.messageId === existingMessageId : item.message === activeMessageState.message)) {
            managed.messageQueue.unshift(queuedItem ?? { message: activeMessageState.message, ...(attachments !== undefined ? { attachments: attachments } : {}), ...(storedAttachments !== undefined ? { storedAttachments: storedAttachments } : {}), ...(activeMessageState.options !== undefined ? { options: activeMessageState.options } : {}), ...(existingMessageId !== undefined ? { messageId: existingMessageId } : {}) });
        }
        sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        if (!managed.isProcessing)
            sessionOperationContext.owner["sendEvent"]({ type: 'complete', sessionId, reason: 'interrupted', tokenUsage: managed.tokenUsage }, managed.workspace.id);
        return;
    }
    if (ownsQueuedDispatch && existingMessageId && directHumanContinuation) {
        sessionOpConsumeLiveDirectHumanContinuation(sessionOperationContext, managed, existingMessageId);
    }
    const {
        explicitRetry,
        retryWithRetainedInbox,
        explicitRetryIntent,
        cleanExplicitRetry,
        cleanRetryWithRetainedMachineInbox,
        explicitRetryContextLimitRequest,
        explicitRetryContextLimitRequestBefore,
        trustedUserInput,
    } = resolveMessageRetryAdmission({
        activeMessageState,
        sessionOperationContext,
        managed,
        explicitRetryIntentAtEntry,
        existingMessageId,
        sessionId,
        explicitRetryAllowanceToken,
    });
    if (trustedUserInput && (trustedUserInput.objectiveUserMessageId !== managed.activeObjective?.userMessageId
        || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))) {
        const staleMessage = managed.messages.find(candidate => candidate.id === existingMessageId);
        if (staleMessage)
            staleMessage.isQueued = false;
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        throw new Error('The answer belongs to an objective that is no longer active');
    }
    if (!existingMessageId && !activeMessageState.options?.internalOrigin
        && !activeMessageState.options?.automaticRecovery && !activeMessageState.options?.hidden) {
        activeMessageState.message = await applyOperationsTurnPolicy(
            sessionOperationContext, managed, activeMessageState.message,
        );
    }
    const deliveryId = activeMessageState.options?.internalOrigin?.deliveryId;
    if (deliveryId && !existingMessageId) {
        const previous = managed.messages.find(m => m.agentDelivery?.id === deliveryId);
        if (previous) {
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            onAck?.(previous.id);
            return;
        }
    }
    // If currently processing, behavior depends on the connection's
    // `midStreamBehavior` (resolved via {@link resolveMidStreamBehavior},
    // defaults to provider-appropriate value):
    //
    // - 'steer': try to deliver text into the in-flight turn. Pi steers natively;
    //   Claude aborts the old turn so the complete message is queued for replay.
    //   If an invoked backend returns false, it has stopped the old runtime
    //   and the host queues the full message for replay.
    // - 'queue': hold the message untouched; the current turn keeps running
    //   to natural completion; replay as a new turn afterwards. NO call to
    //   `agent.redirect()`, NO forceAbort, NO interruption.
    const forceDirectHumanQueue = directHumanContinuation
        && (hasPendingLocalUserInput(managed) || sessionOpHasQueuedUserInput(sessionOperationContext, managed) || sessionOpHasPendingDecision(sessionOperationContext, managed));
    // A hard-cost continuation is authority for one provider admission, not an
    // extra conversational turn. If a typed agent delivery already owns the
    // FIFO head, retain the answer immediately behind the inbox so that exact
    // delivery can consume the authority instead of spending it first on the
    // hidden answer and then getting blocked itself.
    const queueCostLimitContinuationBehindDelivery = !!trustedUserInput
        && isCostLimitContinuationAnswer(trustedUserInput)
        && !!managed.messageQueue[0]
        && !!sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, managed.messageQueue[0]);
    const waitingForInbox = !existingMessageId && !ownsQueuedDispatch && !managed.isProcessing
        && (!!deliveryId || admissionBlocked || !cleanRetryWithRetainedMachineInbox
            && (managed.messageQueue.length > 0 || sessionOperationContext.state.queuedMessageDispatches.has(sessionId))
            || forceDirectHumanQueue);
    // The supersession/auth checks above can also yield. From this final guard
    // to either queue append or live-turn ownership there is no await, closing
    // the terminalization race without reopening the completed objective.
    assertFreshAgentDeliveryTargetActive();
    if (authenticatedInternalContinuationToken && (managed.isProcessing || waitingForInbox)) {
        sessionOpConsumeAuthenticatedInternalContinuation(sessionOperationContext, authenticatedInternalContinuationToken);
        throw new InternalContinuationSupersededError('The authenticated internal continuation cannot be queued behind another turn.');
    }
    if (managed.isProcessing || waitingForInbox || queueCostLimitContinuationBehindDelivery) {
        return enqueueSessionMessage({
            existingMessageId,
            trustedUserInput,
            managed,
            message: activeMessageState.message,
            attachments,
            storedAttachments,
            options: activeMessageState.options,
            sessionOperationContext,
            queuedDispatchToken,
            sessionId,
            onAck,
            waitingForInbox,
            forceDirectHumanQueue,
            durableMessageId,
            deliveryId,
            authenticatedSourceActivation,
            sourceActivationDispatchToken,
            stoppedFreshAgentDeliveryError,
            directHumanContinuation,
            stoppedDirectHumanError,
            directHumanStopWon,
            freshAgentDeliveryStopWon,
            sourceActivationOrigin,
            sourceActivationStillCurrent,
            queueCostLimitContinuationBehindDelivery,
        });
    }
    // Add user message with stored attachments for persistence
    // Skip if existingMessageId is provided (message was already created when queued)
    // Reserve ownership before the first durability await, including the fresh
    // message flush. A stopped send must never adopt its replacement's generation.
    const turnInput = await prepareSessionMessageTurn({
        managed,
        supersedableAutomaticRecovery,
        activeMessageState,
        sessionOperationContext,
        assertAuthenticatedInternalContinuation,
        sourceActivationStillCurrent,
        automaticRecoverySuperseded,
        autonomousMessage,
        cleanExplicitRetry,
        cancellationEpochBeforeDispatch,
        removeSyntheticAutomaticMessage,
        sessionId,
        authenticatedInternalContinuationToken,
        explicitRetry,
        existingMessageId,
        trustedUserInput,
        explicitRetryAllowanceToken,
        durableMessageId,
        storedAttachments,
        explicitRetryIntent,
        explicitRetryContextLimitRequest,
        explicitRetryContextLimitRequestBefore,
        authenticatedSourceActivation,
        sourceActivationDispatchToken,
        sourceActivationOrigin,
        restoreStartedAutomaticDispatch,
        queuedItem,
        attachments,
        directHumanContinuation,
        directHumanStopWon,
        freshAgentDeliveryStopWon,
        lastMessageRoleBeforeDispatch,
        stoppedFreshAgentDeliveryError,
        stoppedDirectHumanError,
        onAck,
        finishSupersededAutomaticRecovery,
        queuedAgentDeliveryDispatch,
        queuedDispatchToken,
        _isAuthRetry,
        ownsQueuedDispatch,
        retryWithRetainedInbox,
        delegatedDispatchContinuationToken,
    });
    if (!turnInput) return;
    if (!turnInput.ownsActiveTurn()) {
        await turnInput.abandonStoppedTurn();
        return;
    }
    return runSessionMessageTurn(turnInput);
}

export { sessionOpPerformSendMessage as performSendMessage };
