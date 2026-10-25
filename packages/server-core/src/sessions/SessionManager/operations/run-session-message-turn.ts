import { createMessagePreparationFinalizers } from './create-message-preparation-finalizers.ts';
import { admitSessionMessageObjective } from './admit-session-message-objective.ts';
import { prepareSessionAgentRuntime } from './prepare-agent-runtime.ts';
import { executeSessionProviderTurn } from './execute-provider-turn.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';
import { createProviderTurnState } from './provider-turn-state.ts';
import { refreshInheritedWorkspaceSources, cleanRetrySetupFailureSignal, enqueueRecoveredMessageInTranscriptOrder } from '../policy.ts';
import { classifyAgentFailure, parseCompactCommand } from '@craft-agent/shared/agent';
import { getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources';
import { perf } from '@craft-agent/shared/utils';
import { loadSkillBySlug } from '@craft-agent/shared/skills';
import { shouldManageSessionStatusLifecycle } from '../../session-status-lifecycle';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import { MAX_CLEAN_RETRY_CONDITIONAL_SETUP_FAILURES, MAX_CLEAN_RETRY_SAFE_SETUP_FAILURES } from '../user-input-authority.ts';
import { completeQueuedAgentDeliveryDispatch as sessionOpCompleteQueuedAgentDeliveryDispatch } from './settle-queued-agent-delivery-dispatch.ts';
import { getLastFinalAssistantMessageId as sessionOpGetLastFinalAssistantMessageId } from './session-sources.ts';
import { reloadSessionSourcesWithinOperation as sessionOpReloadSessionSourcesWithinOperation } from './workspace-configuration.ts';
import type { SessionMessageTurnInput } from './session-message-turn-input.ts';

export async function runSessionMessageTurn(
    input: SessionMessageTurnInput
): Promise<void> {
    const {
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
    } = input;
    let deliveryAttemptsBeforePreparation: number | undefined;
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
    if (!objectiveAdmission)
        return;
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
    const { finishDeferredPreparation, finishCancelledPreparation, finishSupersededSourceActivation, finishSupersededAuthenticatedInternalContinuation, finishSupersededDelegatedDispatch, } = createMessagePreparationFinalizers({
        ownsActiveTurn, sessionOperationContext, sessionId, restoreStartedAutomaticDispatch, userMessage,
        deliveryAttemptsBeforePreparation, managed, myGeneration, queuedItem, activeMessageState, attachments, storedAttachments, sendSpan, abandonStoppedTurn, sourceActivationOrigin, authenticatedInternalContinuationToken, existingMessageId, existingTurnRollback, delegatedDispatchContinuationToken,
    });
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
    if (!runtimePreparation)
        return;
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
