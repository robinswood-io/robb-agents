import { reuseSessionUserMessage } from './reuse-session-user-message.ts';
import { createNewSessionUserMessage } from './create-new-session-user-message.ts';
import type { UserMessagePreparationInput } from './user-message-preparation-input.ts';
import { persistenceRootFor } from '../policy.ts';
import { restoreAgentDeliveryAttachments } from '../../agent-delivery.ts';
import { readFileAttachment } from '@craft-agent/shared/utils';
import { createPendingTurnRecovery } from '../../turn-recovery';
import { sessionLog } from '../runtime-platform.ts';
import { AutomaticRecoverySupersededError, AutonomousAdmissionDeferredError, InternalContinuationSupersededError, SourceActivationSupersededError } from '../runtime-policy.ts';
import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { consumeAuthenticatedInternalContinuation as sessionOpConsumeAuthenticatedInternalContinuation, claimAuthenticatedInternalContinuation as sessionOpClaimAuthenticatedInternalContinuation } from './message-authority.ts';
import { startRecoveryDispatch as sessionOpStartRecoveryDispatch } from './start-recovery-dispatch.ts';
import { autonomousAdmissionBlock as sessionOpAutonomousAdmissionBlock } from './exact-user-input-response.ts';
import { evaluateAndApplyAutoLabels as sessionOpEvaluateAndApplyAutoLabels } from './perform-adopt-generated-task-orchestrator.ts';
import type { MessageTurnPreparationInput } from './message-turn-preparation-input.ts';
import type { SessionMessageTurnInput } from './session-message-turn-input.ts';

