import { createContextLimitAnswerRollback } from './context-limit-answer-rollback.ts';
import { nextRecoveryDispatch, projectLegacyObjectiveForUserTransition, rehydrateObjectiveEvidence } from '../policy.ts';
import type { UserInputRequest } from '@craft-agent/core';
import { bindBusinessProcedure } from '../../business-procedures';
import { createPendingTurnRecovery } from '../../turn-recovery';
import { isHostSyntheticObjectiveText, transitionObjectiveContract } from '../../objective-contract';
import { delegatedObjectiveRoleForSession, isTerminalReviewSession } from '../review-lifecycle.ts';
import { sessionLog } from '../runtime-platform.ts';
import { CleanRecoveryDispatchAuthenticationError } from '../runtime-policy.ts';
import { isExactContextLimitNextStepQuestion } from '../user-input-authority.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { startRecoveryDispatch as sessionOpStartRecoveryDispatch } from './start-recovery-dispatch.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';
import { hasConsumedCleanRecoveryDispatch as sessionOpHasConsumedCleanRecoveryDispatch } from './create-autonomous-context-limit-handoff.ts';
import { completeQueuedAgentDeliveryDispatch as sessionOpCompleteQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { contextLimitHostAdmissionBoundary as sessionOpContextLimitHostAdmissionBoundary } from './perform-request-user-input.ts';
import { captureUserCorrection as sessionOpCaptureUserCorrection, loadSessionPlaybook as sessionOpLoadSessionPlaybook } from './capture-user-correction.ts';
import { objectiveContractTextFor as sessionOpObjectiveContractTextFor } from './try-refresh-agent-runtime.ts';
import type { ObjectiveAdmissionInput, AdmittedSessionObjective } from './objective-admission-input.ts';

export async function admitSessionMessageObjective(
    objectiveAdmissionInput: ObjectiveAdmissionInput
): Promise<AdmittedSessionObjective | undefined> {
    const {
        managed,
        activeMessageState,
        trustedUserInput,
        sessionOperationContext,
        userMessage,
        localCompactCommand,
        ownsActiveTurn,
        abandonStoppedTurn,
        explicitRetry,
        cleanExplicitRetry,
        resetProviderResumeStateForCleanBoundary,
        cleanRecoveryProviderStateAtomized,
        sessionId,
        queuedDispatchToken,
        directHumanContinuation,
        ownsQueuedDispatch,
        queuedItem,
        rollbackQueuedAgentDeliveryPreparation,
        myGeneration,
        removeSyntheticAutomaticMessage,
        existingTurnRollback,
        diagnosticFromMessageCount,
        existingMessageId,
        finishSupersededAutomaticRecovery,
        assertActivePreparation,
        retryWithRetainedInbox,
        onAck,
    } = objectiveAdmissionInput;
    let trustedContextLimitAnswer: UserInputRequest | undefined;
    let contextLimitAnswerSetupRollback: (() => string | undefined) | undefined;
    let durablyAcknowledged = objectiveAdmissionInput.durablyAcknowledged;
// Persist an in-flight marker before model streaming begins. A packaged-app
    // replacement can terminate every subprocess cleanly (exit 0) without the
    // normal completion path running; this marker is the durable resume seam.
    const authenticatedInternalObjectiveRoot = !managed.activeObjective && !activeMessageState.options?.hidden
        && !activeMessageState.options?.automaticRecovery && (activeMessageState.options?.internalOrigin?.kind === 'spawned-session'
        ? !!managed.parentSessionId
            && managed.parentSessionId !== managed.id
            && activeMessageState.options.internalOrigin.senderSessionId === managed.parentSessionId
        : activeMessageState.options?.internalOrigin?.kind === 'automation'
            && !managed.parentSessionId
            && !!managed.triggeredBy);
    if (trustedUserInput) {
        // Answers refine the existing contract; keep its root, criteria and budgets.
        const contextLimitBoundary = sessionOpContextLimitHostAdmissionBoundary(sessionOperationContext, managed);
        const currentObjectiveId = managed.activeObjective?.objectiveId
            ?? managed.activeObjective?.userMessageId;
        const resumedPending = managed.pendingTurnRecovery
            ? {
                ...managed.pendingTurnRecovery,
                userMessageId: userMessage.id,
                userInputFromMessageCount: managed.messages.length,
                // This newly authenticated answer is the next provider input. Any
                // earlier continuation marker describes the pre-answer turn and
                // must not make a pre-provider crash look already consumed.
                continuationRequired: false,
            }
            : { ...createPendingTurnRecovery(userMessage.id), userInputFromMessageCount: managed.messages.length };
        // Reuse the exact request object already authenticated by
        // exactUserInputResponse. A second metadata lookup could select a corrupt
        // duplicate with the same response id and manufacture context-limit
        // authority for a different question or workspace.
        const contextLimitAnswer = trustedUserInput.hostPrompt?.schemaVersion === 1
            && trustedUserInput.hostPrompt.kind === 'context-limit-next-step'
            && trustedUserInput.objectiveUserMessageId === managed.activeObjective?.userMessageId
            && trustedUserInput.hostPrompt.objectiveId === currentObjectiveId
            && trustedUserInput.hostPrompt.recoveryDispatchId === contextLimitBoundary?.dispatchId
            && trustedUserInput.hostPrompt.issuedAt >= (contextLimitBoundary?.boundaryAt ?? Number.POSITIVE_INFINITY)
            && trustedUserInput.hostPrompt.issuedAt <= trustedUserInput.createdAt
            && Number.isFinite(trustedUserInput.answeredAt)
            && trustedUserInput.answeredAt! >= trustedUserInput.createdAt
            && isExactContextLimitNextStepQuestion(trustedUserInput)
            ? trustedUserInput
            : undefined;
        if (contextLimitAnswer) {
            trustedContextLimitAnswer = contextLimitAnswer;
            const allocated = nextRecoveryDispatch(resumedPending, 'user_retry', 'retry', userMessage.timestamp);
            // The answered host prompt is already the unique durable boundary row.
            // Bind the recovery dispatch to that same row so hard-limit admission
            // can replace it atomically with a clean handoff instead of asking the
            // user to repeat context the host still owns.
            allocated.id = userMessage.id;
            resumedPending.lastCause = 'user_retry';
            resumedPending.recoveryDispatch = {
                ...allocated,
                phase: 'started',
                startedAt: Math.max(Date.now(), allocated.allocatedAt),
                preToolExecutionReceiptVersion: 1,
            };
        }
        managed.pendingTurnRecovery = resumedPending;
    }
    else if (!localCompactCommand && !activeMessageState.options?.hidden && !activeMessageState.options?.automaticRecovery && !isHostSyntheticObjectiveText(activeMessageState.message)
        && (!activeMessageState.options?.internalOrigin || authenticatedInternalObjectiveRoot)) {
        const previousObjective = managed.activeObjective;
        const nextObjective = transitionObjectiveContract({
            existing: projectLegacyObjectiveForUserTransition(managed),
            messageId: userMessage.id,
            text: sessionOpObjectiveContractTextFor(sessionOperationContext, managed, userMessage),
            lifetimeCostUsd: managed.tokenUsage?.costUsd,
            lifetimeTokens: managed.tokenUsage?.totalTokens,
            delegatedRole: delegatedObjectiveRoleForSession(managed),
        });
        const sameActiveObjective = previousObjective?.terminalState === 'active'
            && previousObjective.userMessageId === nextObjective.userMessageId;
        const hasPendingContextLimit = (managed.userInputRequests ?? []).some(request => request.status === 'pending' && isExactContextLimitNextStepQuestion(request));
        const cancelledQuestions = previousObjective?.userMessageId !== nextObjective.userMessageId
            || hasPendingContextLimit
            ? sessionOperationContext.owner["cancelPendingUserInput"](managed, true) : undefined;
        managed.activeObjective = nextObjective;
        managed.pendingTurnRecovery = sameActiveObjective && managed.pendingTurnRecovery
            ? { ...managed.pendingTurnRecovery, userMessageId: userMessage.id }
            : createPendingTurnRecovery(userMessage.id);
        managed.autonomyFallbackAttemptedTools = new Set();
        if (cancelledQuestions) {
            try {
                await cancelledQuestions;
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
        }
    }
    if (activeMessageState.options?.automaticRecovery && explicitRetry && managed.pendingTurnRecovery
        && !(cleanExplicitRetry && managed.pendingTurnRecovery.recoveryDispatch?.phase === 'started')) {
        managed.pendingTurnRecovery = sessionOpStartRecoveryDispatch(sessionOperationContext, managed.pendingTurnRecovery, activeMessageState.options.automaticRecovery);
    }
    if (trustedContextLimitAnswer) {
        contextLimitAnswerSetupRollback = createContextLimitAnswerRollback(objectiveAdmissionInput, trustedContextLimitAnswer);
    }
    const cleanRecoveryProviderReset = (() => {
        const dispatch = managed.pendingTurnRecovery?.recoveryDispatch;
        if (!activeMessageState.options?.automaticRecovery || dispatch?.phase !== 'started'
            || !dispatch.cleanContinuationId || dispatch.id !== userMessage.id
            || activeMessageState.options.automaticRecovery.dispatchId !== dispatch.id)
            return false;
        try {
            return activeMessageState.message === sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, managed.pendingTurnRecovery!, dispatch);
        }
        catch {
            return false;
        }
    })();
    if (directHumanContinuation && managed.pendingTurnRecovery?.recoveryDispatch) {
        managed.pendingTurnRecovery = {
            ...managed.pendingTurnRecovery,
            waitingForPermission: undefined,
            recoveryDispatch: undefined,
        };
    }
    if (managed.pendingTurnRecovery?.recoveryDispatch?.cleanContinuationId
        && !cleanRecoveryProviderReset
        && !directHumanContinuation
        && !sessionOpHasConsumedCleanRecoveryDispatch(sessionOperationContext, managed)
        && managed.pendingTurnRecovery.exhaustedAt === undefined) {
        // Authenticate the provider seam before claiming an unrelated queued
        // agent delivery. A host admission failure must not consume its retry
        // counter or manufacture a child-result question without provider work.
        const authenticationError = new CleanRecoveryDispatchAuthenticationError('The clean recovery continuation failed its durable dispatch authentication');
        if (ownsQueuedDispatch && queuedItem) {
            const rolledBackDelivery = await rollbackQueuedAgentDeliveryPreparation('clean-boundary authentication');
            if (!rolledBackDelivery) {
                if (!managed.messageQueue.some(item => item === queuedItem
                    || item.messageId && item.messageId === queuedItem.messageId)) {
                    managed.messageQueue.unshift(queuedItem);
                }
                userMessage.isQueued = true;
                if (sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === queuedDispatchToken) {
                    sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
                }
                sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
                sessionOperationContext.owner["setProcessing"](managed, false);
                if (sessionOperationContext.owner["persistSession"](managed)) {
                    try {
                        await sessionOperationContext.owner.flushSession(managed.id);
                    }
                    catch (error) {
                        sessionLog.warn('Failed to persist unauthenticated clean-boundary dequeue rollback', {
                            sessionId,
                            messageId: userMessage.id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
        }
        else if (managed.processingGeneration === myGeneration) {
            removeSyntheticAutomaticMessage();
            existingTurnRollback?.();
            sessionOperationContext.owner["setProcessing"](managed, false);
            sessionOperationContext.owner["persistSession"](managed);
        }
        throw authenticationError;
    }
    if (userMessage.agentDelivery) {
        userMessage.agentDelivery.status = 'processing';
        // Claiming an agent delivery consumes its queue slot atomically with the
        // durable processing lease. Leaving isQueued=true makes the exact receipt
        // indistinguishable from a second pending dispatch and can cause terminal
        // child results to block their own parent completion forever.
        userMessage.isQueued = false;
        userMessage.agentDelivery.attempts++;
        if (userMessage.agentDelivery.attempts > 3) {
            userMessage.agentDelivery.status = 'failed';
            try {
                if (!sessionOperationContext.owner["persistSession"](managed)) {
                    throw new Error('The exhausted agent-delivery receipt could not be queued for durable storage');
                }
                await sessionOperationContext.owner.flushSession(managed.id);
                const exactDispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(userMessage.id);
                if (exactDispatch && exactDispatch.dispatchToken === queuedDispatchToken) {
                    exactDispatch.claimDurable = true;
                }
                sessionOpCompleteQueuedAgentDeliveryDispatch(sessionOperationContext, userMessage.id, queuedDispatchToken);
            }
            catch (error) {
                if (durablyAcknowledged && !ownsActiveTurn()) {
                    await abandonStoppedTurn();
                    return;
                }
                await rollbackQueuedAgentDeliveryPreparation('exhausted-delivery durability fence');
                throw error;
            }
            if (!ownsActiveTurn()) {
                await abandonStoppedTurn();
                return;
            }
            sessionOperationContext.owner["setProcessing"](managed, false);
            throw new Error('Agent delivery recovery exhausted after three attempts; inspect the persisted transcript');
        }
        managed.activeAgentDelivery = {
            deliveryId: userMessage.agentDelivery.id,
            generation: myGeneration,
        };
    }
    else {
        userMessage.isQueued = false;
    }
    if (managed.activeObjective && managed.playbookSlug && !isTerminalReviewSession(managed)) {
        const selected = sessionOpLoadSessionPlaybook(sessionOperationContext, managed);
        if (selected?.manifest.procedure && !managed.activeObjective.terminalReconciliation) {
            managed.activeObjective = bindBusinessProcedure(managed.activeObjective, selected.manifest.procedure);
        }
    }
    managed.waitDiagnosticBoundary = managed.activeObjective ? {
        generation: myGeneration,
        objectiveId: managed.activeObjective.objectiveId ?? managed.activeObjective.userMessageId,
        fromMessageCount: diagnosticFromMessageCount,
    } : undefined;
    rehydrateObjectiveEvidence(managed);
    if (managed.pendingTurnRecovery || userMessage.agentDelivery || existingMessageId) {
        try {
            if (!sessionOperationContext.owner["persistSession"](managed)) {
                throw new Error('The prepared provider turn could not be queued for durable storage');
            }
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        catch (error) {
            if (durablyAcknowledged && !ownsActiveTurn()) {
                await abandonStoppedTurn();
                return;
            }
            await rollbackQueuedAgentDeliveryPreparation('pre-provider durability fence');
            existingTurnRollback?.();
            throw error;
        }
        if (userMessage.agentDelivery) {
            const exactDispatch = sessionOperationContext.state.queuedAgentDeliveryDispatches.get(userMessage.id);
            if (exactDispatch && exactDispatch.dispatchToken === queuedDispatchToken) {
                exactDispatch.claimDurable = true;
            }
        }
        if (!ownsActiveTurn()) {
            await abandonStoppedTurn();
            return;
        }
        if (await finishSupersededAutomaticRecovery())
            return;
    }
    if (activeMessageState.options?.automaticRecovery && managed.pendingTurnRecovery?.recoveryDispatch?.phase === 'started') {
        const dispatch = managed.pendingTurnRecovery.recoveryDispatch;
        const retryGrant = dispatch.origin === 'retry'
            ? managed.pendingTurnRecovery.explicitRetryAllowances?.findLast(grant => (grant.userMessageId === managed.pendingTurnRecovery?.userMessageId
                && grant.authorizedAt >= dispatch.allocatedAt))
            : undefined;
        sessionLog.warn('Starting durable automatic turn recovery dispatch', {
            sessionId: managed.id,
            originalUserMessageId: managed.pendingTurnRecovery.userMessageId,
            cause: dispatch.cause,
            attempt: dispatch.attempt,
            budgetAttempt: managed.pendingTurnRecovery.attempts,
            dispatchId: dispatch.id,
            origin: dispatch.origin,
            ...(retryGrant ? {
                retryGrantId: retryGrant.id,
                retryGrantAttemptBaseline: retryGrant.attemptBaseline,
                retryGrantMaxAttempts: retryGrant.maxAttempts,
                retryGrantLeaseExpiresAt: retryGrant.leaseExpiresAt,
            } : {}),
        });
    }
    if (cleanRecoveryProviderReset) {
        // Detach the old provider session before any routing, compaction, or
        // provider call. The exact bounded handoff remains the only user payload
        // in the new provider context; branch/SDK resume state cannot reattach
        // discarded transcript history.
        await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean recovery continuation');
        assertActivePreparation();
        // Fresh sends already committed this reset atomically with their first
        // durable boundary. This fallback is only for a queued row written by an
        // older host, before provider-state atomization existed.
        if (!cleanRecoveryProviderStateAtomized) {
            resetProviderResumeStateForCleanBoundary(userMessage.id);
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            assertActivePreparation();
        }
    }
    if (existingMessageId) {
        if (retryWithRetainedInbox && (!sessionOpHasOnlyMachineInbox(sessionOperationContext, managed) || sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed))) {
            // The click retries its original anchor, never the machine FIFO. A new
            // human instruction/decision accepted during the flush keeps priority.
            existingTurnRollback?.();
            await sessionOperationContext.owner.flushSession(managed.id);
            sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
            sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]();
            throw new Error('The inbox changed before Retry was accepted; resolve the newer message or decision first');
        }
        if (explicitRetry || trustedUserInput) {
            // Publish the same message ID: renderer reconciles its state without
            // adding a transcript bubble, including hidden question responses in
            // other open windows. Acceptance must also signal that work restarted.
            sessionOperationContext.owner["sendEvent"]({ type: 'user_message', sessionId, message: userMessage, status: 'processing' }, managed.workspace.id);
        }
        durablyAcknowledged = true;
        onAck?.(userMessage.id);
    }
    if (!activeMessageState.options?.hidden && !activeMessageState.options?.internalOrigin) {
        await sessionOpCaptureUserCorrection(sessionOperationContext, managed, userMessage);
        if (!ownsActiveTurn()) {
            await abandonStoppedTurn();
            return;
        }
    }
    return { trustedContextLimitAnswer, contextLimitAnswerSetupRollback, cleanRecoveryProviderReset };
}
