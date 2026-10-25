import type { SessionOperationContext } from '../operation-context.ts';
import { exactProviderDispatchAcceptanceUnknown, assertRetryTurnAnchor, nextRecoveryDispatch, validAllocatedRecoveryDispatch, isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import { acknowledgeDurableDelivery } from '../../agent-delivery.ts';
import type { UserInputRequest } from '@craft-agent/core';
import { resolveAgentCostControlPolicy, resolveEffectiveAgentContextLimits } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { readFileAttachment } from '@craft-agent/shared/utils';
import { buildObjectiveValidationEvidenceContext } from '../../objective-validation-context';
import { buildAutomaticTurnRecoveryPrompt, buildCleanRecoveryContinuationPrompt, createPendingTurnRecovery, reconstructLegacyTurnRecoveryBudget } from '../../turn-recovery';
import { resolveContextTokenEstimate } from '../../context-token-estimate';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { RetryTurnAlreadyRunningError } from '../runtime-policy.ts';
import { resolveManagedSessionContextWindow } from '../user-input-authority.ts';
import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { providerDispatchAdmissionBarrier as sessionOpProviderDispatchAdmissionBarrier } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { assertRetryTurnUnblocked as sessionOpAssertRetryTurnUnblocked } from './create-autonomous-context-limit-handoff.ts';
import { exactQueuedAgentDeliveryReceipt as sessionOpExactQueuedAgentDeliveryReceipt, canRetryRetainedMachineInbox as sessionOpCanRetryRetainedMachineInbox, hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput, emitUserInputChanged as sessionOpEmitUserInputChanged } from './perform-request-user-input.ts';
import { isExactRepurposedUserInputCleanBoundary as sessionOpIsExactRepurposedUserInputCleanBoundary } from './user-input-recovery.ts';
import { hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry, isCleanSetupPersistenceFenced as sessionOpIsCleanSetupPersistenceFenced } from './start-recovery-dispatch.ts';
import { getInterruptedTurnRecovery as sessionOpGetInterruptedTurnRecovery, reconcileProviderAcceptanceUnknownForRetry as sessionOpReconcileProviderAcceptanceUnknownForRetry } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { retryableContextLimitRequest as sessionOpRetryableContextLimitRequest } from './retryable-context-limit-request.ts';
import { isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked, pendingRecoveryBelongsToCurrentObjective as sessionOpPendingRecoveryBelongsToCurrentObjective } from './pending-recovery-belongs-to-current-objective.ts';
import { createContextLimitRetryHandoff as sessionOpCreateContextLimitRetryHandoff } from './create-context-limit-retry-handoff.ts';

async function sessionOpRetryTurnInternal(sessionOperationContext: SessionOperationContext, sessionId: string, userMessageId: string, rpcContext?: {
    callerClientId?: string;
}, grantNewAllowance = false): Promise<import('@craft-agent/shared/protocol').RetryTurnResult> {
    const managedAtEntry = sessionOperationContext.state.sessions.get(sessionId);
    if (!managedAtEntry)
        throw new Error(`Session ${sessionId} not found`);
    sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managedAtEntry);
    const existing = sessionOperationContext.state.retryTurnsInFlight.get(sessionId);
    if (existing) {
        await existing;
        return { status: 'already_running' };
    }
    const operation = (async (): Promise<import('@craft-agent/shared/protocol').RetryTurnResult> => {
        const managed = sessionOperationContext.state.sessions.get(sessionId);
        if (!managed)
            throw new Error(`Session ${sessionId} not found`);
        sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
        const retryCancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
        await sessionOperationContext.owner["ensureMessagesLoaded"](managed);
        sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
        if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== retryCancellationEpoch)
            throw new Error('Retry was cancelled by Stop');
        if (sessionOperationContext.state.coldProviderReconciliationsInFlight.has(managed.id)) {
            throw new Error('Provider reconciliation is still being persisted; retry after the durable transition completes');
        }
        if (sessionOperationContext.state.providerStopTransitionsInFlight.has(managed.id)) {
            throw new Error('The explicit Stop transition is still being persisted; retry after it completes');
        }
        const anchor = assertRetryTurnAnchor(managed, userMessageId);
        const providerAcceptanceBarrier = sessionOpProviderDispatchAdmissionBarrier(sessionOperationContext, managed);
        const retiredAcceptedRetryBarrier = managed.messages.find(message => (message.role === 'user'
            && message.providerDispatch?.state === 'retired-accepted'
            && exactProviderDispatchAcceptanceUnknown(message)
            && message.providerDispatch.objectiveId
                === (managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId)
            && message.providerDispatch.objectiveUserMessageId === managed.activeObjective?.userMessageId));
        const providerRetryBarrier = providerAcceptanceBarrier ?? retiredAcceptedRetryBarrier;
        if (providerRetryBarrier) {
            // Reconciliation is destructive and durable. Every blocker must be
            // checked first so a rejected Retry cannot silently remove the only
            // non-replay proof (including for an agent-delivery receipt).
            sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed);
            if (managed.isProcessing || managed.agent?.isProcessing()) {
                return { status: 'already_running' };
            }
        }
        if (!grantNewAllowance && providerRetryBarrier) {
            throw new Error('Provider acceptance can only be reconciled by an explicit Retry');
        }
        const blockedDeliveryItems = managed.messageQueue.filter(item => {
            const receipt = sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, item);
            return Number.isFinite(receipt?.agentDelivery?.setupRetryBlockedAt)
                || Number.isFinite(receipt?.agentDelivery?.setupPersistenceFencedAt)
                || !!receipt && sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(managed.id) === receipt.agentDelivery?.id;
        });
        if (grantNewAllowance && blockedDeliveryItems.length >= 1
            && !managed.isProcessing && !managed.agent?.isProcessing()) {
            if (sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasQueuedUserInput(sessionOperationContext, managed)
                || sessionOpHasPendingDecision(sessionOperationContext, managed) || managed.pendingAuthRequestId
                || managed.pendingAuthRequest
                || [...sessionOperationContext.state.pendingPermissionRequests.values()].some(request => request.sessionId === managed.id)) {
                throw new Error('Resolve the pending question, authentication, or approval before retrying the queued agent delivery');
            }
            const blockedReceipt = sessionOpExactQueuedAgentDeliveryReceipt(sessionOperationContext, managed, blockedDeliveryItems[0]!)!;
            const previousSetupState = {
                setupFailureCount: blockedReceipt.agentDelivery!.setupFailureCount,
                lastSetupFailureClass: blockedReceipt.agentDelivery!.lastSetupFailureClass,
                setupRetryNotBefore: blockedReceipt.agentDelivery!.setupRetryNotBefore,
                setupRetryBlockedAt: blockedReceipt.agentDelivery!.setupRetryBlockedAt,
                setupPersistenceFencedAt: blockedReceipt.agentDelivery!.setupPersistenceFencedAt,
            };
            const hadRuntimeFence = sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(managed.id)
                === blockedReceipt.agentDelivery!.id;
            blockedReceipt.agentDelivery!.setupFailureCount = undefined;
            blockedReceipt.agentDelivery!.lastSetupFailureClass = undefined;
            blockedReceipt.agentDelivery!.setupRetryNotBefore = undefined;
            blockedReceipt.agentDelivery!.setupRetryBlockedAt = undefined;
            blockedReceipt.agentDelivery!.setupPersistenceFencedAt = undefined;
            if (hadRuntimeFence)
                sessionOperationContext.state.agentDeliverySetupPersistenceFences.delete(managed.id);
            sessionOpClearDeferredAutomaticRetry(sessionOperationContext, managed.id);
            try {
                if (!sessionOperationContext.owner["persistSession"](managed)) {
                    throw new Error('The queued agent-delivery Retry could not be queued for durable storage');
                }
                await sessionOperationContext.owner.flushSession(managed.id);
            }
            catch (error) {
                Object.assign(blockedReceipt.agentDelivery!, previousSetupState);
                if (hadRuntimeFence) {
                    sessionOperationContext.state.agentDeliverySetupPersistenceFences.set(managed.id, blockedReceipt.agentDelivery!.id);
                }
                sessionOperationContext.owner["persistSession"](managed);
                throw error;
            }
            if ((sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) !== retryCancellationEpoch
                || managed.stopRequested)
                throw new Error('Retry was cancelled by Stop');
            sessionOperationContext.state.deferredAutomaticSessions.add(managed.id);
            sessionOperationContext.owner["processNextQueuedMessage"](managed.id);
            return { status: 'started' };
        }
        const retryRecoveryCandidate = managed.pendingTurnRecovery
            ?? sessionOpGetInterruptedTurnRecovery(sessionOperationContext, managed, anchor.id);
        const contextLimitRequestCandidate = sessionOpRetryableContextLimitRequest(sessionOperationContext, managed);
        const retryCostPolicy = resolveAgentCostControlPolicy(loadWorkspaceConfig(managed.workspace.rootPath)?.costControl);
        const retryContextLimits = resolveEffectiveAgentContextLimits(retryCostPolicy.context, resolveManagedSessionContextWindow(managed));
        const retryAtHardContextLimit = resolveContextTokenEstimate(managed.tokenUsage?.contextTokens, managed.messages) >= retryContextLimits.hardLimitTokens;
        const retainedCleanRetry = retryRecoveryCandidate?.recoveryDispatch?.cleanContinuationId !== undefined
            || sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, retryRecoveryCandidate?.recoveryDispatch);
        const contextLimitHandoffCandidate = !anchor.attachments?.length
            && retryRecoveryCandidate
            ? contextLimitRequestCandidate
                ? sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, retryRecoveryCandidate)
                : retryAtHardContextLimit || retainedCleanRetry
                    ? sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, retryRecoveryCandidate)
                        ?? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, {
                            ...retryRecoveryCandidate,
                            lastCause: 'user_retry',
                        })
                    : undefined
            : undefined;
        const contextLimitRequest = contextLimitHandoffCandidate
            ? contextLimitRequestCandidate : undefined;
        const resumePermissionInbox = managed.pendingTurnRecovery?.waitingForPermission?.recoveryRequired === true
            && managed.messageQueue.length > 0 && !sessionOperationContext.state.queuedMessageDispatches.has(managed.id);
        const retryWithRetainedMachineInbox = sessionOpCanRetryRetainedMachineInbox(sessionOperationContext, managed)
            || (!!retryRecoveryCandidate
                && sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, retryRecoveryCandidate)
                && (sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, retryRecoveryCandidate.recoveryDispatch)
                    || sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, retryRecoveryCandidate.recoveryDispatch))
                && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed));
        sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed, resumePermissionInbox, contextLimitRequest?.id, retryWithRetainedMachineInbox);
        if (managed.isProcessing || managed.agent?.isProcessing())
            return { status: 'already_running' };
        if (grantNewAllowance && providerRetryBarrier) {
            const reconciliation = sessionOpReconcileProviderAcceptanceUnknownForRetry(sessionOperationContext, managed, retryCancellationEpoch, () => sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed));
            sessionOperationContext.state.providerRetryReconciliationTransactions.set(managed.id, reconciliation);
            try {
                await reconciliation;
            }
            finally {
                if (sessionOperationContext.state.providerRetryReconciliationTransactions.get(managed.id) === reconciliation) {
                    sessionOperationContext.state.providerRetryReconciliationTransactions.delete(managed.id);
                }
            }
        }
        if (resumePermissionInbox) {
            const previousRecovery = managed.pendingTurnRecovery;
            const previousObjective = managed.activeObjective;
            const previousStatus = managed.sessionStatus;
            const next = managed.messageQueue.shift()!;
            const generation = managed.processingGeneration + 1;
            const cancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
            if (previousObjective)
                managed.activeObjective = { ...previousObjective, terminalState: 'active', completedAt: undefined };
            managed.pendingTurnRecovery = { ...previousRecovery!, waitingForPermission: undefined };
            const dispatchToken = Symbol('permission-inbox-retry');
            sessionOperationContext.state.queuedMessageDispatches.set(managed.id, dispatchToken);
            sessionOperationContext.state.permissionInboxRetryDispatches.add(dispatchToken);
            try {
                await acknowledgeDurableDelivery(ack => sessionOperationContext.owner.sendMessage(managed.id, next.message, next.attachments, next.storedAttachments, next.options, next.messageId, false, ack, rpcContext, dispatchToken, next, retryCancellationEpoch), error => sessionLog.error('Accepted permission-wait continuation failed', { sessionId, error }));
            }
            catch (error) {
                if (sessionOperationContext.state.sessions.get(sessionId) === managed && managed.processingGeneration <= generation && !sessionOperationContext.state.shuttingDown
                    && (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) === cancellationEpoch) {
                    managed.pendingTurnRecovery = previousRecovery;
                    managed.activeObjective = previousObjective;
                    managed.sessionStatus = previousStatus;
                    sessionOperationContext.owner["setProcessing"](managed, false);
                    if (!managed.messageQueue.some(item => item.messageId === next.messageId))
                        managed.messageQueue.unshift(next);
                    const saved = managed.messages.find(message => message.id === next.messageId);
                    if (saved)
                        saved.isQueued = true;
                    sessionOperationContext.state.queuedMessageDispatches.delete(managed.id);
                    sessionOperationContext.owner["persistSession"](managed);
                    sessionOperationContext.owner["sendEvent"]({ type: 'session_status_changed', sessionId, sessionStatus: previousStatus ?? 'todo' }, managed.workspace.id);
                }
                throw error;
            }
            finally {
                sessionOperationContext.state.permissionInboxRetryDispatches.delete(dispatchToken);
            }
            return { status: 'started' };
        }
        // Read the durable copies, preserving resized images and converted Office
        // paths. A missing attachment is an error, never silently omitted context.
        const attachments = anchor.attachments?.map(stored => {
            const attachment = readFileAttachment(stored.storedPath);
            if (!attachment)
                throw new Error(`The saved attachment is unavailable: ${stored.name}`);
            return {
                ...attachment, type: stored.type, name: stored.name, mimeType: stored.mimeType,
                storedPath: stored.storedPath, markdownPath: stored.markdownPath,
                ...(stored.resizedBase64 ? { base64: stored.resizedBase64 } : {}),
            };
        });
        const recovery = retryRecoveryCandidate
            ?? reconstructLegacyTurnRecoveryBudget(managed.messages, anchor.id) ?? createPendingTurnRecovery(anchor.id);
        const retryDispatch = nextRecoveryDispatch(recovery, 'user_retry', 'retry');
        const contextLimitHandoff = contextLimitHandoffCandidate
            ? contextLimitRequest
                ? sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, recovery)
                : sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, recovery)
                    ?? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, {
                        ...recovery,
                        lastCause: 'user_retry',
                    })
            : undefined;
        const cleanPrompt = contextLimitHandoff
            ? buildCleanRecoveryContinuationPrompt(contextLimitHandoff)
            : undefined;
        if (contextLimitHandoffCandidate && !cleanPrompt) {
            throw new Error('The context-limit Retry handoff changed before its provider boundary was allocated');
        }
        const prompt = cleanPrompt ?? [
            buildAutomaticTurnRecoveryPrompt({ ...recovery, userMessageId: anchor.id }, 'user_retry', managed.activeObjective && (recovery.validationGaps?.length
                || managed.activeObjective.terminalReconciliation)
                ? buildObjectiveValidationEvidenceContext(managed.messages, managed.activeObjective, managed.id) : undefined, retryDispatch.attempt, isLegacyHostObjectiveContractEnabled(managed) ? managed.activeObjective : undefined),
            'The latest user message below refines the preserved objective. Resume from existing evidence and the current external state; do not redo completed actions or treat retry as a new authorization.',
            `<existing_user_message id=${JSON.stringify(anchor.id)}>`, anchor.content, '</existing_user_message>',
        ].join('\n\n');
        const allowanceToken = grantNewAllowance && managed.activeObjective ? Symbol('explicit-retry-allowance') : undefined;
        if (allowanceToken)
            sessionOperationContext.state.explicitRetryAllowanceTokens.set(allowanceToken, {
                sessionId, userMessageId: anchor.id,
                objectiveId: managed.activeObjective!.objectiveId ?? managed.activeObjective!.userMessageId,
                cancellationEpoch: retryCancellationEpoch,
                grantNewAllowance: true,
                ...(retryWithRetainedMachineInbox ? { allowRetainedMachineInbox: true } : {}),
                ...(contextLimitHandoff ? {
                    ...(contextLimitRequest ? { contextLimitRequestId: contextLimitRequest.id } : {}),
                    cleanBoundaryMessageId: retryDispatch.id,
                    cleanContinuationId: contextLimitHandoff.id,
                } : {}),
            });
        try {
            await acknowledgeDurableDelivery(ack => sessionOperationContext.owner.sendMessage(managed.id, prompt, attachments, anchor.attachments, { hidden: true, automaticRecovery: {
                    originalUserMessageId: anchor.id,
                    cause: 'user_retry',
                    dispatchId: retryDispatch.id,
                    dispatchAttempt: retryDispatch.attempt,
                    dispatchOrigin: retryDispatch.origin,
                    dispatchAllocatedAt: retryDispatch.allocatedAt,
                    ...(contextLimitHandoff ? { cleanContinuationId: contextLimitHandoff.id } : {}),
                } }, contextLimitHandoff ? undefined : anchor.id, false, messageId => {
                ack(messageId);
                if (contextLimitRequest?.status === 'cancelled')
                    sessionOpEmitUserInputChanged(sessionOperationContext, managed);
            }, rpcContext, undefined, undefined, retryCancellationEpoch, allowanceToken), error => sessionLog.error('Accepted turn retry failed', { sessionId, error }));
        }
        catch (error) {
            if (error instanceof RetryTurnAlreadyRunningError)
                return { status: 'already_running' };
            throw error;
        }
        finally {
            if (allowanceToken)
                sessionOperationContext.state.explicitRetryAllowanceTokens.delete(allowanceToken);
        }
        return { status: 'started' };
    })();
    // The first await in the operation is hydration; reserve before it resumes.
    sessionOperationContext.state.retryTurnsInFlight.set(sessionId, operation);
    try {
        return await operation;
    }
    finally {
        sessionOperationContext.state.retryTurnsInFlight.delete(sessionId);
    }
}

