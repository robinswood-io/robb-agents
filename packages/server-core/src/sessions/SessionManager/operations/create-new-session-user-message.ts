import type { SessionEvent } from '../../../../../shared/src/protocol/dto/session-events.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { prepareCleanRetryUserMessage } from './prepare-clean-retry-user-message.ts';
import { cancelSourceActivationPending, commitSourceActivationPending, releaseSourceActivationClaim } from '../policy.ts';
import type { Message } from '@craft-agent/core/types';
import { sanitizeForTitle } from '@craft-agent/server-core/domain';
import { sessionLog } from '../runtime-platform.ts';
import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { trackSyntheticAutomaticMessage as sessionOpTrackSyntheticAutomaticMessage } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { scheduleTitleGeneration as sessionOpScheduleTitleGeneration } from './schedule-title-generation.ts';
import type { UserMessagePreparationInput, PreparedUserMessage } from './user-message-preparation-input.ts';

export async function createNewSessionUserMessage(
    userMessagePreparationInput: UserMessagePreparationInput
): Promise<PreparedUserMessage | undefined> {
    const {
        managed,
        existingMessageId,
        supersedableAutomaticRecovery,
        activeMessageState,
        sessionOperationContext,
        ownsActiveTurn,
        sessionId,
        myGeneration,
        assertAuthenticatedInternalContinuation,
        durableMessageId,
        storedAttachments,
        cleanExplicitRetry,
        explicitRetryIntent,
        resetProviderResumeStateForCleanBoundary,
        authenticatedSourceActivation,
        sourceActivationDispatchToken,
        removeSyntheticAutomaticMessage,
        sourceActivationOrigin,
        restoreStartedAutomaticDispatch,
        queuedItem,
        attachments,
        abandonStoppedTurn,
        directHumanContinuation,
        directHumanStopWon,
        freshAgentDeliveryStopWon,
        lastMessageRoleBeforeDispatch,
        stoppedFreshAgentDeliveryError,
        stoppedDirectHumanError,
        sourceActivationStillCurrent,
        onAck,
        finishSupersededAutomaticRecovery,
    } = userMessagePreparationInput;
    let userMessage: Message;
    let existingTurnRollback: (() => void) | undefined;
    let cleanExplicitRetrySetupRollback: (() => string | undefined) | undefined;
    let durablyAcknowledged = false;
    let cleanRecoveryProviderStateAtomized = false;
// Create new message
    userMessage = omitUndefined<Message>({
        // Bind a deferred automatic recovery to its durable dispatch identity.
        // Cold restore can then distinguish it from every other hidden message
        // without trusting prompt text.
        id: durableMessageId(),
        role: 'user',
        content: activeMessageState.message,
        timestamp: sessionOpMonotonic(sessionOperationContext),
        ...(storedAttachments !== undefined ? { attachments: storedAttachments } : {}), // Include for persistence (has thumbnailBase64)
        ...(!activeMessageState.options?.hidden ? { isQueued: true } : {}),
        badges: activeMessageState.options?.badges, // Include content badges (sources, skills with embedded icons)
        // Hidden system-generated messages reach the model but never render as a
        // transcript bubble (e.g. background-task-completion nudge).
        ...(activeMessageState.options?.hidden ? { hidden: true } : {}),
        ...(activeMessageState.options?.internalOrigin ? { internalOrigin: activeMessageState.options.internalOrigin } : {}),
        ...(activeMessageState.options?.internalOrigin?.deliveryId ? {
            isQueued: true,
            agentDelivery: { id: activeMessageState.options.internalOrigin.deliveryId, status: 'queued' as const, attempts: 0, ...(activeMessageState.options.internalOrigin.attachmentsSha256 !== undefined ? { attachmentsSha256: activeMessageState.options.internalOrigin.attachmentsSha256 } : {}) },
        } : {}),
    });
    managed.messages.push(userMessage);
    if (cleanExplicitRetry) {
        ({ existingTurnRollback, cleanRecoveryProviderStateAtomized } = prepareCleanRetryUserMessage(userMessagePreparationInput, userMessage));
    }
    if (!cleanExplicitRetry && supersedableAutomaticRecovery) {
        const dispatch = managed.pendingTurnRecovery?.recoveryDispatch;
        if (dispatch?.cleanContinuationId) {
            let exactCleanBoundary = dispatch.phase === 'started'
                && dispatch.id === userMessage.id
                && activeMessageState.options?.automaticRecovery?.dispatchId === dispatch.id;
            if (exactCleanBoundary) {
                try {
                    exactCleanBoundary = activeMessageState.message === sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, managed.pendingTurnRecovery!, dispatch);
                }
                catch {
                    exactCleanBoundary = false;
                }
            }
            if (!exactCleanBoundary) {
                managed.messages.splice(managed.messages.indexOf(userMessage), 1);
                throw new Error('The automatic clean recovery boundary failed its durable dispatch authentication');
            }
            // Automatic clean continuations need the same crash boundary as an
            // explicit context-limit Retry: the started row and the detached
            // provider state become durable in one first snapshot. A process
            // death after that write can never reload the discarded context.
            resetProviderResumeStateForCleanBoundary(userMessage.id);
            cleanRecoveryProviderStateAtomized = true;
        }
    }
    const pendingSourceActivationForStart = managed.autoRetryPending;
    if (authenticatedSourceActivation && pendingSourceActivationForStart
        && pendingSourceActivationForStart.dispatchToken === sourceActivationDispatchToken) {
        pendingSourceActivationForStart.messageId = userMessage.id;
    }
    if (supersedableAutomaticRecovery || cleanExplicitRetry) {
        activeMessageState.syntheticAutomaticMessage = userMessage;
        sessionOpTrackSyntheticAutomaticMessage(sessionOperationContext, managed, userMessage);
    }
    // Reserve the turn before the first durability await. Concurrent sends
    // must queue instead of starting two recipient turns during this flush.
    sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
    managed.processingGeneration = myGeneration;
    sessionOperationContext.owner["setProcessing"](managed, true);
    sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
    assertAuthenticatedInternalContinuation();
    if (authenticatedSourceActivation && pendingSourceActivationForStart
        && pendingSourceActivationForStart.dispatchToken === sourceActivationDispatchToken) {
        // A fresh restart now owns this generation. If its first durability
        // fence fails, the bounded retry must compare against that rolled-back
        // idle generation rather than the provider generation that minted it.
        pendingSourceActivationForStart.generation = myGeneration;
    }
    // Update lastMessageRole for badge display. Skip for hidden messages so the
    // session-list preview isn't briefly driven by an invisible system nudge.
    if (!activeMessageState.options?.hidden) {
        managed.lastMessageRole = 'user';
    }
    // Persist + flush before announcing — the user message must be
    // genuinely on disk before we tell the renderer "accepted", and
    // `persistSession` is debounced (500ms). #616.
    try {
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('The provider boundary could not be queued for durable storage');
        }
        await sessionOperationContext.owner.flushSession(managed.id);
    }
    catch (error) {
        if (ownsActiveTurn()) {
            if (cleanExplicitRetry)
                existingTurnRollback?.();
            // A failed first flush acknowledged neither storage nor provider
            // delivery. Remove and untrack only this synthetic recovery so a
            // later unrelated save cannot make the rejected attempt durable.
            removeSyntheticAutomaticMessage();
            if (sourceActivationOrigin) {
                const sourceIndex = managed.messages.indexOf(userMessage);
                if (sourceIndex >= 0)
                    managed.messages.splice(sourceIndex, 1);
                releaseSourceActivationClaim(managed, sourceActivationDispatchToken);
            }
            if (restoreStartedAutomaticDispatch()) {
                const replay = queuedItem ?? { message: activeMessageState.message, attachments, storedAttachments, options: activeMessageState.options };
                const replayRecovery = replay.options?.automaticRecovery;
                const alreadyQueued = managed.messageQueue.some(item => {
                    const candidate = item.options?.automaticRecovery;
                    return !!candidate && !!replayRecovery
                        && (replayRecovery.dispatchId
                            ? candidate.dispatchId === replayRecovery.dispatchId
                            : candidate.cause === replayRecovery.cause
                                && candidate.originalUserMessageId === replayRecovery.originalUserMessageId
                                && item.message === replay.message);
                });
                if (!alreadyQueued) {
                    managed.messageQueue.unshift(replay);
                }
                sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
            }
            sessionOperationContext.owner["setProcessing"](managed, false);
            sessionOperationContext.owner["persistSession"](managed);
            try {
                await sessionOperationContext.owner.flushSession(managed.id);
            }
            catch (cleanupError) {
                sessionLog.warn('Failed to flush automatic recovery first-write rollback', {
                    sessionId,
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
            }
        }
        else
            await abandonStoppedTurn();
        throw error;
    }
    if ((directHumanContinuation && !existingMessageId && directHumanStopWon())
        || freshAgentDeliveryStopWon()) {
        // This turn owned isProcessing before its first durability ACK and had
        // no FIFO row for Stop's partition sweep. Do not acknowledge a message
        // that Stop has already cancelled: remove the exact pre-provider row,
        // fsync its deletion, then let the stopped generation finish cleanup.
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
        const messageIndex = managed.messages.indexOf(userMessage);
        if (messageIndex >= 0)
            managed.messages.splice(messageIndex, 1);
        if (directHumanContinuation)
            managed.lastMessageRole = lastMessageRoleBeforeDispatch;
        if (!sessionOperationContext.owner["persistSession"](managed)) {
            throw new Error('The stopped pre-acknowledgement message could not be removed from durable storage');
        }
        await sessionOperationContext.owner.flushSession(managed.id);
        await abandonStoppedTurn();
        if (freshAgentDeliveryStopWon())
            throw stoppedFreshAgentDeliveryError();
        throw stoppedDirectHumanError();
    }
    try {
        assertAuthenticatedInternalContinuation();
    }
    catch (error) {
        const index = managed.messages.indexOf(userMessage);
        if (index >= 0)
            managed.messages.splice(index, 1);
        if (managed.processingGeneration === myGeneration)
            sessionOperationContext.owner["setProcessing"](managed, false);
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        // A newer human turn may have entered the durable FIFO while this
        // hidden auth-result row was being flushed. Releasing only the stale
        // generation would otherwise leave that accepted turn stranded until
        // an unrelated event happens to poke the queue.
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }
        throw error;
    }
    if (activeMessageState.options?.internalOrigin?.kind === 'agent-message' && !existingMessageId
        && sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)) {
        const terminalState = managed.activeObjective?.terminalState;
        const messageIndex = managed.messages.indexOf(userMessage);
        const untouchedQueuedReceipt = messageIndex >= 0
            && userMessage.isQueued === true && userMessage.agentDelivery?.status === 'queued';
        if (untouchedQueuedReceipt) {
            managed.messages.splice(messageIndex, 1);
            if (managed.processingGeneration === myGeneration && managed.isProcessing) {
                sessionOperationContext.owner["setProcessing"](managed, false);
            }
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        throw new Error(`Target session objective is terminal (${terminalState}); no agent message was queued. Reuse its completed result. A new delegation is valid only when the objective or version genuinely changed, and grants no new authority.`);
    }
    // This ACK confirms storage only. Stop may have cancelled execution while
    // the flush was pending; the saved user message must still be acknowledged.
    durablyAcknowledged = true;
    if (sourceActivationOrigin) {
        const sourceAccepted = sourceActivationStillCurrent()
            && (!authenticatedSourceActivation
                || commitSourceActivationPending(managed, sourceActivationDispatchToken, userMessage.id));
        if (!sourceAccepted) {
            const sourceIndex = managed.messages.indexOf(userMessage);
            if (sourceIndex >= 0)
                managed.messages.splice(sourceIndex, 1);
            cancelSourceActivationPending(managed);
            sessionOperationContext.owner["setProcessing"](managed, false);
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            if (managed.messageQueue.length > 0)
                sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
            return;
        }
    }
    onAck?.(userMessage.id);
    if (!ownsActiveTurn()) {
        await abandonStoppedTurn();
        return;
    }
    if (await finishSupersededAutomaticRecovery())
        return;
    if (cleanExplicitRetry) {
        // The first snapshot is now acknowledged: from this point onward a
        // setup failure must retain the newly granted Retry and detached
        // provider boundary, not restore the stale pre-Retry context.
        cleanExplicitRetrySetupRollback = () => {
            if (!ownsActiveTurn())
                return undefined;
            const pending = managed.pendingTurnRecovery;
            const started = pending?.recoveryDispatch;
            if (!pending || started?.phase !== 'started'
                || started.id !== userMessage.id
                || started.id !== activeMessageState.options?.automaticRecovery?.dispatchId
                || started.cleanContinuationId !== activeMessageState.options?.automaticRecovery?.cleanContinuationId) {
                return undefined;
            }
            removeSyntheticAutomaticMessage();
            const allocated = { ...started, phase: 'allocated' as const };
            delete allocated.startedAt;
            managed.pendingTurnRecovery = { ...pending, recoveryDispatch: allocated };
            managed.messageQueue = managed.messageQueue.filter(item => (item.messageId !== allocated.id
                && item.options?.automaticRecovery?.dispatchId !== allocated.id));
            sessionOperationContext.owner["setProcessing"](managed, false);
            sessionOperationContext.owner["persistSession"](managed);
            return allocated.id;
        };
        if (explicitRetryIntent?.grantNewAllowance !== false) {
            // A fresh, durable user Retry supersedes an in-memory fence left by a
            // prior failed fsync. Never clear that fence before this ACK.
            sessionOperationContext.state.cleanRetrySetupPersistenceFences.delete(managed.id);
        }
    }
    // Emit user_message event so UI can confirm the optimistic message
    sessionOperationContext.owner["sendEvent"](omitUndefined<Extract<SessionEvent, { type: 'user_message' }>>({
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: 'accepted',
        optimisticMessageId: activeMessageState.options?.optimisticMessageId
    }), managed.workspace.id);
    // If this is the first user message and no title exists, set one immediately
    // AI generation will enhance it later, but we always have a title from the start
    // Automation sessions (triggeredBy set) already have a title and skip AI generation entirely
    const isFirstUserMessage = managed.messages.filter(m => m.role === 'user').length === 1;
    if (isFirstUserMessage && !managed.name && !managed.triggeredBy) {
        // Replace bracket mentions with their display labels (e.g. [skill:ws:commit] -> "Commit")
        // so titles show human-readable names instead of raw IDs
        let titleSource = activeMessageState.message;
        if (activeMessageState.options?.badges) {
            for (const badge of activeMessageState.options.badges) {
                if (badge.rawText && badge.label) {
                    titleSource = titleSource.replace(badge.rawText, badge.label);
                }
            }
        }
        // Sanitize: strip any remaining bracket mentions, XML blocks, tags
        const sanitized = sanitizeForTitle(titleSource);
        const initialTitle = sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '');
        managed.name = initialTitle;
        sessionOperationContext.owner["persistSession"](managed);
        // Flush immediately so disk is authoritative before notifying renderer
        try {
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        catch (error) {
            if (durablyAcknowledged && !ownsActiveTurn()) {
                await abandonStoppedTurn();
                return;
            }
            throw error;
        }
        if (!ownsActiveTurn()) {
            await abandonStoppedTurn();
            return;
        }
        sessionOperationContext.owner["sendEvent"]({
            type: 'title_generated',
            sessionId,
            title: initialTitle,
        }, managed.workspace.id);
        // Generate AI title asynchronously using agent's SDK
        // (waits briefly for agent creation if needed)
        sessionOpScheduleTitleGeneration(sessionOperationContext, managed, activeMessageState.message);
    }
    return { userMessage, existingTurnRollback, cleanExplicitRetrySetupRollback, durablyAcknowledged, cleanRecoveryProviderStateAtomized };
}
