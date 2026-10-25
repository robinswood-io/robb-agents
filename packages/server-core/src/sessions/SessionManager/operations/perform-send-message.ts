import { admitSessionMessageObjective } from './admit-session-message-objective.ts';
import { reuseSessionUserMessage } from './reuse-session-user-message.ts';
import { createNewSessionUserMessage } from './create-new-session-user-message.ts';
import type { UserMessagePreparationInput } from './user-message-preparation-input.ts';
import { prepareSessionAgentRuntime } from './prepare-agent-runtime.ts';
import { executeSessionProviderTurn } from './execute-provider-turn.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';
import { createProviderTurnState } from './provider-turn-state.ts';
import { enqueueSessionMessage } from './enqueue-session-message.ts';
import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import { refreshInheritedWorkspaceSources, hasPendingLocalUserInput, assertRetryTurnAnchor, queuedDirectHumanContinuationIndex, cleanRetrySetupFailureSignal, enqueueRecoveredMessageInTranscriptOrder, persistenceRootFor, isExactQueuedSourceActivation, cancelSourceActivationPending, repairLegacyContextualObjectiveAuthority, isDirectHumanContinuation } from '../policy.ts';

import { reopenCompletedChat } from '../../completed-chat-retention';
import { restoreAgentDeliveryAttachments } from '../../agent-delivery.ts';

import type { UserInputRequest } from '@craft-agent/core';

import { classifyAgentFailure, parseCompactCommand } from '@craft-agent/shared/agent';

import { clearPendingPlanExecution as clearStoredPendingPlanExecution } from '@craft-agent/shared/sessions';

import { getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources';

import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol';
import { CodedError, generateMessageId } from '@craft-agent/shared/protocol';
import type { StoredAttachment } from '@craft-agent/core/types';
import { perf, readFileAttachment } from '@craft-agent/shared/utils';
import { loadSkillBySlug } from '@craft-agent/shared/skills';

import { shouldManageSessionStatusLifecycle } from '../../session-status-lifecycle';
import { createPendingTurnRecovery } from '../../turn-recovery';

import type { ManagedSession } from '../managed-session.ts';
import { hasImmutableMissionRoute } from '../mission-route.ts';

import { sessionLog } from '../runtime-platform.ts';
import { AutomaticRecoverySupersededError, AutonomousAdmissionDeferredError, DelegatedDispatchSupersededError, InternalContinuationSupersededError, RetryTurnAlreadyRunningError, SourceActivationSupersededError } from '../runtime-policy.ts';

import type { SourceActivationOrigin } from '../source-activation.ts';
import { claimAutoRetryPending, isSourceActivationOriginCurrent, sourceActivationObjectiveBinding } from '../source-activation.ts';

import { MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES, MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES, isCostLimitContinuationAnswer } from '../user-input-authority.ts';

import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, repairLegacySyntheticObjectiveAuthority as sessionOpRepairLegacySyntheticObjectiveAuthority, revokePendingToolPermissionsForDirectContinuation as sessionOpRevokePendingToolPermissionsForDirectContinuation, dropDeferredSourceActivations as sessionOpDropDeferredSourceActivations, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { isFreshStaleTypedUpwardAgentDelivery as sessionOpIsFreshStaleTypedUpwardAgentDelivery, releasableUpwardAgentDeliverySenderId as sessionOpReleasableUpwardAgentDeliverySenderId, isStaleTypedUpwardAgentDelivery as sessionOpIsStaleTypedUpwardAgentDelivery, quarantineStaleTypedUpwardAgentDelivery as sessionOpQuarantineStaleTypedUpwardAgentDelivery } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { authenticatedInternalContinuationCurrent as sessionOpAuthenticatedInternalContinuationCurrent, consumeAuthenticatedInternalContinuation as sessionOpConsumeAuthenticatedInternalContinuation, delegatedDispatchContinuationCurrent as sessionOpDelegatedDispatchContinuationCurrent, consumeDelegatedDispatchContinuation as sessionOpConsumeDelegatedDispatchContinuation, claimAuthenticatedInternalContinuation as sessionOpClaimAuthenticatedInternalContinuation } from './message-authority.ts';
import { stripDisabledAllocatedRoutingFallback as sessionOpStripDisabledAllocatedRoutingFallback, startRecoveryDispatch as sessionOpStartRecoveryDispatch } from './start-recovery-dispatch.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';
import { untrackSyntheticAutomaticMessage as sessionOpUntrackSyntheticAutomaticMessage, providerDispatchAdmissionBarrier as sessionOpProviderDispatchAdmissionBarrier } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { hasAcceptedHumanContinuationQueued as sessionOpHasAcceptedHumanContinuationQueued, cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries, consumeLiveDirectHumanContinuation as sessionOpConsumeLiveDirectHumanContinuation, assertRetryTurnUnblocked as sessionOpAssertRetryTurnUnblocked } from './create-autonomous-context-limit-handoff.ts';
import { setLastMessageClientId as sessionOpSetLastMessageClientId, monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { settleQueuedAgentDeliveryDispatch as sessionOpSettleQueuedAgentDeliveryDispatch, completeQueuedAgentDeliveryDispatch as sessionOpCompleteQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import { cancelPendingAuthForHumanContinuation as sessionOpCancelPendingAuthForHumanContinuation } from './downgrade-cold-auth-resume-permission.ts';
import { isAutonomousMessage as sessionOpIsAutonomousMessage } from './is-current-delegated-descendant.ts';
import { canRetryRetainedMachineInbox as sessionOpCanRetryRetainedMachineInbox, hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, exactQueuedAgentDeliveryReceipt as sessionOpExactQueuedAgentDeliveryReceipt } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { retryableContextLimitRequest as sessionOpRetryableContextLimitRequest } from './retryable-context-limit-request.ts';
import { exactUserInputResponse as sessionOpExactUserInputResponse, autonomousAdmissionBlock as sessionOpAutonomousAdmissionBlock } from './exact-user-input-response.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';

import { evaluateAndApplyAutoLabels as sessionOpEvaluateAndApplyAutoLabels } from './perform-adopt-generated-task-orchestrator.ts';
import { getLastFinalAssistantMessageId as sessionOpGetLastFinalAssistantMessageId } from './session-sources.ts';

import { reloadSessionSourcesWithinOperation as sessionOpReloadSessionSourcesWithinOperation } from './workspace-configuration.ts';
import { hasRunningBackgroundTasks as sessionOpHasRunningBackgroundTasks } from './evict-idle-session-runtimes.ts';

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
    const activeMessageState: SessionMessageState = { message, options, syntheticAutomaticMessage: undefined };
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

    let automaticDispatchGeneration: number | undefined;
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
        if (automaticDispatchGeneration !== undefined
            && managed.processingGeneration === automaticDispatchGeneration) {
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
        const durableSourceDequeue = activeMessageState.options?.internalOrigin?.kind === 'source-activation'
            && !!existingMessageId && queuedDispatchToken !== undefined;
        const sourceActivationClaim = durableSourceDequeue
            ? 'send'
            : claimAutoRetryPending(managed, activeMessageState.message, Date.now(), sourceActivationDispatchToken);
        if (sourceActivationClaim === 'drop') {
            sessionLog.info(`sendMessage: dropped duplicate source-activation retry for ${sessionId}`);
            return;
        }
        if (sourceActivationClaim === 'reserved') {
            throw new CodedError('CAPABILITY_UNAVAILABLE', 'The terminal "[source activated]" marker is reserved for a server-authenticated source restart');
        }
        if (sourceActivationClaim === 'authenticated') {
            const pending = managed.autoRetryPending;
            const current = sourceActivationObjectiveBinding(managed.activeObjective);
            if (!pending || !current || pending.objectiveId !== current.objectiveId
                || pending.objectiveRevision !== current.objectiveRevision) {
                if (pending) {
                    pending.cancelled = true;
                    pending.committed = true;
                }
                sessionLog.info(`sendMessage: dropped stale source-activation retry for ${sessionId}`);
                return;
            }
            authenticatedSourceActivation = true;
            activeMessageState.options = {
                ...activeMessageState.options,
                hidden: true,
                internalOrigin: {
                    kind: 'source-activation',
                    objectiveId: pending.objectiveId,
                    objectiveRevision: pending.objectiveRevision,
                    sourceSlug: pending.sourceSlug,
                    sourceActivationId: pending.sourceActivationId,
                },
            };
        }
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
            await sessionOperationContext.owner.flushSession(sessionId);
            if (!managed.isProcessing && managed.messageQueue.length > 0)
                sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
            sessionLog.info(`sendMessage: refused stale or unbound source-activation continuation for ${sessionId}`);
            return;
        }
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
            managed.messageQueue.unshift(queuedItem ?? { message: activeMessageState.message, attachments, storedAttachments, options: activeMessageState.options, messageId: existingMessageId });
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
    const explicitRetry = activeMessageState.options?.automaticRecovery?.cause === 'user_retry';
    const retryWithRetainedInbox = explicitRetry && sessionOpCanRetryRetainedMachineInbox(sessionOperationContext, managed);
    const explicitRetryIntent = explicitRetryIntentAtEntry;
    const cleanExplicitRetry = !!explicitRetry && !existingMessageId && !!explicitRetryIntent
        && explicitRetryIntent.cleanBoundaryMessageId === activeMessageState.options?.automaticRecovery?.dispatchId
        && explicitRetryIntent.cleanContinuationId === activeMessageState.options?.automaticRecovery?.cleanContinuationId;
    const cleanRetryWithRetainedMachineInbox = cleanExplicitRetry
        && explicitRetryIntent?.allowRetainedMachineInbox === true
        && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed);
    let explicitRetryContextLimitRequest: UserInputRequest | undefined;
    let explicitRetryContextLimitRequestBefore: Pick<UserInputRequest, 'status' | 'answeredAt'> | undefined;
    if (explicitRetry) {
        if ((!cleanExplicitRetry && (!existingMessageId
            || existingMessageId !== activeMessageState.options?.automaticRecovery?.originalUserMessageId))
            || !sessionOperationContext.state.retryTurnsInFlight.has(sessionId)) {
            throw new Error('Use the retry command to resume an existing user turn');
        }
        assertRetryTurnAnchor(managed, activeMessageState.options!.automaticRecovery!.originalUserMessageId);
        if (cleanExplicitRetry) {
            const expectedRequestId = explicitRetryIntent!.contextLimitRequestId;
            if (expectedRequestId) {
                const candidate = sessionOpRetryableContextLimitRequest(sessionOperationContext, managed);
                if (!candidate || candidate.id !== expectedRequestId) {
                    throw new Error('The context-limit Retry prompt no longer owns this objective');
                }
                explicitRetryContextLimitRequest = candidate;
                explicitRetryContextLimitRequestBefore = {
                    status: candidate.status,
                    answeredAt: candidate.answeredAt,
                };
                sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed, false, candidate.id);
            }
            else {
                sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed, false, undefined, cleanRetryWithRetainedMachineInbox);
            }
        }
        else {
            sessionOpAssertRetryTurnUnblocked(sessionOperationContext, managed);
        }
        if (managed.isProcessing || managed.agent?.isProcessing()) {
            throw new RetryTurnAlreadyRunningError('The session is already processing');
        }
        if (explicitRetryAllowanceToken) {
            const intent = explicitRetryIntent;
            if (!intent || intent.sessionId !== sessionId || intent.userMessageId !== existingMessageId
                && intent.userMessageId !== activeMessageState.options?.automaticRecovery?.originalUserMessageId
                || intent.objectiveId !== (managed.activeObjective?.objectiveId ?? managed.activeObjective?.userMessageId)
                || intent.cancellationEpoch !== (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0)) {
                throw new Error('The explicit Retry allowance no longer belongs to this objective');
            }
        }
    }
    // Only the private existing-message dispatch seam can carry a validated human
    // answer. Public sendMessage options alone cannot impersonate this authority.
    const trustedUserInput = sessionOpExactUserInputResponse(sessionOperationContext, managed, existingMessageId, activeMessageState.message, activeMessageState.options);
    if (activeMessageState.options?.internalOrigin?.kind === 'user-input' && !trustedUserInput) {
        throw new Error('User answers must be submitted through the question response endpoint');
    }
    if (trustedUserInput && (trustedUserInput.objectiveUserMessageId !== managed.activeObjective?.userMessageId
        || sessionOpHasTerminalObjectiveState(sessionOperationContext, managed))) {
        const staleMessage = managed.messages.find(candidate => candidate.id === existingMessageId);
        if (staleMessage)
            staleMessage.isQueued = false;
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        throw new Error('The answer belongs to an objective that is no longer active');
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
    const myGeneration = managed.processingGeneration + 1;
    if (supersedableAutomaticRecovery)
        automaticDispatchGeneration = myGeneration;
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

    let deliveryAttemptsBeforePreparation: number | undefined;

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
    if (!preparedUserMessage) return;
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
    const localCompactCommand = !attachments?.length
        && parseCompactCommand(activeMessageState.message.trim()) !== null;
    managed.lastMessageAt = Date.now();
    managed.streamingText = '';
    managed.streamingTurnId = undefined;
    managed.pendingRuntimeProviderFallback = undefined;
    managed.turnStartFinalMessageId = sessionOpGetLastFinalAssistantMessageId(sessionOperationContext, managed.messages);
    deliveryAttemptsBeforePreparation = userMessage.agentDelivery?.attempts;
    const rollbackQueuedAgentDeliveryPreparation = async (reason: string, setupError?: unknown): Promise<boolean> => {
        const receipt = userMessage.agentDelivery;
        const dispatch = queuedAgentDeliveryDispatch;
        if (!receipt || !queuedItem || queuedItem.messageId !== userMessage.id
            || !queuedDispatchToken || !dispatch
            || dispatch.dispatchToken !== queuedDispatchToken
            || dispatch.deliveryId !== receipt.id
            || (sessionOperationContext.state.queuedMessageDispatches.get(sessionId) !== queuedDispatchToken
                && sessionOperationContext.state.queuedAgentDeliveryDispatches.get(userMessage.id) !== dispatch))
            return false;
        receipt.status = 'queued';
        userMessage.isQueued = true;
        if (deliveryAttemptsBeforePreparation !== undefined) {
            receipt.attempts = deliveryAttemptsBeforePreparation;
        }
        if (setupError !== undefined) {
            const failure = classifyAgentFailure(cleanRetrySetupFailureSignal(setupError));
            const setupFailureCount = (receipt.setupFailureCount ?? 0) + 1;
            const failureLimit = failure.retryability === 'never'
                ? 1
                : failure.retryability === 'conditional' || failure.failureClass === 'rate-limited'
                    ? MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES
                    : MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES;
            const blocked = setupFailureCount >= failureLimit;
            const setupFailureAt = Date.now();
            const setupRetryDelayMs = Math.max(250 * (2 ** Math.min(setupFailureCount - 1, 7)), failure.retryAfterMs ?? 0);
            receipt.setupFailureCount = setupFailureCount;
            receipt.lastSetupFailureClass = failure.failureClass;
            if (blocked) {
                receipt.setupRetryBlockedAt = setupFailureAt;
                receipt.setupRetryNotBefore = undefined;
            }
            else {
                receipt.setupRetryBlockedAt = undefined;
                receipt.setupRetryNotBefore = setupFailureAt + Math.min(Math.max(0, setupRetryDelayMs), Number.MAX_SAFE_INTEGER - setupFailureAt);
            }
        }
        if (managed.activeAgentDelivery?.generation === myGeneration
            && managed.activeAgentDelivery.deliveryId === receipt.id) {
            managed.activeAgentDelivery = undefined;
        }
        if (!managed.messageQueue.some(item => item === queuedItem
            || item.messageId === queuedItem.messageId)) {
            enqueueRecoveredMessageInTranscriptOrder(managed, queuedItem);
        }
        if (sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === queuedDispatchToken) {
            sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
        }
        sessionOpCompleteQueuedAgentDeliveryDispatch(sessionOperationContext, userMessage.id, queuedDispatchToken);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
        if (managed.processingGeneration === myGeneration && managed.isProcessing) {
            sessionOperationContext.owner["setProcessing"](managed, false);
        }
        receipt.setupPersistenceFencedAt = undefined;
        if (sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(sessionId) === receipt.id) {
            sessionOperationContext.state.agentDeliverySetupPersistenceFences.delete(sessionId);
        }
        const rollbackEnqueued = sessionOperationContext.owner["persistSession"](managed);
        let rollbackDurable = false;
        if (rollbackEnqueued) {
            try {
                await sessionOperationContext.owner.flushSession(managed.id);
                rollbackDurable = true;
            }
            catch (error) {
                sessionLog.warn('Failed to flush queued agent-delivery preparation rollback', {
                    sessionId,
                    messageId: userMessage.id,
                    reason,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        else {
            sessionLog.warn('Failed to queue agent-delivery preparation rollback for persistence', {
                sessionId,
                messageId: userMessage.id,
                reason,
            });
        }
        if (!rollbackDurable) {
            receipt.setupPersistenceFencedAt = Date.now();
            sessionOperationContext.state.agentDeliverySetupPersistenceFences.set(sessionId, receipt.id);
            // Best effort: when storage recovered after an uncertain first ACK,
            // persist a Retry-only fence. Runtime admission never depends on this
            // second write succeeding.
            if (sessionOperationContext.owner["persistSession"](managed)) {
                try {
                    await sessionOperationContext.owner.flushSession(managed.id);
                }
                catch (error) {
                    sessionLog.warn('Failed to persist agent-delivery setup fence', {
                        sessionId,
                        messageId: userMessage.id,
                        reason,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        return true;
    };
    if (!localCompactCommand && (trustedUserInput || shouldManageSessionStatusLifecycle(activeMessageState.options))) {
        try {
            await sessionOperationContext.owner["beginAutomaticSessionStatusLifecycle"](managed, explicitRetry, assertActivePreparation);
        }
        catch (error) {
            sessionLog.warn('Automatic session status start transition failed; continuing turn', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (!ownsActiveTurn()) {
            await abandonStoppedTurn();
            return;
        }
        if (await finishSupersededAutomaticRecovery())
            return;
    }
    // Reset auth retry flag for this new message (allows one retry per message)
    // IMPORTANT: Skip reset if this is an auth retry call - the flag is already true
    // and resetting it would allow infinite retry loops
    // Note: authRetryInProgress is NOT reset here - it's managed by the retry logic
    if (!_isAuthRetry) {
        managed.authRetryAttempted = false;
    }
    // Store message/attachments for potential retry after auth refresh
    // (SDK subprocess caches token at startup, so if it expires mid-session,
    // we need to recreate the agent and retry the message)
    managed.lastSentMessage = activeMessageState.message;
    managed.lastSentAttachments = attachments;
    managed.lastSentStoredAttachments = storedAttachments;
    managed.lastSentOptions = activeMessageState.options;
    // Persist an in-flight marker before model streaming begins. A packaged-app
    // replacement can terminate every subprocess cleanly (exit 0) without the
    // normal completion path running; this marker is the durable resume seam.
    const objectiveAdmission = await admitSessionMessageObjective({
        managed,
        activeMessageState,
        trustedUserInput,
        sessionOperationContext,
        userMessage,
        localCompactCommand,
        durablyAcknowledged,
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
    });
    if (!objectiveAdmission) return;
    const { trustedContextLimitAnswer, contextLimitAnswerSetupRollback, cleanRecoveryProviderReset } = objectiveAdmission;
    if (!ownsActiveTurn()) {
        await abandonStoppedTurn();
        return;
    }
    const workspaceRootPath = managed.workspace.rootPath;
    const inheritedSourcesChanged = refreshInheritedWorkspaceSources(managed);
    if (inheritedSourcesChanged) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'sources_changed',
            sessionId: managed.id,
            enabledSourceSlugs: managed.enabledSourceSlugs ?? [],
        }, managed.workspace.id);
    }
    if (inheritedSourcesChanged && managed.agent) {
        await sessionOpReloadSessionSourcesWithinOperation(sessionOperationContext, managed);
        assertActivePreparation();
    }
    // Pre-enable sources required by invoked skills (Issue #249)
    // This eliminates the two-turn penalty where the agent discovers missing sources at runtime.
    // Uses targeted loadSkillBySlug() instead of loadAllSkills() to avoid O(N) filesystem scans.
    if (activeMessageState.options?.skillSlugs?.length) {
        try {
            const workspaceRoot = managed.workspace.rootPath;
            const requiredSources = new Set<string>();
            for (const slug of activeMessageState.options.skillSlugs) {
                const skill = loadSkillBySlug(workspaceRoot, slug, managed.workingDirectory);
                if (skill?.metadata.requiredSources) {
                    for (const src of skill.metadata.requiredSources) {
                        requiredSources.add(src);
                    }
                }
            }
            if (requiredSources.size > 0) {
                const currentSlugs = new Set(managed.enabledSourceSlugs || []);
                const toEnable: string[] = [];
                const skipped: string[] = [];
                const candidateSlugs = Array.from(requiredSources);
                const loadedSources = getSourcesBySlugs(workspaceRoot, candidateSlugs);
                const usableSources = new Set(loadedSources
                    .filter(isSourceUsable)
                    .map(source => source.config.slug));
                for (const srcSlug of candidateSlugs) {
                    if (currentSlugs.has(srcSlug))
                        continue;
                    if (usableSources.has(srcSlug)) {
                        toEnable.push(srcSlug);
                    }
                    else {
                        skipped.push(srcSlug);
                    }
                }
                if (skipped.length > 0) {
                    sessionLog.warn(`Skill requires sources that are not usable (missing or unauthenticated): ${skipped.join(', ')}`);
                }
                if (toEnable.length > 0) {
                    if (hasImmutableMissionRoute(managed)) {
                        throw new Error('Route-sealed Mission session cannot auto-enable skill sources');
                    }
                    managed.enabledSourceSlugs = [...(managed.enabledSourceSlugs || []), ...toEnable];
                    managed.inheritsWorkspaceSourceSlugs = false;
                    sessionLog.info(`Pre-enabled sources for skill invocation: ${toEnable.join(', ')}`);
                    sessionOperationContext.owner["persistSession"](managed);
                    sessionOperationContext.owner["sendEvent"]({
                        type: 'sources_changed',
                        sessionId,
                        enabledSourceSlugs: managed.enabledSourceSlugs,
                    }, managed.workspace.id);
                }
            }
        }
        catch (e) {
            sessionLog.warn(`Failed to pre-enable skill sources for session ${sessionId}:`, e);
        }
    }
    // Start perf span for entire sendMessage flow
    const sendSpan = perf.span('session.sendMessage', { sessionId });
    const finishDeferredPreparation = async () => {
        if (!ownsActiveTurn())
            return;
        sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
        restoreStartedAutomaticDispatch();
        userMessage.isQueued = true;
        if (userMessage.agentDelivery && deliveryAttemptsBeforePreparation !== undefined) {
            userMessage.agentDelivery.attempts = deliveryAttemptsBeforePreparation;
            userMessage.agentDelivery.status = 'queued';
            if (managed.activeAgentDelivery?.generation === myGeneration
                && managed.activeAgentDelivery.deliveryId === userMessage.agentDelivery.id) {
                managed.activeAgentDelivery = undefined;
            }
        }
        if (!managed.messageQueue.some(item => item.messageId === userMessage.id)) {
            managed.messageQueue.unshift(queuedItem?.messageId === userMessage.id ? queuedItem
                : { message: activeMessageState.message, attachments, storedAttachments, options: activeMessageState.options, messageId: userMessage.id });
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
        sendSpan.end();
        if (ownsActiveTurn())
            await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'interrupted', myGeneration);
    };
    const finishCancelledPreparation = async () => {
        sendSpan.mark('agent.preparation_cancelled');
        sendSpan.end();
        // Stop may finish before lazy runtime preparation returns. Dispose that
        // late runtime, but never clean up a newer request or emit its completion.
        if (managed.processingGeneration !== myGeneration)
            return;
        if ((managed.agent || managed.poolServer || managed.mcpPool) && !sessionOpHasRunningBackgroundTasks(sessionOperationContext, managed)) {
            await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'cancelled turn preparation');
        }
        await abandonStoppedTurn();
    };
    const finishSupersededSourceActivation = async () => {
        if (!sourceActivationOrigin)
            return;
        sendSpan.mark('source_activation.superseded');
        sendSpan.end();
        const pending = managed.autoRetryPending;
        if (pending?.sourceActivationId === sourceActivationOrigin.sourceActivationId
            && pending.providerStarted !== true) {
            cancelSourceActivationPending(managed, pending);
        }
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
        const sourceIndex = managed.messages.findIndex(candidate => candidate.id === userMessage.id
            && candidate.internalOrigin?.kind === 'source-activation');
        if (sourceIndex >= 0)
            managed.messages.splice(sourceIndex, 1);
        if (managed.processingGeneration === myGeneration && managed.isProcessing) {
            sessionOperationContext.owner["setProcessing"](managed, false);
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }
    };
    const finishSupersededAuthenticatedInternalContinuation = async () => {
        if (!authenticatedInternalContinuationToken)
            return;
        sessionOpConsumeAuthenticatedInternalContinuation(sessionOperationContext, authenticatedInternalContinuationToken);
        if (existingMessageId) {
            if (existingTurnRollback)
                existingTurnRollback();
            else if (managed.processingGeneration === myGeneration && managed.isProcessing) {
                // Auth retry reuses the immutable original user row and therefore has
                // no explicit Retry/user-input rollback closure. Release only this
                // stale generation; the newer objective/FIFO state is authoritative.
                sessionOperationContext.owner["setProcessing"](managed, false);
            }
        }
        else {
            managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
            const index = managed.messages.indexOf(userMessage);
            if (index >= 0 && userMessage.hidden
                && (userMessage.internalOrigin?.kind === 'auth-result'
                    || userMessage.internalOrigin?.kind === 'auth-retry')) {
                managed.messages.splice(index, 1);
            }
            if (managed.processingGeneration === myGeneration && managed.isProcessing) {
                sessionOperationContext.owner["setProcessing"](managed, false);
            }
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
            sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        }
    };
    const finishSupersededDelegatedDispatch = async () => {
        if (!delegatedDispatchContinuationToken)
            return;
        sessionOpConsumeDelegatedDispatchContinuation(sessionOperationContext, delegatedDispatchContinuationToken);
        managed.messageQueue = managed.messageQueue.filter(item => item.messageId !== userMessage.id);
        const index = managed.messages.indexOf(userMessage);
        if (index >= 0 && userMessage.internalOrigin?.kind === 'spawned-session') {
            managed.messages.splice(index, 1);
        }
        if (managed.activeObjective?.userMessageId === userMessage.id) {
            managed.activeObjective = undefined;
        }
        if (managed.pendingTurnRecovery?.userMessageId === userMessage.id) {
            managed.pendingTurnRecovery = undefined;
        }
        if (managed.processingGeneration === myGeneration && managed.isProcessing) {
            sessionOperationContext.owner["setProcessing"](managed, false);
        }
        if (managed.lastSentMessage === activeMessageState.message) {
            managed.lastSentMessage = undefined;
            managed.lastSentAttachments = undefined;
            managed.lastSentStoredAttachments = undefined;
            managed.lastSentOptions = undefined;
        }
        if (managed.delegation && !managed.delegation.finishedAt) {
            managed.delegation.finishedAt = sessionOpMonotonic(sessionOperationContext);
        }
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(sessionId);
    };
    const enabledSlugs = managed.enabledSourceSlugs ?? [];
    const hasSources = enabledSlugs.length > 0;

    const runtimePreparation = await prepareSessionAgentRuntime({
        managed,
        activeMessageState,
        userMessage,
        trustedUserInput,
        sessionOperationContext,
        assertActivePreparation,
        sendSpan,
        sessionId,
        myGeneration,
        hasSources,
        workspaceRootPath,
        enabledSlugs,
        ownsActiveTurn,
        cleanRecoveryProviderReset,
        trustedContextLimitAnswer,
        finishSupersededDelegatedDispatch,
        finishSupersededAuthenticatedInternalContinuation,
        finishSupersededAutomaticRecovery,
        finishSupersededSourceActivation,
        finishCancelledPreparation,
        finishDeferredPreparation,
        contextLimitAnswerSetupRollback,
        removeSyntheticAutomaticMessage,
        rollbackQueuedAgentDeliveryPreparation,
        cleanExplicitRetry,
        cleanExplicitRetrySetupRollback,
        restoreStartedAutomaticDispatch,
    });
    if (!runtimePreparation) return;
    const { agent, cleanRecoveryHandoffPrompt } = runtimePreparation;
    const activeProviderState = createProviderTurnState();
    const providerTurnInput: ProviderTurnInput = {
        assertActivePreparation,
        sessionId,
        managed,
        activeMessageState,
        agent,
        attachments,
        cleanRecoveryHandoffPrompt,
        sessionOperationContext,
        userMessage,
        workspaceRootPath,
        sendSpan,
        sourceActivationOrigin,
        myGeneration,
        localCompactCommand,
        authenticatedInternalContinuationToken,
        delegatedDispatchContinuationToken,
        activeProviderState,
        deliveryAttemptsBeforePreparation,
        queuedDispatchToken,
        ownsActiveTurn,
        abandonStoppedTurn,
        lastMessageRoleBeforeDispatch,
        recoveryHandoffPaused,
        finishSupersededAuthenticatedInternalContinuation,
        finishSupersededAutomaticRecovery,
        finishSupersededSourceActivation,
        finishDeferredPreparation,
        finishCancelledPreparation,
        contextLimitAnswerSetupRollback,
        cleanExplicitRetry,
        cleanExplicitRetrySetupRollback,
        restoreStartedAutomaticDispatch,
        removeSyntheticAutomaticMessage,
        rollbackQueuedAgentDeliveryPreparation,
    };
    return executeSessionProviderTurn(providerTurnInput);
}

export { sessionOpPerformSendMessage as performSendMessage };