/** A context-limit answer can be committed as the first clean Retry boundary
 * before provider setup begins. Reclaim only that exact host-authenticated
 * answered row; generic started-dispatch recovery deliberately excludes
 * Retry and clean boundaries because neither may be inferred from prose. */
function sessionOpReclaimableUnobservedStartedCleanUserInputRetry(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery): {
    messageIndex: number;
    allocatedDispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']>;
    request: UserInputRequest;
} | undefined {
    const dispatch = pending.recoveryDispatch;
    if (dispatch?.schemaVersion !== 1 || dispatch.phase !== 'started'
        || dispatch.preToolExecutionReceiptVersion !== 1
        || !dispatch.cleanContinuationId || dispatch.origin !== 'retry'
        || dispatch.cause !== 'user_retry' || pending.lastCause !== 'user_retry'
        || !Number.isFinite(dispatch.startedAt) || dispatch.startedAt! < dispatch.allocatedAt
        || !sessionOpPendingRecoveryBelongsToCurrentObjective(sessionOperationContext, managed, pending))
        return undefined;
    let allocatedDispatch = { ...dispatch, phase: 'allocated' as const };
    delete allocatedDispatch.startedAt;
    if (!validAllocatedRecoveryDispatch({ ...pending, recoveryDispatch: allocatedDispatch })) {
        return undefined;
    }
    const requests = (managed.userInputRequests ?? []).filter(request => (request.status === 'answered' && request.responseMessageId === dispatch.id
        && request.sessionId === managed.id && request.originWorkspaceId === managed.workspace.id
        && request.objectiveUserMessageId === managed.activeObjective?.userMessageId
        && !!request.answers?.length));
    const request = requests.length === 1 ? requests[0] : undefined;
    if (!request)
        return undefined;
    const matches = managed.messages.flatMap((message, index) => (message.id === dispatch.id ? [{ message, index }] : []));
    const match = matches.length === 1 ? matches[0] : undefined;
    if (!match || match.index !== managed.messages.length - 1
        || match.message.role !== 'user' || match.message.hidden !== true
        || match.message.isQueued || match.message.isPending || match.message.agentDelivery
        || match.message.providerDispatch
        || match.message.internalOrigin?.kind !== 'user-input'
        || (match.message.attachments?.length ?? 0) > 0
        || managed.messageQueue.some(item => item.messageId === dispatch.id)
        || !sessionOpIsExactRepurposedUserInputCleanBoundary(sessionOperationContext, managed, request, match.message)
        || managed.autonomyEvents?.some(event => event.timestamp >= dispatch.startedAt!))
        return undefined;
    // The original boundary was computed while the answer dispatch was
    // `started`. Reclaiming it changes only that volatile phase, but the clean
    // contract id can therefore need one deterministic rebinding. Iterate over
    // host-derived candidates until the allocated snapshot is self-consistent;
    // never reuse the old prompt as authority after removing its row.
    for (let iteration = 0; iteration < 4; iteration += 1) {
        const allocatedPending: PendingTurnRecovery = {
            ...pending,
            recoveryDispatch: allocatedDispatch,
        };
        const contextLimit = sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, allocatedPending);
        const autonomous = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, allocatedPending);
        const matching = [autonomous, contextLimit].find(candidate => (candidate?.id === allocatedDispatch.cleanContinuationId));
        if (matching) {
            if (!validAllocatedRecoveryDispatch(allocatedPending))
                return undefined;
            return { messageIndex: match.index, allocatedDispatch, request };
        }
        const next = autonomous ?? contextLimit;
        if (!next)
            return undefined;
        allocatedDispatch = { ...allocatedDispatch, cleanContinuationId: next.id };
    }
    return undefined;
}

