import { resolveAgentCostControlPolicy } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { generateMessageId } from '@craft-agent/shared/protocol';
import type { Message } from '@craft-agent/core/types';
import { explicitRetryProgressFingerprint } from '../../explicit-retry-progress';
import { turnRecoveryValidationFingerprint, createPendingTurnRecovery, grantExplicitRetryAllowance, reconstructLegacyTurnRecoveryBudget } from '../../turn-recovery';
import { normalizeRecoveryValidationGapsForProgress } from '../../recovery-progress';
import type { ManagedSession } from '../managed-session.ts';
import { startRecoveryDispatch as sessionOpStartRecoveryDispatch } from './start-recovery-dispatch.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { getInterruptedTurnRecovery as sessionOpGetInterruptedTurnRecovery, hasValidationExhaustionMarker as sessionOpHasValidationExhaustionMarker } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { boundCleanUserInputRequest as sessionOpBoundCleanUserInputRequest } from './context-limit-authenticated-answer-evidence.ts';
import type { UserMessagePreparationInput, PreparedUserMessage } from './user-message-preparation-input.ts';

export function prepareCleanRetryUserMessage(
    userMessagePreparationInput: UserMessagePreparationInput,
    userMessage: Message
): Pick<PreparedUserMessage, 'existingTurnRollback' | 'cleanRecoveryProviderStateAtomized'> {
    const {
        managed,
        activeMessageState,
        sessionOperationContext,
        explicitRetryAllowanceToken,
        ownsActiveTurn,
        explicitRetryIntent,
        diagnosticFromMessageCount,
        explicitRetryContextLimitRequest,
        resetProviderResumeStateForCleanBoundary,
        explicitRetryContextLimitRequestBefore,
    } = userMessagePreparationInput;
    let existingTurnRollback: (() => void) | undefined;
    let cleanRecoveryProviderStateAtomized = false;
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
    return { existingTurnRollback, cleanRecoveryProviderStateAtomized };
}
