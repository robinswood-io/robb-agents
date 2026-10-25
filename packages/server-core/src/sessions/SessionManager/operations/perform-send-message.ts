import { executeSessionProviderTurn } from './execute-provider-turn.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';
import { createProviderTurnState } from './provider-turn-state.ts';
import { enqueueSessionMessage } from './enqueue-session-message.ts';
import type { SessionOperationContext, SessionMessageState } from '../operation-context.ts';
import { refreshInheritedWorkspaceSources, hasPendingLocalUserInput, queuedCostLimitContinuationForAgentDelivery, assertRetryTurnAnchor, queuedDirectHumanContinuationIndex, nextRecoveryDispatch, validAllocatedRecoveryDispatch, cleanRetrySetupFailureSignal, enqueueRecoveredMessageInTranscriptOrder, persistenceRootFor, isExactQueuedSourceActivation, cancelSourceActivationPending, commitSourceActivationPending, releaseSourceActivationClaim, projectLegacyObjectiveForUserTransition, repairLegacyContextualObjectiveAuthority, isDirectHumanContinuation, assertSpecializedMissionSourceSelection, captureSpecializedMissionSourceSnapshot, ordinaryMissionSourceBuildOptions, rehydrateObjectiveEvidence } from '../policy.ts';
import { AGENT_RUNTIME_ACTIVITY } from '@craft-agent/core/types';
import { reopenCompletedChat } from '../../completed-chat-retention';
import { restoreAgentDeliveryAttachments } from '../../agent-delivery.ts';

import type { UserInputRequest } from '@craft-agent/core';

import { classifyAgentFailure, parseCompactCommand } from '@craft-agent/shared/agent';
import { resolveSessionConnection } from '@craft-agent/shared/agent/backend';
import { decideCostProviderAdmission, monetaryBudgetCostUsd, resolveAgentCostBudgetState, resolveAgentCostControlPolicy, resolveEffectiveAgentContextLimits } from '@craft-agent/shared/config';
import type { CostControlledTurnKind } from '@craft-agent/shared/config';