/** Revoke a cold marker whose claimed human/legacy authority cannot be
 * authenticated against the hydrated objective and transcript. Hidden
 * answer rows are retained as history but can no longer enter the FIFO. */
async function sessionOpRevokeStaleColdRecovery(sessionOperationContext: SessionOperationContext, managed: ManagedSession, pending: PendingTurnRecovery, reason: string): Promise<void> {
    if (sessionOperationContext.state.sessions.get(managed.id) !== managed || managed.pendingTurnRecovery !== pending)
        return;
    for (const message of managed.messages) {
        if (message.id === pending.userMessageId && message.internalOrigin?.kind === 'user-input') {
            message.isQueued = false;
        }
    }
    managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== pending.userMessageId);
    sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
    sessionOperationContext.state.deferredAutomaticSessions.delete(managed.id);
    sessionOperationContext.state.automaticAdmissionReservations.delete(managed.id);
    sessionOperationContext.owner["persistSession"](managed);
    await sessionOperationContext.owner.flushSession(managed.id);
    sessionLog.warn('Revoked stale cold recovery authority', {
        sessionId: managed.id,
        objectiveId: managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId,
        recoveryUserMessageId: pending.userMessageId,
        reason,
    });
}

export { sessionOpRetryTurnInternal as retryTurnInternal };
export { sessionOpReclaimableUnobservedStartedCleanUserInputRetry as reclaimableUnobservedStartedCleanUserInputRetry };
export { sessionOpRevokeStaleColdRecovery as revokeStaleColdRecovery };