export async function prepareSessionMessageTurn(
    input: MessageTurnPreparationInput
): Promise<SessionMessageTurnInput | undefined> {
    const {
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
    } = input;
    let attachments = input.attachments;
// Add user message with stored attachments for persistence
    // Skip if existingMessageId is provided (message was already created when queued)
    // Reserve ownership before the first durability await, including the fresh
    // message flush. A stopped send must never adopt its replacement's generation.
    const myGeneration = managed.processingGeneration + 1;
    if (supersedableAutomaticRecovery)
        activeMessageState.automaticDispatchGeneration = myGeneration;
    const diagnosticFromMessageCount = managed.messages.length;
    const ownsActiveTurn = () => !sessionOperationContext.state.shuttingDown && managed.processingGeneration === myGeneration
        && managed.isProcessing && !managed.stopRequested;
    // Recovery persistence yields; Stop or a newer human turn can take ownership
    // before it returns. Neither a late error nor completion may modify that turn.
    const recoveryHandoffPaused = () => !ownsActiveTurn()
        || sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed);
    const assertActivePreparation = () => {
        if (!ownsActiveTurn())
            throw new Error('Turn preparation was cancelled');
        sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
        assertAuthenticatedInternalContinuation();
        if (!sourceActivationStillCurrent()) {
            throw new SourceActivationSupersededError('Source activation was superseded');
        }
        if (automaticRecoverySuperseded()) {
            throw new AutomaticRecoverySupersededError('Automatic recovery was superseded');
        }
        if (autonomousMessage && sessionOpAutonomousAdmissionBlock(sessionOperationContext, managed, false, false)) {
            throw new AutonomousAdmissionDeferredError('Automatic turn retained while its ancestor requires attention');
        }
    };
    const abandonStoppedTurn = async () => {
        // Stop can win while the freshly appended hidden recovery is awaiting
        // its first durable flush.  That row has no FIFO message id for
        // cancelProcessing() to remove, so clean up the exact object created by
        // this dispatch and flush the deletion before publishing the stop.  The
        // cancellation epoch remains authoritative even if the stop timeout has
        // already reset stopRequested while this I/O was stalled.
        const stoppedAutomaticRecovery = (supersedableAutomaticRecovery || cleanExplicitRetry)
            && (sessionOperationContext.state.shuttingDown
                || managed.stopRequested
                || (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== cancellationEpochBeforeDispatch);
        if (stoppedAutomaticRecovery && removeSyntheticAutomaticMessage()) {
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(sessionId);
        }
        if (managed.processingGeneration === myGeneration && managed.isProcessing) {
            await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'interrupted', myGeneration);
        }
    };
    const resetProviderResumeStateForCleanBoundary = (boundaryMessageId: string) => {
        managed.sdkSessionId = undefined;
        managed.branchFromSdkSessionId = undefined;
        managed.branchFromSessionPath = undefined;
        managed.branchFromSdkCwd = undefined;
        managed.branchFromSdkTurnId = undefined;
        managed.branchContextStrategy = undefined;
        managed.branchSeedApplied = true;
        managed.providerContextBoundaryMessageId = boundaryMessageId;
        managed.contextCompactionAttempt = undefined;
        managed.transferredSessionSummary = undefined;
        managed.transferredSessionSummaryApplied = undefined;
        if (managed.tokenUsage) {
            managed.tokenUsage = {
                ...managed.tokenUsage,
                contextTokens: Math.max(1, Math.ceil(activeMessageState.message.length / 4)),
            };
        }
    };
    assertAuthenticatedInternalContinuation();
    if (authenticatedInternalContinuationToken && !sessionOpClaimAuthenticatedInternalContinuation(sessionOperationContext, authenticatedInternalContinuationToken, managed, myGeneration)) {
        sessionOpConsumeAuthenticatedInternalContinuation(sessionOperationContext, authenticatedInternalContinuationToken);
        throw new InternalContinuationSupersededError('The authenticated internal continuation capability was already consumed.');
    }
    if (activeMessageState.options?.automaticRecovery && !explicitRetry) {
        const originalUserMessageId = activeMessageState.options.automaticRecovery.originalUserMessageId;
        if (managed.pendingTurnRecovery?.userMessageId !== originalUserMessageId) {
            managed.pendingTurnRecovery = createPendingTurnRecovery(originalUserMessageId);
            sessionLog.warn('Recreated missing automatic-recovery marker', {
                sessionId,
                originalUserMessageId,
            });
        }
        managed.pendingTurnRecovery = sessionOpStartRecoveryDispatch(sessionOperationContext, managed.pendingTurnRecovery, activeMessageState.options.automaticRecovery);
    }
    const userMessagePreparationInput: UserMessagePreparationInput = {
        managed,
        existingMessageId,
        supersedableAutomaticRecovery,
        activeMessageState,
        sessionOperationContext,
        explicitRetry,
        trustedUserInput,
        explicitRetryAllowanceToken,
        ownsActiveTurn,
        sessionId,
        myGeneration,
        assertAuthenticatedInternalContinuation,
        durableMessageId,
        storedAttachments,
        cleanExplicitRetry,
        explicitRetryIntent,
        diagnosticFromMessageCount,
        explicitRetryContextLimitRequest,
        resetProviderResumeStateForCleanBoundary,
        explicitRetryContextLimitRequestBefore,
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
    };
    const preparedUserMessage = existingMessageId
        ? reuseSessionUserMessage(userMessagePreparationInput)
        : await createNewSessionUserMessage(userMessagePreparationInput);
    if (!preparedUserMessage)
        return;
    const { userMessage, existingTurnRollback, cleanExplicitRetrySetupRollback } = preparedUserMessage;
    const { durablyAcknowledged, cleanRecoveryProviderStateAtomized } = preparedUserMessage;
    if (!existingMessageId && !ownsActiveTurn()) {
        await abandonStoppedTurn();
        return;
    }
    // Evaluate auto-label rules against the user message (common path for both
    // fresh and queued messages). Scans regex patterns configured on labels,
    // then merges any new matches into the session's label array.
    sessionOpEvaluateAndApplyAutoLabels(sessionOperationContext, managed, activeMessageState.message);
    if (!attachments && existingMessageId && userMessage.attachments?.length && !userMessage.agentDelivery?.attachmentsSha256) {
        attachments = userMessage.attachments.map(stored => {
            const attachment = readFileAttachment(stored.storedPath);
            if (!attachment)
                throw new Error(`The saved attachment is unavailable: ${stored.name}`);
            return { ...attachment, type: stored.type, name: stored.name, mimeType: stored.mimeType,
                storedPath: stored.storedPath, markdownPath: stored.markdownPath,
                ...(stored.resizedBase64 ? { base64: stored.resizedBase64 } : {}) };
        });
    }
    if (!attachments && userMessage.agentDelivery?.attachmentsSha256) {
        attachments = restoreAgentDeliveryAttachments(persistenceRootFor(managed), managed.id, userMessage.agentDelivery.attachmentsSha256);
    }
    return {
        attachments,
        activeMessageState,
        managed,
        sessionOperationContext,
        userMessage,
        queuedAgentDeliveryDispatch,
        queuedItem,
        queuedDispatchToken,
        sessionId,
        myGeneration,
        trustedUserInput,
        explicitRetry,
        assertActivePreparation,
        ownsActiveTurn,
        abandonStoppedTurn,
        finishSupersededAutomaticRecovery,
        _isAuthRetry,
        storedAttachments,
        durablyAcknowledged,
        cleanExplicitRetry,
        resetProviderResumeStateForCleanBoundary,
        cleanRecoveryProviderStateAtomized,
        directHumanContinuation,
        ownsQueuedDispatch,
        removeSyntheticAutomaticMessage,
        existingTurnRollback,
        diagnosticFromMessageCount,
        existingMessageId,
        retryWithRetainedInbox,
        onAck,
        restoreStartedAutomaticDispatch,
        sourceActivationOrigin,
        authenticatedInternalContinuationToken,
        delegatedDispatchContinuationToken,
        cleanExplicitRetrySetupRollback,
        lastMessageRoleBeforeDispatch,
        recoveryHandoffPaused,
    };
}