import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { clearPendingPlanExecution as clearStoredPendingPlanExecution, getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { loadAllSources, getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources';
import type { LoadedSource } from '@craft-agent/shared/sources';

import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol';
import { CodedError, generateMessageId } from '@craft-agent/shared/protocol';
import type { Message, StoredAttachment } from '@craft-agent/core/types';
import { perf, readFileAttachment } from '@craft-agent/shared/utils';
import { loadSkillBySlug } from '@craft-agent/shared/skills';

import { bindBusinessProcedure } from '../../business-procedures';

import { explicitRetryProgressFingerprint } from '../../explicit-retry-progress';

import { shouldManageSessionStatusLifecycle } from '../../session-status-lifecycle';
import { turnRecoveryValidationFingerprint, buildCleanRecoveryContinuationPrompt, createPendingTurnRecovery, grantExplicitRetryAllowance, reconstructLegacyTurnRecoveryBudget } from '../../turn-recovery';

import { resolveContextTokenEstimate } from '../../context-token-estimate';
import { isHostSyntheticObjectiveText, objectiveCostUsd, transitionObjectiveContract } from '../../objective-contract';
import { COST_CONTROL_COMPACTION_INSTRUCTIONS, assessContextCompactionResult, classifyContextCompactionFailure, consumeContextProviderBaselineAdmission, decideContextProviderAdmission, isHardLimitFollowUpContextCompaction, isHardLimitRecoveryContextCompaction, shouldAttemptContextCompaction } from '../../context-compaction';
import { sanitizeForTitle } from '@craft-agent/server-core/domain';
import { normalizeRecoveryValidationGapsForProgress } from '../../recovery-progress';
import type { ManagedSession } from '../managed-session.ts';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { delegatedObjectiveRoleForSession, isTerminalReviewSession } from '../review-lifecycle.ts';
import { sessionLog, sessionRuntimeHooks } from '../runtime-platform.ts';
import { AutomaticRecoverySupersededError, AutonomousAdmissionDeferredError, CleanRecoveryDispatchAuthenticationError, DelegatedDispatchSupersededError, InternalContinuationSupersededError, RetryTurnAlreadyRunningError, SourceActivationSupersededError } from '../runtime-policy.ts';
import type { AgentInstance } from '../runtime-types.ts';
import type { SourceActivationOrigin } from '../source-activation.ts';
import { claimAutoRetryPending, isSourceActivationOriginCurrent, sourceActivationObjectiveBinding } from '../source-activation.ts';
import { buildServersFromSources, refreshExpiredCredentials } from '../source-build.ts';
import { COST_LIMIT_NEXT_STEP_QUESTIONS, MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES, MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES, canonicalUserInputAnswerContents, isCostLimitContinuationAnswer, isExactContextLimitNextStepQuestion, resolveManagedSessionContextWindow } from '../user-input-authority.ts';
import type { SessionOperations } from '../operation-types.ts';
import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState, repairLegacySyntheticObjectiveAuthority as sessionOpRepairLegacySyntheticObjectiveAuthority, revokePendingToolPermissionsForDirectContinuation as sessionOpRevokePendingToolPermissionsForDirectContinuation, dropDeferredSourceActivations as sessionOpDropDeferredSourceActivations, hasPendingDecision as sessionOpHasPendingDecision } from './repair-legacy-synthetic-objective-authority.ts';
import { isFreshStaleTypedUpwardAgentDelivery as sessionOpIsFreshStaleTypedUpwardAgentDelivery, releasableUpwardAgentDeliverySenderId as sessionOpReleasableUpwardAgentDeliverySenderId, isStaleTypedUpwardAgentDelivery as sessionOpIsStaleTypedUpwardAgentDelivery, quarantineStaleTypedUpwardAgentDelivery as sessionOpQuarantineStaleTypedUpwardAgentDelivery } from './quarantine-stale-typed-upward-agent-delivery.ts';
import { authenticatedInternalContinuationCurrent as sessionOpAuthenticatedInternalContinuationCurrent, consumeAuthenticatedInternalContinuation as sessionOpConsumeAuthenticatedInternalContinuation, delegatedDispatchContinuationCurrent as sessionOpDelegatedDispatchContinuationCurrent, consumeDelegatedDispatchContinuation as sessionOpConsumeDelegatedDispatchContinuation, claimAuthenticatedInternalContinuation as sessionOpClaimAuthenticatedInternalContinuation } from './message-authority.ts';
import { stripDisabledAllocatedRoutingFallback as sessionOpStripDisabledAllocatedRoutingFallback, startRecoveryDispatch as sessionOpStartRecoveryDispatch, fenceCleanSetupPersistence as sessionOpFenceCleanSetupPersistence, clearDeferredAutomaticRetry as sessionOpClearDeferredAutomaticRetry } from './start-recovery-dispatch.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage, isExactRepurposedUserInputCleanBoundary as sessionOpIsExactRepurposedUserInputCleanBoundary } from './user-input-recovery.ts';
import { untrackSyntheticAutomaticMessage as sessionOpUntrackSyntheticAutomaticMessage, providerDispatchAdmissionBarrier as sessionOpProviderDispatchAdmissionBarrier } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { hasAcceptedHumanContinuationQueued as sessionOpHasAcceptedHumanContinuationQueued, cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries, consumeLiveDirectHumanContinuation as sessionOpConsumeLiveDirectHumanContinuation, assertRetryTurnUnblocked as sessionOpAssertRetryTurnUnblocked, hasConsumedCleanRecoveryDispatch as sessionOpHasConsumedCleanRecoveryDispatch } from './create-autonomous-context-limit-handoff.ts';
import { setLastMessageClientId as sessionOpSetLastMessageClientId, monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { settleQueuedAgentDeliveryDispatch as sessionOpSettleQueuedAgentDeliveryDispatch, completeQueuedAgentDeliveryDispatch as sessionOpCompleteQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import { cancelPendingAuthForHumanContinuation as sessionOpCancelPendingAuthForHumanContinuation } from './downgrade-cold-auth-resume-permission.ts';
import { isAutonomousMessage as sessionOpIsAutonomousMessage } from './is-current-delegated-descendant.ts';
import { canRetryRetainedMachineInbox as sessionOpCanRetryRetainedMachineInbox, hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, exactQueuedAgentDeliveryReceipt as sessionOpExactQueuedAgentDeliveryReceipt } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { retryableContextLimitRequest as sessionOpRetryableContextLimitRequest } from './retryable-context-limit-request.ts';
import { exactUserInputResponse as sessionOpExactUserInputResponse, autonomousAdmissionBlock as sessionOpAutonomousAdmissionBlock } from './exact-user-input-response.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput, contextLimitHostAdmissionBoundary as sessionOpContextLimitHostAdmissionBoundary, consumeQueuedCostLimitContinuation as sessionOpConsumeQueuedCostLimitContinuation } from './perform-request-user-input.ts';

import { captureUserCorrection as sessionOpCaptureUserCorrection, loadSessionPlaybook as sessionOpLoadSessionPlaybook } from './capture-user-correction.ts';
import { trackSyntheticAutomaticMessage as sessionOpTrackSyntheticAutomaticMessage, getInterruptedTurnRecovery as sessionOpGetInterruptedTurnRecovery, hasValidationExhaustionMarker as sessionOpHasValidationExhaustionMarker } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { objectiveContractTextFor as sessionOpObjectiveContractTextFor, getCollectionSummarizer as sessionOpGetCollectionSummarizer } from './try-refresh-agent-runtime.ts';
import { boundCleanUserInputRequest as sessionOpBoundCleanUserInputRequest } from './context-limit-authenticated-answer-evidence.ts';
import { scheduleTitleGeneration as sessionOpScheduleTitleGeneration } from './schedule-title-generation.ts';
import { evaluateAndApplyAutoLabels as sessionOpEvaluateAndApplyAutoLabels } from './perform-adopt-generated-task-orchestrator.ts';
import { getLastFinalAssistantMessageId as sessionOpGetLastFinalAssistantMessageId } from './session-sources.ts';
import { createContextLimitRetryHandoff as sessionOpCreateContextLimitRetryHandoff } from './create-context-limit-retry-handoff.ts';
import { reloadSessionSourcesWithinOperation as sessionOpReloadSessionSourcesWithinOperation } from './workspace-configuration.ts';
import { hasRunningBackgroundTasks as sessionOpHasRunningBackgroundTasks } from './evict-idle-session-runtimes.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo, stopYoloHumanHandoff as sessionOpStopYoloHumanHandoff } from './is-managed-session-yolo.ts';
import { retainFailedCleanRetrySetup as sessionOpRetainFailedCleanRetrySetup } from './retain-failed-clean-retry-setup.ts';

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
    let durablyAcknowledged = false;
    let userMessage: Message;
    let deliveryAttemptsBeforePreparation: number | undefined;
    let existingTurnRollback: (() => void) | undefined;
    let cleanExplicitRetrySetupRollback: (() => string | undefined) | undefined;
    let trustedContextLimitAnswer: UserInputRequest | undefined;
    let contextLimitAnswerSetupRollback: (() => string | undefined) | undefined;
    let cleanRecoveryProviderStateAtomized = false;
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
    if (existingMessageId) {
        // Find existing message (already added when queued)
        userMessage = managed.messages.find(m => m.id === existingMessageId)!;
        if (!userMessage) {
            throw new Error(`Existing message ${existingMessageId} not found`);
        }
        if (supersedableAutomaticRecovery && userMessage.role === 'user' && userMessage.hidden) {
            // A deferred pre-chat recovery reuses its durable message. Adopt the
            // same identity so Stop/human supersession can still remove it, and so
            // the provider boundary below releases the original tracking entry.
            activeMessageState.syntheticAutomaticMessage = userMessage;
            sessionOpTrackSyntheticAutomaticMessage(sessionOperationContext, managed, userMessage);
        }
        if (explicitRetry || trustedUserInput) {
            const previousObjective = managed.activeObjective;
            const previousRecovery = managed.pendingTurnRecovery;
            const previousStatus = managed.sessionStatus;
            const previousQueued = userMessage.isQueued;
            if (explicitRetry) {
                const retryRecovery = previousRecovery ?? sessionOpGetInterruptedTurnRecovery(sessionOperationContext, managed, userMessage.id)
                    ?? ((previousObjective?.lastUserMessageId ?? previousObjective?.userMessageId) === userMessage.id
                        ? reconstructLegacyTurnRecoveryBudget(managed.messages, userMessage.id)
                        : undefined);
                managed.activeObjective = previousObjective
                    ? { ...previousObjective, interruptedTurnRecovery: undefined, terminalState: 'active', completedAt: undefined }
                    : transitionObjectiveContract({
                        messageId: userMessage.id,
                        text: sessionOpObjectiveContractTextFor(sessionOperationContext, managed, userMessage),
                    });
                managed.pendingTurnRecovery = {
                    ...(retryRecovery ?? createPendingTurnRecovery(userMessage.id)),
                    // A human can retry an old objective, but a missing historical
                    // marker cannot grant that objective a new automatic allowance.
                    ...(!retryRecovery && previousObjective ? {
                        budgetHistoryUnavailable: true,
                        // Older hosts also recognize this stop if the bundle is rolled back.
                        exhaustedAt: Date.now(),
                    } : {}),
                    ...(sessionOpHasValidationExhaustionMarker(sessionOperationContext, managed) ? { validationExhausted: true } : {}),
                    userMessageId: userMessage.id,
                    lastCause: 'user_retry',
                    waitingForPermission: undefined,
                    userRetryFromMessageCount: managed.messages.length,
                    continuationRequired: false,
                };
                if (explicitRetryAllowanceToken && previousObjective) {
                    // No await separates capability consumption from the state update.
                    // Failed durability rolls back both through existingTurnRollback.
                    sessionOperationContext.state.explicitRetryAllowanceTokens.delete(explicitRetryAllowanceToken);
                    const recoveryPolicy = resolveAgentCostControlPolicy(loadWorkspaceConfig(managed.workspace.rootPath)?.costControl).recovery;
                    const semanticProgressFingerprint = explicitRetryProgressFingerprint(managed.messages, previousObjective.userMessageId);
                    managed.pendingTurnRecovery = grantExplicitRetryAllowance(managed.pendingTurnRecovery, {
                        id: generateMessageId(), objectiveId: previousObjective.objectiveId ?? previousObjective.userMessageId,
                        userMessageId: userMessage.id, nowMs: Date.now(), maxAttempts: recoveryPolicy.maxAutomaticAttempts,
                        progressFingerprint: managed.pendingTurnRecovery.validationGaps?.length
                            ? turnRecoveryValidationFingerprint(normalizeRecoveryValidationGapsForProgress(managed.pendingTurnRecovery.validationGaps)) : semanticProgressFingerprint,
                        semanticProgressFingerprint,
                    });
                }
            }
            existingTurnRollback = () => {
                if (!ownsActiveTurn())
                    return;
                const changedStatus = managed.sessionStatus !== previousStatus;
                managed.activeObjective = previousObjective;
                managed.pendingTurnRecovery = previousRecovery;
                managed.sessionStatus = previousStatus;
                userMessage.isQueued = trustedUserInput ? true : previousQueued;
                managed.turnLifecycleManagedStatus = undefined;
                sessionOperationContext.owner["setProcessing"](managed, false);
                sessionOperationContext.owner["persistSession"](managed);
                if (changedStatus) {
                    sessionOperationContext.owner["sendEvent"]({ type: 'session_status_changed', sessionId, sessionStatus: previousStatus ?? 'todo' }, managed.workspace.id);
                }
            };
        }
        sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
        managed.processingGeneration = myGeneration;
        sessionOperationContext.owner["setProcessing"](managed, true);
        sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
        assertAuthenticatedInternalContinuation();
    }
    else {
        // Create new message
        userMessage = {
            // Bind a deferred automatic recovery to its durable dispatch identity.
            // Cold restore can then distinguish it from every other hidden message
            // without trusting prompt text.
            id: durableMessageId(),
            role: 'user',
            content: activeMessageState.message,
            timestamp: sessionOpMonotonic(sessionOperationContext),
            attachments: storedAttachments, // Include for persistence (has thumbnailBase64)
            ...(!activeMessageState.options?.hidden ? { isQueued: true } : {}),
            badges: activeMessageState.options?.badges, // Include content badges (sources, skills with embedded icons)
            // Hidden system-generated messages reach the model but never render as a
            // transcript bubble (e.g. background-task-completion nudge).
            ...(activeMessageState.options?.hidden ? { hidden: true } : {}),
            ...(activeMessageState.options?.internalOrigin ? { internalOrigin: activeMessageState.options.internalOrigin } : {}),
            ...(activeMessageState.options?.internalOrigin?.deliveryId ? {
                isQueued: true,
                agentDelivery: { id: activeMessageState.options.internalOrigin.deliveryId, status: 'queued' as const, attempts: 0, attachmentsSha256: activeMessageState.options.internalOrigin.attachmentsSha256 },
            } : {}),
        };
        managed.messages.push(userMessage);
        if (cleanExplicitRetry) {
            const retryAnchorId = activeMessageState.options!.automaticRecovery!.originalUserMessageId;
            const previousObjective = managed.activeObjective;
            const previousRecovery = managed.pendingTurnRecovery;
            const previousStatus = managed.sessionStatus;
            const previousFencedDispatch = previousRecovery?.recoveryDispatch;
            const previousFencedDispatchId = sessionOperationContext.state.cleanRetrySetupPersistenceFences.get(managed.id);
            const previousFencedQueueItems: Array<{
                item: ManagedSession['messageQueue'][number];
                index: number;
            }> = [];
            if (previousFencedDispatch && previousFencedDispatch.id === previousFencedDispatchId) {
                const fencedCleanContinuationId = previousFencedDispatch.cleanContinuationId;
                for (const [index, item] of managed.messageQueue.entries()) {
                    const recovery = item.options?.automaticRecovery;
                    if (recovery?.dispatchId === previousFencedDispatchId
                        && recovery.cleanContinuationId === fencedCleanContinuationId) {
                        previousFencedQueueItems.push({ item, index });
                    }
                }
            }
            const previousProviderContextBoundaryMessageId = managed.providerContextBoundaryMessageId;
            const previousProviderResumeState = {
                sdkSessionId: managed.sdkSessionId,
                branchFromSdkSessionId: managed.branchFromSdkSessionId,
                branchFromSessionPath: managed.branchFromSessionPath,
                branchFromSdkCwd: managed.branchFromSdkCwd,
                branchFromSdkTurnId: managed.branchFromSdkTurnId,
                branchContextStrategy: managed.branchContextStrategy,
                branchSeedApplied: managed.branchSeedApplied,
                tokenUsage: managed.tokenUsage ? { ...managed.tokenUsage } : undefined,
                contextCompactionAttempt: managed.contextCompactionAttempt
                    ? { ...managed.contextCompactionAttempt }
                    : undefined,
            };
            const queuedStateRemains = managed.messageQueue.length > 0
                || sessionOperationContext.state.queuedMessageDispatches.has(managed.id)
                || managed.messages.some(candidate => candidate !== userMessage && candidate.isQueued);
            if (explicitRetryIntent!.allowRetainedMachineInbox === true
                && queuedStateRemains && !sessionOpHasOnlyMachineInbox(sessionOperationContext, managed)) {
                managed.messages.splice(managed.messages.indexOf(userMessage), 1);
                throw new Error('The retained inbox changed before the recovered clean Retry was accepted');
            }
            const retryRecovery = previousRecovery ?? sessionOpGetInterruptedTurnRecovery(sessionOperationContext, managed, retryAnchorId)
                ?? reconstructLegacyTurnRecoveryBudget(managed.messages, retryAnchorId)
                ?? createPendingTurnRecovery(retryAnchorId);
            // A cold-resumed context-limit answer has already committed its hidden
            // response row as the clean dispatch identity. Reclaiming that row and
            // rebuilding the provider boundary must keep the same host-owned
            // answer anchor; replacing it with the visible objective root drops the
            // structured answer evidence and makes the deterministic handoff fail
            // authentication immediately before agent.chat().
            const recoveredCleanAnswerSourceId = explicitRetryIntent!.grantNewAllowance === false
                && previousRecovery?.userMessageId === userMessage.id
                && previousRecovery.recoveryDispatch?.id === userMessage.id
                && previousRecovery.recoveryDispatch.cleanContinuationId === explicitRetryIntent!.cleanContinuationId
                && sessionOpBoundCleanUserInputRequest(sessionOperationContext, managed, previousRecovery)
                ? previousRecovery.userMessageId
                : undefined;
            if (!previousObjective || userMessage.id !== explicitRetryIntent!.cleanBoundaryMessageId
                || userMessage.id !== activeMessageState.options!.automaticRecovery!.dispatchId
                || activeMessageState.message !== sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, { ...retryRecovery, lastCause: 'user_retry' }, {
                    schemaVersion: 1,
                    id: userMessage.id,
                    attempt: activeMessageState.options!.automaticRecovery!.dispatchAttempt!,
                    cause: 'user_retry',
                    origin: 'retry',
                    allocatedAt: activeMessageState.options!.automaticRecovery!.dispatchAllocatedAt!,
                    phase: 'allocated',
                    cleanContinuationId: explicitRetryIntent!.cleanContinuationId,
                })) {
                managed.messages.splice(managed.messages.indexOf(userMessage), 1);
                throw new Error('The clean Retry boundary failed its private capability binding');
            }
            if (previousFencedQueueItems.length) {
                const fencedItems = new Set(previousFencedQueueItems.map(({ item }) => item));
                managed.messageQueue = managed.messageQueue.filter(item => !fencedItems.has(item));
            }
            managed.activeObjective = {
                ...previousObjective,
                interruptedTurnRecovery: undefined,
                terminalState: 'active',
                completedAt: undefined,
            };
            managed.pendingTurnRecovery = {
                ...retryRecovery,
                ...(sessionOpHasValidationExhaustionMarker(sessionOperationContext, managed) ? { validationExhausted: true } : {}),
                userMessageId: recoveredCleanAnswerSourceId ?? retryAnchorId,
                lastCause: 'user_retry',
                waitingForPermission: undefined,
                // This index is the unique fresh provider boundary row, not a replay
                // of the earlier accepted human anchor.
                userRetryFromMessageCount: diagnosticFromMessageCount,
                continuationRequired: false,
            };
            sessionOperationContext.state.explicitRetryAllowanceTokens.delete(explicitRetryAllowanceToken!);
            if (explicitRetryIntent!.grantNewAllowance !== false) {
                const recoveryPolicy = resolveAgentCostControlPolicy(loadWorkspaceConfig(managed.workspace.rootPath)?.costControl).recovery;
                const semanticProgressFingerprint = explicitRetryProgressFingerprint(managed.messages.slice(0, diagnosticFromMessageCount), previousObjective.userMessageId);
                managed.pendingTurnRecovery = grantExplicitRetryAllowance(managed.pendingTurnRecovery, {
                    id: generateMessageId(),
                    objectiveId: previousObjective.objectiveId ?? previousObjective.userMessageId,
                    userMessageId: retryAnchorId,
                    nowMs: Date.now(),
                    maxAttempts: recoveryPolicy.maxAutomaticAttempts,
                    progressFingerprint: managed.pendingTurnRecovery.validationGaps?.length
                        ? turnRecoveryValidationFingerprint(normalizeRecoveryValidationGapsForProgress(managed.pendingTurnRecovery.validationGaps)) : semanticProgressFingerprint,
                    semanticProgressFingerprint,
                });
            }
            managed.pendingTurnRecovery = sessionOpStartRecoveryDispatch(sessionOperationContext, managed.pendingTurnRecovery, activeMessageState.options!.automaticRecovery!);
            managed.pendingTurnRecovery = {
                ...managed.pendingTurnRecovery,
                cleanContextBoundaryMessageId: userMessage.id,
            };
            if (explicitRetryContextLimitRequest?.status === 'pending') {
                explicitRetryContextLimitRequest.status = 'cancelled';
                explicitRetryContextLimitRequest.answeredAt = Math.max(Date.now(), explicitRetryContextLimitRequest.createdAt + 1, (explicitRetryContextLimitRequest.answeredAt ?? 0) + 1);
            }
            // Commit the provider detachment in the same first durable snapshot as
            // the clean boundary. A crash after that ACK must never reload the old
            // 134k provider session or its compaction baseline with a fresh prompt.
            resetProviderResumeStateForCleanBoundary(userMessage.id);
            cleanRecoveryProviderStateAtomized = true;
            existingTurnRollback = () => {
                if (!ownsActiveTurn())
                    return;
                const index = managed.messages.indexOf(userMessage);
                if (index >= 0)
                    managed.messages.splice(index, 1);
                managed.activeObjective = previousObjective;
                managed.pendingTurnRecovery = previousRecovery;
                managed.providerContextBoundaryMessageId = previousProviderContextBoundaryMessageId;
                managed.sdkSessionId = previousProviderResumeState.sdkSessionId;
                managed.branchFromSdkSessionId = previousProviderResumeState.branchFromSdkSessionId;
                managed.branchFromSessionPath = previousProviderResumeState.branchFromSessionPath;
                managed.branchFromSdkCwd = previousProviderResumeState.branchFromSdkCwd;
                managed.branchFromSdkTurnId = previousProviderResumeState.branchFromSdkTurnId;
                managed.branchContextStrategy = previousProviderResumeState.branchContextStrategy;
                managed.branchSeedApplied = previousProviderResumeState.branchSeedApplied;
                managed.tokenUsage = previousProviderResumeState.tokenUsage;
                managed.contextCompactionAttempt = previousProviderResumeState.contextCompactionAttempt;
                managed.sessionStatus = previousStatus;
                managed.messageQueue = managed.messageQueue.filter(item => (item.messageId !== userMessage.id
                    && item.options?.automaticRecovery?.dispatchId !== userMessage.id));
                for (const { item, index: previousIndex } of previousFencedQueueItems) {
                    const dispatchId = item.options?.automaticRecovery?.dispatchId;
                    if (managed.messageQueue.some(candidate => candidate === item
                        || dispatchId && candidate.options?.automaticRecovery?.dispatchId === dispatchId))
                        continue;
                    managed.messageQueue.splice(Math.min(previousIndex, managed.messageQueue.length), 0, item);
                }
                if (explicitRetryContextLimitRequest && explicitRetryContextLimitRequestBefore) {
                    explicitRetryContextLimitRequest.status = explicitRetryContextLimitRequestBefore.status;
                    explicitRetryContextLimitRequest.answeredAt = explicitRetryContextLimitRequestBefore.answeredAt;
                }
                managed.turnLifecycleManagedStatus = undefined;
                sessionOperationContext.owner["setProcessing"](managed, false);
                sessionOperationContext.owner["persistSession"](managed);
            };
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
        sessionOperationContext.owner["sendEvent"]({
            type: 'user_message',
            sessionId,
            message: userMessage,
            status: 'accepted',
            optimisticMessageId: activeMessageState.options?.optimisticMessageId
        }, managed.workspace.id);
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
        /** The answer is already durably acknowledged, but no provider work has
         * started yet. If either the legacy runtime build or the fresh-context
         * rebuild fails, atomically turn this exact host-owned answer into one
         * allocated clean boundary. This preserves its identity and recovery
         * attempt while letting the common bounded setup budget own every retry. */
        contextLimitAnswerSetupRollback = () => {
            const matchingRequests = (managed.userInputRequests ?? []).filter(candidate => (candidate.status === 'answered'
                && candidate.responseMessageId === userMessage.id
                && candidate.sessionId === managed.id
                && candidate.originWorkspaceId === managed.workspace.id
                && candidate.objectiveUserMessageId === managed.activeObjective?.userMessageId));
            if (!ownsActiveTurn() || !trustedContextLimitAnswer
                || matchingRequests.length !== 1 || matchingRequests[0] !== trustedContextLimitAnswer
                || !managed.userInputRequests?.includes(trustedContextLimitAnswer)
                || trustedContextLimitAnswer.status !== 'answered'
                || trustedContextLimitAnswer.responseMessageId !== userMessage.id
                || trustedContextLimitAnswer.objectiveUserMessageId !== managed.activeObjective?.userMessageId
                || !trustedContextLimitAnswer.answers?.length
                || !isExactContextLimitNextStepQuestion(trustedContextLimitAnswer))
                return undefined;
            const pending = managed.pendingTurnRecovery;
            const started = pending?.recoveryDispatch;
            if (!pending || started?.phase !== 'started' || started.id !== userMessage.id
                || started.origin !== 'retry' || started.cause !== 'user_retry'
                || pending.userMessageId !== userMessage.id || pending.lastCause !== 'user_retry'
                || !Number.isFinite(started.startedAt))
                return undefined;
            const matches = managed.messages.flatMap((candidate, index) => (candidate.id === userMessage.id ? [{ candidate, index }] : []));
            const match = matches.length === 1 ? matches[0] : undefined;
            if (!match || match.candidate !== userMessage || match.index !== managed.messages.length - 1
                || userMessage.role !== 'user' || userMessage.hidden !== true
                || userMessage.isQueued || userMessage.isPending || userMessage.agentDelivery
                || userMessage.internalOrigin?.kind !== 'user-input'
                || (userMessage.attachments?.length ?? 0) > 0
                || managed.messageQueue.some(item => item.messageId === userMessage.id))
                return undefined;
            let allocatedDispatch: NonNullable<PendingTurnRecovery['recoveryDispatch']> | undefined;
            let allocatedPending: PendingTurnRecovery | undefined;
            if (started.cleanContinuationId) {
                // This closure is reachable only from a setup catch before the first
                // provider event. Lifecycle telemetry may already have emitted an
                // autonomy event, so cold-restart inference is intentionally too
                // strict here. Authenticate the exact repurposed row, then derive the
                // allocated fixed point directly from the live no-provider seam.
                if (!sessionOpIsExactRepurposedUserInputCleanBoundary(sessionOperationContext, managed, trustedContextLimitAnswer, userMessage))
                    return undefined;
                allocatedDispatch = { ...started, phase: 'allocated' as const };
                delete allocatedDispatch.startedAt;
                for (let iteration = 0; iteration < 4; iteration += 1) {
                    const candidate: PendingTurnRecovery = {
                        ...pending,
                        recoveryDispatch: allocatedDispatch,
                    };
                    const contextLimit = sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, candidate);
                    const autonomous = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, candidate);
                    const matching = [autonomous, contextLimit].find(handoff => (handoff?.id === allocatedDispatch!.cleanContinuationId));
                    if (matching) {
                        if (validAllocatedRecoveryDispatch(candidate) !== allocatedDispatch
                            || sessionOpBoundCleanUserInputRequest(sessionOperationContext, managed, candidate) !== trustedContextLimitAnswer) {
                            return undefined;
                        }
                        allocatedPending = candidate;
                        break;
                    }
                    const next = autonomous ?? contextLimit;
                    if (!next)
                        return undefined;
                    allocatedDispatch = { ...allocatedDispatch, cleanContinuationId: next.id };
                }
            }
            else {
                const canonicalAnswers = canonicalUserInputAnswerContents(trustedContextLimitAnswer);
                if (!canonicalAnswers.includes(userMessage.content))
                    return undefined;
                const cleanPending: PendingTurnRecovery = {
                    ...pending,
                    cleanContinuationCount: (pending.cleanContinuationCount ?? 0) + 1,
                    recoveryDispatch: undefined,
                };
                const provisionalHandoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, cleanPending);
                if (!provisionalHandoff)
                    return undefined;
                const cleanDispatch = { ...started, cleanContinuationId: provisionalHandoff.id };
                delete cleanDispatch.fallbackIntent;
                const nextPending: PendingTurnRecovery = {
                    ...cleanPending,
                    recoveryDispatch: cleanDispatch,
                    cleanContextBoundaryMessageId: userMessage.id,
                };
                const finalHandoff = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, nextPending);
                const cleanPrompt = finalHandoff && buildCleanRecoveryContinuationPrompt(finalHandoff);
                if (!finalHandoff || !cleanPrompt)
                    return undefined;
                nextPending.recoveryDispatch = {
                    ...cleanDispatch,
                    cleanContinuationId: finalHandoff.id,
                };
                allocatedDispatch = {
                    ...nextPending.recoveryDispatch,
                    phase: 'allocated' as const,
                };
                delete allocatedDispatch.startedAt;
                // Changing started -> allocated is part of the deterministic handoff
                // identity. Rebind from host state without mutating the live session;
                // only the fully authenticated fixed point is committed below.
                for (let iteration = 0; iteration < 4; iteration += 1) {
                    const candidate: PendingTurnRecovery = {
                        ...nextPending,
                        recoveryDispatch: allocatedDispatch,
                    };
                    const contextLimit = sessionOpCreateContextLimitRetryHandoff(sessionOperationContext, managed, candidate);
                    const autonomous = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, candidate);
                    const matching = [autonomous, contextLimit].find(handoff => (handoff?.id === allocatedDispatch!.cleanContinuationId));
                    if (matching) {
                        if (validAllocatedRecoveryDispatch(candidate) !== allocatedDispatch
                            || sessionOpBoundCleanUserInputRequest(sessionOperationContext, managed, candidate) !== trustedContextLimitAnswer) {
                            return undefined;
                        }
                        allocatedPending = candidate;
                        break;
                    }
                    const next = autonomous ?? contextLimit;
                    if (!next)
                        return undefined;
                    allocatedDispatch = { ...allocatedDispatch, cleanContinuationId: next.id };
                }
            }
            if (!allocatedDispatch || !allocatedPending)
                return undefined;
            let cleanPrompt: string;
            try {
                cleanPrompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, allocatedPending, allocatedDispatch);
            }
            catch {
                return undefined;
            }
            managed.messages.splice(match.index, 1);
            managed.pendingTurnRecovery = allocatedPending;
            activeMessageState.message = cleanPrompt;
            managed.lastSentMessage = cleanPrompt;
            managed.lastSentOptions = activeMessageState.options;
            resetProviderResumeStateForCleanBoundary(userMessage.id);
            cleanRecoveryProviderStateAtomized = true;
            managed.messageQueue = managed.messageQueue.filter(item => (item.messageId !== allocatedDispatch.id
                && item.options?.automaticRecovery?.dispatchId !== allocatedDispatch.id));
            if (sessionOperationContext.state.queuedMessageDispatches.get(sessionId) === queuedDispatchToken) {
                sessionOperationContext.state.queuedMessageDispatches.delete(sessionId);
            }
            sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
            sessionOperationContext.owner["setProcessing"](managed, false);
            return allocatedDispatch.id;
        };
    }
    let cleanRecoveryProviderReset = (() => {
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
    let cleanRecoveryHandoffPrompt = cleanRecoveryProviderReset;
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
    let agent: AgentInstance;
    let cleanRecoveryConversionFlushFailed = false;
    try {
        // Monetary hard limits are provider-admission fences for every
        // autonomous continuation. This check deliberately runs before runtime
        // creation, source refresh, routing and compaction, so the blocked turn
        // cannot spend more merely while preparing a fallback. It is independent
        // from the automatic-routing switch: disabling routing preserves the
        // selected model but must not disable the configured cost safety limit.
        const admissionWorkspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
        const admissionCostPolicy = resolveAgentCostControlPolicy(admissionWorkspaceConfig?.costControl);
        const admissionOriginKind = activeMessageState.options?.internalOrigin?.kind;
        const admissionTurnKind: CostControlledTurnKind = (admissionOriginKind === 'user-input'
            ? 'direct'
            : admissionOriginKind)
            ?? (activeMessageState.options?.automaticRecovery
                ? 'automatic-recovery'
                : (managed.triggeredBy ? 'automation' : 'direct'));
        const admissionConnection = resolveSessionConnection(managed.llmConnection, admissionWorkspaceConfig?.defaults?.defaultLlmConnection);
        const admissionSessionCostUsd = monetaryBudgetCostUsd(admissionConnection, objectiveCostUsd(managed.activeObjective, managed.tokenUsage?.costUsd));
        const admissionBudgetState = resolveAgentCostBudgetState(admissionSessionCostUsd, admissionCostPolicy.budgets);
        const queuedCostLimitContinuation = admissionOriginKind === 'agent-message'
            && !!userMessage.agentDelivery
            ? queuedCostLimitContinuationForAgentDelivery(managed)
            : undefined;
        const directCostLimitContinuation = admissionOriginKind === 'user-input'
            && !!trustedUserInput
            && isCostLimitContinuationAnswer(trustedUserInput);
        const directHumanTurn = admissionTurnKind === 'direct'
            && !activeMessageState.options?.hidden
            && !activeMessageState.options?.internalOrigin
            && !activeMessageState.options?.automaticRecovery;
        const hasExplicitHardUsdBudget = typeof admissionWorkspaceConfig?.costControl?.budgets?.hardSessionUsd === 'number';
        const costProviderAdmission = decideCostProviderAdmission({
            budgetState: admissionBudgetState,
            turnKind: admissionTurnKind,
            hostAuthenticatedUserOverride: directHumanTurn
                || directCostLimitContinuation
                || !!queuedCostLimitContinuation
                || (sessionOpIsManagedSessionYolo(sessionOperationContext, managed) && !hasExplicitHardUsdBudget),
        });
        if (admissionCostPolicy.enabled && costProviderAdmission.action === 'pause-for-user') {
            sessionLog.warn('cost-control blocked autonomous provider admission at the hard session limit', {
                sessionId: managed.id,
                turnKind: admissionTurnKind,
                sessionCostUsd: admissionSessionCostUsd,
                hardSessionUsd: admissionCostPolicy.budgets.hardSessionUsd,
            });
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            assertActivePreparation();
            if (sessionOpIsManagedSessionYolo(sessionOperationContext, managed)) {
                await sessionOpStopYoloHumanHandoff(sessionOperationContext, managed, 'YOLO stopped at the configured hard cost limit. The objective remains incomplete; no budget override or human request was created.');
                assertActivePreparation();
                sendSpan.mark('cost.hard-limit-yolo-exhausted');
                sendSpan.end();
                await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'interrupted', myGeneration);
                return;
            }
            const hasPendingQuestion = managed.userInputRequests?.some(request => request.status === 'pending') === true;
            if (!hasPendingQuestion) {
                await sessionOperationContext.owner.requestUserInput(managed.id, COST_LIMIT_NEXT_STEP_QUESTIONS);
                assertActivePreparation();
            }
            sendSpan.mark('cost.hard-limit-provider-blocked');
            sendSpan.end();
            await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'interrupted', myGeneration);
            return;
        }
        if (queuedCostLimitContinuation) {
            await sessionOpConsumeQueuedCostLimitContinuation(sessionOperationContext, managed, queuedCostLimitContinuation);
            assertActivePreparation();
        }
        // Load enabled sources up-front so we can refresh tokens BEFORE getOrCreateAgent
        // runs its internal cold-session build. Otherwise that build sees stale tokens
        // and emits AUTH_REQUIRED, causing a brief "needs_auth" UI flicker before the
        // post-build refresh restores state (#710).
        let sources: LoadedSource[] = hasSources
            ? getSourcesBySlugs(workspaceRootPath, enabledSlugs)
            : [];
        assertSpecializedMissionSourceSelection(managed, enabledSlugs);
        if (managed.missionCapabilityLock) {
            if (sources.length !== enabledSlugs.length) {
                throw new Error('Specialized Mission source snapshot is incomplete');
            }
            sources = await captureSpecializedMissionSourceSnapshot(managed, sources);
            managed.missionTurnSourceSnapshot = sources;
        }
        if (hasSources && managed.tokenRefreshManager && !managed.missionCapabilityLock) {
            const refreshResult = await refreshExpiredCredentials(sources, managed.tokenRefreshManager);
            assertActivePreparation();
            if (refreshResult.failedSources.length > 0) {
                sessionLog.warn('[OAuth] Some sources failed token refresh:', refreshResult.failedSources.map(f => f.slug));
            }
            if (refreshResult.refreshedCount > 0) {
                sendSpan.mark('oauth.refreshed');
            }
        }
        // Get or create the agent (lazy loading). Its internal cold-session build
        // now sees fresh tokens. Every preparation failure is handled here so a
        // rejected postInit/source setup cannot leave the session stuck processing.
        managed.routingFallbackAttempts = 0;
        managed.routingAttemptedConnectionSlugs = new Set();
        while (true) {
            assertActivePreparation();
            try {
                agent = await sessionOperationContext.owner["getOrCreateAgent"](managed, { message: activeMessageState.message, messageId: userMessage.id, options: activeMessageState.options }, assertActivePreparation);
                assertActivePreparation();
                break;
            }
            catch (error) {
                assertActivePreparation();
                const didFallback = false
                    ? await false
                    : false;
                if (!didFallback)
                    throw error;
            }
        }
        sendSpan.mark('agent.ready');
        const activeWorkspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
        const costPolicy = resolveAgentCostControlPolicy(activeWorkspaceConfig?.costControl);
        const effectiveContextLimits = resolveEffectiveAgentContextLimits(costPolicy.context, resolveManagedSessionContextWindow(managed));
        const contextTokens = resolveContextTokenEstimate(managed.tokenUsage?.contextTokens, managed.messages);
        const contextCompactionObjectiveRootId = managed.activeObjective?.objectiveId
            ?? managed.activeObjective?.userMessageId
            ?? managed.pendingTurnRecovery?.userMessageId
            ?? userMessage.id;
        if (costPolicy.enabled
            && contextTokens >= effectiveContextLimits.compactAtTokens
            && agent.compactContext
            && !hasImmutableMissionRoute(managed)) {
            const now = Date.now();
            const contextCompactionDecision = {
                contextTokens,
                compactAtTokens: effectiveContextLimits.compactAtTokens,
                hardLimitTokens: effectiveContextLimits.hardLimitTokens,
                objectiveRootId: contextCompactionObjectiveRootId,
                now,
                previous: managed.contextCompactionAttempt,
            };
            const shouldAttempt = shouldAttemptContextCompaction(contextCompactionDecision);
            const immediateHardLimitFollowUpAttempt = shouldAttempt
                && isHardLimitFollowUpContextCompaction(contextCompactionDecision);
            const hardLimitRecoveryAttempt = shouldAttempt
                && isHardLimitRecoveryContextCompaction(contextCompactionDecision);
            const hardLimitFollowUpAttempted = immediateHardLimitFollowUpAttempt
                || hardLimitRecoveryAttempt
                    && managed.contextCompactionAttempt?.hardLimitFollowUpAttempted === true;
            const hardLimitRecoveryAttempted = hardLimitRecoveryAttempt
                && !immediateHardLimitFollowUpAttempt;
            if (!shouldAttempt) {
                if (managed.pendingRoutingMeta?.costControl) {
                    managed.pendingRoutingMeta.costControl.compacted = false;
                    managed.pendingRoutingMeta.costControl.compactionOutcome = 'skipped-cooldown';
                }
                sessionLog.info('cost-control context compaction skipped during retry cooldown', {
                    sessionId: managed.id,
                    contextTokens,
                    previousOutcome: managed.contextCompactionAttempt?.outcome,
                });
            }
            else {
                try {
                    sessionOperationContext.owner["sendEvent"]({ type: 'status', sessionId, message: AGENT_RUNTIME_ACTIVITY.preparingContext }, managed.workspace.id);
                    const compacted = await agent.compactContext(COST_CONTROL_COMPACTION_INSTRUCTIONS);
                    assertActivePreparation();
                    const compactionDurationMs = Math.max(0, Date.now() - now);
                    const assessment = assessContextCompactionResult(compacted);
                    managed.contextCompactionAttempt = {
                        attemptedAt: now,
                        contextTokensBefore: contextTokens,
                        outcome: assessment.outcome,
                        objectiveRootId: contextCompactionObjectiveRootId,
                        ...(assessment.outcome === 'succeeded'
                            ? { awaitingProviderContextBaseline: true as const }
                            : {}),
                        hardLimitTokens: effectiveContextLimits.hardLimitTokens,
                        ...(hardLimitFollowUpAttempted ? { hardLimitFollowUpAttempted: true as const } : {}),
                        ...(hardLimitRecoveryAttempted ? { hardLimitRecoveryAttempted: true as const } : {}),
                    };
                    // estimatedTokensAfter is a retained-message estimate produced by
                    // the SDK, not a provider-scale context measurement. Keep it in
                    // telemetry only; the first subsequent provider usage event will
                    // establish the durable like-for-like growth baseline.
                    if (managed.pendingRoutingMeta?.costControl) {
                        managed.pendingRoutingMeta.costControl.compacted = assessment.outcome === 'succeeded';
                        managed.pendingRoutingMeta.costControl.compactionOutcome = assessment.outcome;
                        managed.pendingRoutingMeta.costControl.compactionModel = compacted?.compactionModel;
                        managed.pendingRoutingMeta.costControl.compactionDurationMs = compactionDurationMs;
                        managed.pendingRoutingMeta.costControl.contextTokensAfter = assessment.tokensAfter;
                        managed.pendingRoutingMeta.costControl.reclaimedTokens = assessment.reclaimedTokens;
                        managed.pendingRoutingMeta.costControl.reductionRatio = assessment.reductionRatio;
                        managed.pendingRoutingMeta.costControl.compactionIssueCodes = assessment.issues.length > 0
                            ? assessment.issues
                            : undefined;
                    }
                    sessionOperationContext.owner["persistSession"](managed);
                    // The compaction itself is already billable and irreversible from
                    // the host's perspective. Flush its bounded receipt before the
                    // provider turn continues so a crash cannot replay the same work.
                    await sessionOperationContext.owner.flushSession(managed.id);
                    assertActivePreparation();
                    if (assessment.outcome === 'succeeded') {
                        sendSpan.mark('cost-control.compacted');
                        sessionLog.info('cost-control context compacted and measured', {
                            sessionId: managed.id,
                            tokensBefore: assessment.tokensBefore,
                            tokensAfter: assessment.tokensAfter,
                            reclaimedTokens: assessment.reclaimedTokens,
                            reductionRatio: assessment.reductionRatio,
                            compactionModel: compacted?.compactionModel,
                            durationMs: compactionDurationMs,
                        });
                    }
                    else {
                        sendSpan.mark(`cost-control.compaction-${assessment.outcome}`);
                        sessionLog.warn('cost-control context compaction result was not effective and verifiable', {
                            sessionId: managed.id,
                            outcome: assessment.outcome,
                            issues: assessment.issues,
                            tokensBefore: assessment.tokensBefore,
                            tokensAfter: assessment.tokensAfter,
                        });
                    }
                }
                catch (error) {
                    assertActivePreparation();
                    const issueCode = classifyContextCompactionFailure(error);
                    const compactionOutcome = issueCode === 'not-needed'
                        ? 'skipped-not-needed' as const
                        : 'failed' as const;
                    managed.contextCompactionAttempt = {
                        attemptedAt: now,
                        contextTokensBefore: contextTokens,
                        outcome: compactionOutcome,
                        objectiveRootId: contextCompactionObjectiveRootId,
                        hardLimitTokens: effectiveContextLimits.hardLimitTokens,
                        ...(hardLimitFollowUpAttempted ? { hardLimitFollowUpAttempted: true as const } : {}),
                        ...(hardLimitRecoveryAttempted ? { hardLimitRecoveryAttempted: true as const } : {}),
                        issueCode,
                    };
                    if (managed.pendingRoutingMeta?.costControl) {
                        managed.pendingRoutingMeta.costControl.compacted = false;
                        managed.pendingRoutingMeta.costControl.compactionOutcome = compactionOutcome;
                        managed.pendingRoutingMeta.costControl.compactionDurationMs = Math.max(0, Date.now() - now);
                        managed.pendingRoutingMeta.costControl.compactionIssueCodes = [issueCode];
                    }
                    sessionOperationContext.owner["persistSession"](managed);
                    // Persist even failed/not-needed receipts synchronously: their
                    // cooldown is what prevents a restart from re-billing the same
                    // context immediately.
                    await sessionOperationContext.owner.flushSession(managed.id);
                    assertActivePreparation();
                    const logCompactionIssue = issueCode === 'not-needed'
                        ? sessionLog.info.bind(sessionLog)
                        : sessionLog.warn.bind(sessionLog);
                    logCompactionIssue(issueCode === 'not-needed'
                        ? 'cost-control context compaction skipped because SDK found no compactable history'
                        : 'cost-control context compaction failed; provider admission will be re-evaluated', {
                        sessionId: managed.id,
                        issueCode,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
                finally {
                    // This preparation runs before the agent iterator is consumed.
                    // Clear via the existing transient status channel even on failure,
                    // but never publish late activity after Stop or a replaced turn.
                    if (ownsActiveTurn())
                        sessionOperationContext.owner["sendEvent"]({ type: 'status', sessionId, message: '' }, managed.workspace.id);
                }
            }
        }
        if (costPolicy.enabled && !cleanRecoveryProviderReset) {
            const providerAdmissionInput = {
                contextTokens,
                compactAtTokens: effectiveContextLimits.compactAtTokens,
                hardLimitTokens: effectiveContextLimits.hardLimitTokens,
                objectiveRootId: contextCompactionObjectiveRootId,
                now: Date.now(),
                previous: managed.contextCompactionAttempt,
                canCompactContext: typeof agent.compactContext === 'function',
            };
            const providerAdmission = decideContextProviderAdmission(providerAdmissionInput);
            if (providerAdmission.action === 'allow-provider'
                && providerAdmission.reason === 'compacted-context-awaiting-provider-baseline') {
                const consumed = consumeContextProviderBaselineAdmission(managed.contextCompactionAttempt, Date.now());
                if (!consumed) {
                    throw new Error('The post-compaction provider admission was already consumed or is malformed');
                }
                managed.contextCompactionAttempt = consumed;
                sessionOperationContext.owner["persistSession"](managed);
                // This is the one-shot crash fence. No provider handoff is allowed
                // until the consumed admission is durably visible after restart.
                await sessionOperationContext.owner.flushSession(managed.id);
                assertActivePreparation();
            }
            else if (providerAdmission.action !== 'allow-provider') {
                const objective = managed.activeObjective;
                const pending = managed.pendingTurnRecovery;
                const dispatch = pending?.recoveryDispatch;
                const canOpenCleanContinuation = !!objective && !!pending && !!dispatch
                    && dispatch.phase === 'started' && dispatch.id === userMessage.id
                    && !dispatch.cleanContinuationId;
                const cleanPending: PendingTurnRecovery | undefined = canOpenCleanContinuation
                    ? {
                        ...pending,
                        cleanContinuationCount: (pending.cleanContinuationCount ?? 0) + 1,
                        recoveryDispatch: undefined,
                    }
                    : undefined;
                const provisionalHandoff = objective && cleanPending
                    ? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, cleanPending)
                    : undefined;
                const hasPendingContextLimit = (managed.userInputRequests ?? []).some(request => request.status === 'pending' && isExactContextLimitNextStepQuestion(request));
                const hasPendingOrRecentContextLimit = (managed.userInputRequests ?? []).some(request => isExactContextLimitNextStepQuestion(request));
                const contextHardLimitReached = hasPendingOrRecentContextLimit
                    || managed.contextCompactionAttempt?.hardLimitFollowUpAttempted === true
                    || (managed.contextCompactionAttempt?.hardLimitTokens !== undefined
                        && (managed.tokenUsage?.contextTokens ?? 0) >= managed.contextCompactionAttempt.hardLimitTokens)
                    || providerAdmission.action === 'start-clean-continuation';
                const safeFreshDirectObjective = !activeMessageState.options?.hidden && !activeMessageState.options?.internalOrigin
                    && !activeMessageState.options?.automaticRecovery
                    && contextHardLimitReached
                    && (!objective || objective.userMessageId === userMessage.id || objective.lastUserMessageId === userMessage.id)
                    && activeMessageState.message.length > 0;
                if (safeFreshDirectObjective) {
                    await sessionOperationContext.owner["cancelPendingUserInput"](managed, true);
                    managed.pendingTurnRecovery = {
                        ...(managed.pendingTurnRecovery ?? createPendingTurnRecovery(userMessage.id)),
                        cleanContextBoundaryMessageId: userMessage.id,
                    };
                    managed.providerContextBoundaryMessageId = userMessage.id;
                    await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'hard-limit fresh direct objective');
                    assertActivePreparation();
                    managed.sdkSessionId = undefined;
                    managed.branchFromSdkSessionId = undefined;
                    managed.branchFromSessionPath = undefined;
                    managed.branchFromSdkCwd = undefined;
                    managed.branchFromSdkTurnId = undefined;
                    managed.branchContextStrategy = undefined;
                    managed.branchSeedApplied = true;
                    managed.transferredSessionSummary = undefined;
                    managed.transferredSessionSummaryApplied = undefined;
                    if (managed.tokenUsage) {
                        managed.tokenUsage = {
                            ...managed.tokenUsage,
                            contextTokens: Math.max(1, Math.ceil(activeMessageState.message.length / 4)),
                        };
                    }
                    if (!sessionOperationContext.owner["persistSession"](managed)) {
                        throw new Error('The fresh hard-limit provider boundary could not be queued for durable storage');
                    }
                    await sessionOperationContext.owner.flushSession(managed.id);
                    assertActivePreparation();
                    cleanRecoveryProviderReset = true;
                    agent = await sessionOperationContext.owner["getOrCreateAgent"](managed, { message: activeMessageState.message, messageId: userMessage.id, options: activeMessageState.options }, assertActivePreparation);
                    assertActivePreparation();
                }
                else if (!provisionalHandoff) {
                    // A business-question answer is already a durable, authenticated
                    // human turn. If the old SDK context is over its hard limit, keep
                    // that answer row intact and allocate a separate bounded clean
                    // continuation from its host-owned receipt and objective state.
                    // Replacing the answer row would break its authorization lineage.
                    const businessAnswerHandoff = trustedUserInput && !trustedContextLimitAnswer
                        && pending && !hasPendingContextLimit
                        ? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, pending)
                        : undefined;
                    if (businessAnswerHandoff) {
                        const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'objective_continue', pending?.validationGaps, businessAnswerHandoff.remainingWork, undefined, undefined, true);
                        if (queued || managed.pendingTurnRecovery?.exhaustedAt) {
                            sendSpan.mark(`context.hard-limit-business-answer-handoff`);
                            sendSpan.end();
                            await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'interrupted', myGeneration);
                            return;
                        }
                    }
                    const answeredContextLimit = (managed.userInputRequests ?? []).find(request => request.status === 'answered'
                        && request.responseMessageId === userMessage.id
                        && isExactContextLimitNextStepQuestion(request));
                    const isContextLimitAnswerOrigin = trustedContextLimitAnswer !== undefined
                        || answeredContextLimit !== undefined
                        || (activeMessageState.options?.internalOrigin?.kind === 'user-input' && hasPendingOrRecentContextLimit);
                    if (isContextLimitAnswerOrigin && activeMessageState.message.length > 0) {
                        await sessionOperationContext.owner["cancelPendingUserInput"](managed, true);
                        managed.pendingTurnRecovery = {
                            ...(managed.pendingTurnRecovery ?? createPendingTurnRecovery(userMessage.id)),
                            cleanContextBoundaryMessageId: userMessage.id,
                        };
                        managed.providerContextBoundaryMessageId = userMessage.id;
                        await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'hard-limit fresh direct objective from answered context limit');
                        assertActivePreparation();
                        managed.sdkSessionId = undefined;
                        managed.branchFromSdkSessionId = undefined;
                        managed.branchFromSessionPath = undefined;
                        managed.branchFromSdkCwd = undefined;
                        managed.branchFromSdkTurnId = undefined;
                        managed.branchContextStrategy = undefined;
                        managed.branchSeedApplied = true;
                        managed.transferredSessionSummary = undefined;
                        managed.transferredSessionSummaryApplied = undefined;
                        if (managed.tokenUsage) {
                            managed.tokenUsage = {
                                ...managed.tokenUsage,
                                contextTokens: Math.max(1, Math.ceil(activeMessageState.message.length / 4)),
                            };
                        }
                        if (!sessionOperationContext.owner["persistSession"](managed)) {
                            throw new Error('The fresh hard-limit provider boundary could not be queued for durable storage');
                        }
                        await sessionOperationContext.owner.flushSession(managed.id);
                        assertActivePreparation();
                        cleanRecoveryProviderReset = true;
                        agent = await sessionOperationContext.owner["getOrCreateAgent"](managed, { message: activeMessageState.message, messageId: userMessage.id, options: activeMessageState.options }, assertActivePreparation);
                        assertActivePreparation();
                    }
                    else {
                        await sessionOperationContext.owner["cancelPendingUserInput"](managed, true);
                        managed.pendingTurnRecovery = {
                            ...(managed.pendingTurnRecovery ?? createPendingTurnRecovery(userMessage.id)),
                            cleanContextBoundaryMessageId: userMessage.id,
                        };
                        managed.providerContextBoundaryMessageId = userMessage.id;
                        await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'hard-limit autonomous provider boundary reset');
                        assertActivePreparation();
                        managed.sdkSessionId = undefined;
                        managed.branchFromSdkSessionId = undefined;
                        managed.branchFromSessionPath = undefined;
                        managed.branchFromSdkCwd = undefined;
                        managed.branchFromSdkTurnId = undefined;
                        managed.branchContextStrategy = undefined;
                        managed.branchSeedApplied = true;
                        managed.transferredSessionSummary = undefined;
                        managed.transferredSessionSummaryApplied = undefined;
                        managed.contextCompactionAttempt = undefined;
                        if (managed.tokenUsage) {
                            managed.tokenUsage = {
                                ...managed.tokenUsage,
                                contextTokens: Math.max(1, Math.ceil(activeMessageState.message.length / 4)),
                            };
                        }
                        if (!sessionOperationContext.owner["persistSession"](managed)) {
                            throw new Error('The fresh hard-limit provider boundary could not be queued for durable storage');
                        }
                        await sessionOperationContext.owner.flushSession(managed.id);
                        assertActivePreparation();
                        cleanRecoveryProviderReset = true;
                        agent = await sessionOperationContext.owner["getOrCreateAgent"](managed, { message: activeMessageState.message, messageId: userMessage.id, options: activeMessageState.options }, assertActivePreparation);
                        assertActivePreparation();
                    }
                }
                else {
                    let cleanDispatch = { ...dispatch!, cleanContinuationId: provisionalHandoff.id };
                    // A clean provider boundary is deliberately generic. A prior
                    // browser/structured fallback instruction cannot cross it, even
                    // when the hard limit is discovered while that fallback is live.
                    delete cleanDispatch.fallbackIntent;
                    const nextPending: PendingTurnRecovery = {
                        ...cleanPending!,
                        recoveryDispatch: cleanDispatch,
                        cleanContextBoundaryMessageId: userMessage.id,
                    };
                    let finalHandoff: ReturnType<SessionOperations["createAutonomousContextLimitHandoff"]> = undefined;
                    // The deterministic handoff includes bounded recovery state. Rebind
                    // until the dispatch id and the rebuilt contract agree before either
                    // is persisted; a one-pass rebind can leave an unrecoverable prompt.
                    for (let iteration = 0; iteration < 4; iteration += 1) {
                        nextPending.recoveryDispatch = cleanDispatch;
                        const candidate = sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, nextPending);
                        if (!candidate)
                            break;
                        if (candidate.id === cleanDispatch.cleanContinuationId) {
                            finalHandoff = candidate;
                            break;
                        }
                        cleanDispatch = { ...cleanDispatch, cleanContinuationId: candidate.id };
                    }
                    const cleanPrompt = finalHandoff && buildCleanRecoveryContinuationPrompt(finalHandoff);
                    if (!finalHandoff || !cleanPrompt) {
                        throw new Error('The hard-limit clean continuation handoff could not be authenticated');
                    }
                    nextPending.recoveryDispatch = cleanDispatch;
                    managed.pendingTurnRecovery = nextPending;
                    managed.providerContextBoundaryMessageId = userMessage.id;
                    userMessage.content = cleanPrompt;
                    if (userMessage.internalOrigin?.kind === 'browser-fallback')
                        delete userMessage.internalOrigin;
                    if (activeMessageState.options?.internalOrigin?.kind === 'browser-fallback') {
                        const { internalOrigin: _disabledFallbackOrigin, ...cleanOptions } = activeMessageState.options;
                        activeMessageState.options = cleanOptions;
                    }
                    activeMessageState.message = cleanPrompt;
                    managed.lastSentMessage = cleanPrompt;
                    managed.lastSentOptions = activeMessageState.options;
                    await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'hard-limit clean recovery continuation');
                    assertActivePreparation();
                    managed.sdkSessionId = undefined;
                    managed.branchFromSdkSessionId = undefined;
                    managed.branchFromSessionPath = undefined;
                    managed.branchFromSdkCwd = undefined;
                    managed.branchFromSdkTurnId = undefined;
                    managed.branchContextStrategy = undefined;
                    managed.branchSeedApplied = true;
                    managed.transferredSessionSummary = undefined;
                    managed.transferredSessionSummaryApplied = undefined;
                    if (managed.tokenUsage) {
                        managed.tokenUsage = {
                            ...managed.tokenUsage,
                            contextTokens: Math.max(1, Math.ceil(cleanPrompt.length / 4)),
                        };
                    }
                    try {
                        if (!sessionOperationContext.owner["persistSession"](managed)) {
                            throw new Error('The clean hard-limit provider boundary could not be queued for durable storage');
                        }
                        await sessionOperationContext.owner.flushSession(managed.id);
                    }
                    catch (error) {
                        cleanRecoveryConversionFlushFailed = true;
                        throw error;
                    }
                    assertActivePreparation();
                    cleanRecoveryProviderReset = true;
                    cleanRecoveryHandoffPrompt = true;
                    agent = await sessionOperationContext.owner["getOrCreateAgent"](managed, { message: cleanPrompt, messageId: userMessage.id, options: activeMessageState.options }, assertActivePreparation);
                    assertActivePreparation();
                }
            }
        }
        // Always set all sources for context (even if none are enabled), including built-ins
        const allSources = managed.missionCapabilityLock
            ? (managed.missionTurnSourceSnapshot ?? [])
            : loadAllSources(workspaceRootPath);
        agent.setAllSources(allSources);
        sendSpan.mark('sources.loaded');
        // Apply source servers if any are enabled
        if (hasSources) {
            const sessionPath = getSessionStoragePath(persistenceRootFor(managed), sessionId);
            // Single fresh build — tokens already refreshed above.
            const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, sessionOpGetCollectionSummarizer(sessionOperationContext, managed), managed.missionCapabilityLock ? () => sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed) : undefined, managed.missionCapabilityLock, ordinaryMissionSourceBuildOptions(managed));
            assertActivePreparation();
            if (errors.length > 0) {
                sessionLog.warn(`Source build errors:`, errors);
            }
            const mcpCount = Object.keys(mcpServers).length;
            const apiCount = Object.keys(apiServers).length;
            if (mcpCount > 0 || apiCount > 0 || enabledSlugs.length > 0) {
                const usableSources = sources.filter(isSourceUsable);
                const intendedSlugs = usableSources.map(s => s.config.slug);
                await agent.setSourceServers(mcpServers, apiServers, intendedSlugs);
                assertActivePreparation();
                assertActivePreparation();
                sessionLog.info(`Applied ${mcpCount} MCP + ${apiCount} API sources to session ${sessionId} (${allSources.length} total)`);
            }
            sendSpan.mark('servers.applied');
        }
    }
    catch (error) {
        if (error instanceof DelegatedDispatchSupersededError) {
            sendSpan.mark('delegated_dispatch.superseded');
            sendSpan.end();
            await finishSupersededDelegatedDispatch();
            return;
        }
        if (error instanceof InternalContinuationSupersededError) {
            sendSpan.mark('authenticated_internal_continuation.superseded');
            sendSpan.end();
            await finishSupersededAuthenticatedInternalContinuation();
            return;
        }
        if (error instanceof AutomaticRecoverySupersededError) {
            sendSpan.mark('automatic_recovery.superseded');
            sendSpan.end();
            await finishSupersededAutomaticRecovery();
            return;
        }
        if (error instanceof SourceActivationSupersededError) {
            await finishSupersededSourceActivation();
            return;
        }
        if (!ownsActiveTurn()) {
            await finishCancelledPreparation();
            return;
        }
        if (error instanceof AutonomousAdmissionDeferredError) {
            await finishDeferredPreparation();
            return;
        }
        if (cleanRecoveryConversionFlushFailed) {
            let failedDispatchId = contextLimitAnswerSetupRollback?.();
            if (!failedDispatchId) {
                const started = managed.pendingTurnRecovery?.recoveryDispatch;
                if (started?.phase === 'started' && started.cleanContinuationId
                    && started.id === userMessage.id) {
                    removeSyntheticAutomaticMessage();
                    const allocated = { ...started, phase: 'allocated' as const };
                    delete allocated.startedAt;
                    managed.pendingTurnRecovery = {
                        ...managed.pendingTurnRecovery!,
                        recoveryDispatch: allocated,
                    };
                    managed.messageQueue = managed.messageQueue.filter(item => (item.messageId !== allocated.id
                        && item.options?.automaticRecovery?.dispatchId !== allocated.id));
                    sessionOperationContext.owner["setProcessing"](managed, false);
                    failedDispatchId = allocated.id;
                }
            }
            if (failedDispatchId) {
                sessionOpFenceCleanSetupPersistence(sessionOperationContext, managed, failedDispatchId);
                sendSpan.mark('clean_recovery.persistence_error');
                sendSpan.end();
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error', sessionId: managed.id,
                    error: {
                        code: 'provider_error',
                        title: 'Recovery state was not persisted',
                        message: 'The clean recovery boundary could not be durably saved. No provider setup attempt was spent; Retry after storage is available.',
                        actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
                        canRetry: true,
                    },
                }, managed.workspace.id);
                await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'error', myGeneration);
                return;
            }
        }
        sessionLog.error(`Failed to prepare agent runtime for session ${sessionId}:`, error);
        sessionRuntimeHooks.captureException(error, { errorSource: 'chat_setup', sessionId });
        sendSpan.mark('agent.setup_error');
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error));
        sendSpan.end();
        sessionOperationContext.owner["sendEvent"]({
            type: 'error',
            sessionId,
            error: error instanceof Error ? error.message : 'Agent runtime setup failed',
        }, managed.workspace.id);
        const rolledBackQueuedAgentDelivery = await rollbackQueuedAgentDeliveryPreparation('runtime preparation failed before provider handoff', error);
        if (rolledBackQueuedAgentDelivery) {
            try {
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'agent-delivery setup retry');
            }
            catch (disposeError) {
                sessionLog.warn('Failed to dispose runtime after a pre-provider delivery error', {
                    sessionId,
                    error: disposeError instanceof Error ? disposeError.message : String(disposeError),
                });
            }
            const persistenceFenced = Number.isFinite(userMessage.agentDelivery?.setupPersistenceFencedAt)
                || sessionOperationContext.state.agentDeliverySetupPersistenceFences.get(sessionId) === userMessage.agentDelivery?.id;
            const blockedAt = userMessage.agentDelivery?.setupRetryBlockedAt;
            if (persistenceFenced) {
                sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
                sessionOpClearDeferredAutomaticRetry(sessionOperationContext, sessionId);
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error', sessionId,
                    error: {
                        code: 'provider_error', title: 'Agent delivery state requires confirmation',
                        message: 'The queued agent delivery was restored in memory, but its durable rollback could not be confirmed. No provider will start; use Retry after storage is available.',
                        actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                    },
                }, managed.workspace.id);
            }
            else if (blockedAt) {
                sessionOperationContext.owner["sendEvent"]({
                    type: 'typed_error', sessionId,
                    error: {
                        code: 'provider_error', title: 'Agent delivery setup paused',
                        message: `The queued agent delivery remains safe, but provider setup is paused (${userMessage.agentDelivery?.lastSetupFailureClass ?? 'unknown'}). Resolve the provider issue, then Retry.`,
                        actions: [{ key: 'r', label: 'Retry', action: 'retry' }], canRetry: true,
                    },
                }, managed.workspace.id);
            }
            else {
                sessionOperationContext.state.deferredAutomaticSessions.add(sessionId);
                sessionOperationContext.owner["scheduleDeferredAutomaticRetry"](sessionId, Math.max(0, (userMessage.agentDelivery?.setupRetryNotBefore ?? Date.now()) - Date.now()));
            }
            return;
        }
        const failedContextLimitAnswerDispatchId = contextLimitAnswerSetupRollback?.();
        if (failedContextLimitAnswerDispatchId) {
            try {
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean pre-provider setup retry');
            }
            catch (disposeError) {
                sessionLog.warn('Failed to dispose runtime after a clean pre-provider setup error', {
                    sessionId,
                    error: disposeError instanceof Error ? disposeError.message : String(disposeError),
                });
            }
            await sessionOpRetainFailedCleanRetrySetup(sessionOperationContext, managed, failedContextLimitAnswerDispatchId, error);
        }
        else if (cleanRecoveryHandoffPrompt && cleanExplicitRetry && cleanExplicitRetrySetupRollback) {
            // The boundary was durable but no provider runtime was created. Roll
            // back only this new hidden row to its acknowledged allocation. The
            // bounded helper persists its classified failure before arming a retry.
            const failedDispatchId = cleanExplicitRetrySetupRollback();
            if (failedDispatchId) {
                try {
                    await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean pre-provider setup retry');
                }
                catch (disposeError) {
                    sessionLog.warn('Failed to dispose runtime after a clean pre-provider setup error', {
                        sessionId,
                        error: disposeError instanceof Error ? disposeError.message : String(disposeError),
                    });
                }
                await sessionOpRetainFailedCleanRetrySetup(sessionOperationContext, managed, failedDispatchId, error);
            }
        }
        else if (cleanRecoveryHandoffPrompt && activeMessageState.syntheticAutomaticMessage
            && managed.pendingTurnRecovery?.recoveryDispatch?.cleanContinuationId) {
            const failedDispatchId = managed.pendingTurnRecovery.recoveryDispatch.id;
            if (restoreStartedAutomaticDispatch()) {
                removeSyntheticAutomaticMessage();
                sessionOperationContext.owner["setProcessing"](managed, false);
                try {
                    await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'clean pre-provider setup retry');
                }
                catch (disposeError) {
                    sessionLog.warn('Failed to dispose runtime after a clean pre-provider setup error', {
                        sessionId,
                        error: disposeError instanceof Error ? disposeError.message : String(disposeError),
                    });
                }
                await sessionOpRetainFailedCleanRetrySetup(sessionOperationContext, managed, failedDispatchId, error);
            }
        }
        else if (removeSyntheticAutomaticMessage()) {
            // No provider saw this recovery prompt. Persist its exact removal
            // before publishing the terminal setup failure, otherwise a restart
            // can inject the undelivered hidden row as SDK recovery history.
            sessionOperationContext.owner["persistSession"](managed);
            try {
                await sessionOperationContext.owner.flushSession(sessionId);
            }
            catch (cleanupError) {
                sessionLog.warn('Failed to flush undelivered automatic recovery cleanup', {
                    sessionId,
                    error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
            }
        }
        await sessionOperationContext.owner["onProcessingStopped"](sessionId, 'error', myGeneration);
        return;
    }
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
