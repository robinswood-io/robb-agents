import type { SessionOperationContext } from '../operation-context.ts';
import { isDurableProviderActivityOrHumanSupersession, persistenceRootFor } from '../policy.ts';
import { updateSessionMetadata } from '@craft-agent/shared/sessions';
import { sessionLog } from '../runtime-platform.ts';
import { emitOperationsEvent } from '../../operations-events.ts';
import { DELEGATED_TERMINAL_RESULT_PROTOCOL } from '../runtime-policy.ts';
import { hasConsumedCleanRecoveryDispatch as sessionOpHasConsumedCleanRecoveryDispatch, cancelSupersededAutomaticRecoveries as sessionOpCancelSupersededAutomaticRecoveries, hasAcceptedHumanContinuationQueued as sessionOpHasAcceptedHumanContinuationQueued } from './create-autonomous-context-limit-handoff.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';
import { hasPendingDecision as sessionOpHasPendingDecision, hasTerminalObjectiveState as sessionOpHasTerminalObjectiveState } from './repair-legacy-synthetic-objective-authority.ts';
import { preserveInterruptedObjectiveContinuation as sessionOpPreserveInterruptedObjectiveContinuation, hasValidationExhaustionMarker as sessionOpHasValidationExhaustionMarker, hasExhaustedValidation as sessionOpHasExhaustedValidation, hasPreservedInterruptedObjectiveContinuation as sessionOpHasPreservedInterruptedObjectiveContinuation, hasBoundInterruptedTurnRecovery as sessionOpHasBoundInterruptedTurnRecovery } from './reconcile-provider-acceptance-unknown-for-retry.ts';
import { isCleanSetupRetryBlocked as sessionOpIsCleanSetupRetryBlocked } from './pending-recovery-belongs-to-current-objective.ts';
import { hasOnlyMachineInbox as sessionOpHasOnlyMachineInbox, hasAnyRetainedStoppedAgentDelivery as sessionOpHasAnyRetainedStoppedAgentDelivery } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { hasRunningBackgroundTasks as sessionOpHasRunningBackgroundTasks } from './evict-idle-session-runtimes.ts';
import { getLastFinalAssistantMessageId as sessionOpGetLastFinalAssistantMessageId } from './session-sources.ts';
import { ensureDelegatedTerminalResultDelivery as sessionOpEnsureDelegatedTerminalResultDelivery, scheduleDelegatedTerminalResultRetry as sessionOpScheduleDelegatedTerminalResultRetry } from './ensure-delegated-terminal-result-delivery.ts';
import { monotonic as sessionOpMonotonic } from './runtime-host.ts';
import { applyExternalSessionMetadata as sessionOpApplyExternalSessionMetadata } from './close-pending-permission-requests-for-stop.ts';
import { isCleanSetupPersistenceFenced as sessionOpIsCleanSetupPersistenceFenced } from './start-recovery-dispatch.ts';
import { providerDispatchAcceptanceUnknown as sessionOpProviderDispatchAcceptanceUnknown } from './reconcile-live-provider-dispatch-uncertainty.ts';
import { captureSessionTerminalLearning as sessionOpCaptureSessionTerminalLearning } from './capture-user-correction.ts';
import { retryableContextLimitRequest as sessionOpRetryableContextLimitRequest } from './retryable-context-limit-request.ts';

/**
 * Central handler for when processing stops (any reason).
 * Single source of truth for cleanup and queue processing.
 *
 * @param sessionId - The session that stopped processing
 * @param reason - Why processing stopped ('complete' | 'interrupted' | 'error')
 */
async function sessionOpOnProcessingStopped(sessionOperationContext: SessionOperationContext, sessionId: string, reason: 'complete' | 'interrupted' | 'error' | 'timeout', processingGeneration?: number, permissionExpiryOwner = false): Promise<void> {
    if (sessionOperationContext.state.shuttingDown)
        return;
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed)
        return;
    const generationKey = processingGeneration ?? managed.processingGeneration;
    // Permission expiry owns terminal cleanup for this generation. Provider
    // shutdown and the recovery watchdog may both report a later stop, but
    // neither may reopen, reclassify, or re-run that denied mutation.
    if (!permissionExpiryOwner
        && sessionOperationContext.state.permissionExpiryStopGenerations.get(managed) === generationKey)
        return;
    // Once idle is published, a new request may start while cleanup is awaiting
    // storage or a remote browser. The previous turn no longer owns that session.
    const ownsStop = () => !sessionOperationContext.state.shuttingDown && sessionOperationContext.state.sessions.get(sessionId) === managed
        && managed.processingGeneration === generationKey;
    if (!ownsStop())
        return;
    if (managed.sourceActivationTurn?.generation === generationKey) {
        managed.sourceActivationTurn = undefined;
    }
    const assertStopOwnership = () => {
        if (!ownsStop())
            throw new Error('Processing stop superseded by a newer generation');
    };
    // Retire the spent clean-dispatch capability before admitting retained
    // machine receipts. Its attempt counters remain available for recovery.
    if (sessionOpHasConsumedCleanRecoveryDispatch(sessionOperationContext, managed) && managed.pendingTurnRecovery) {
        const pending = managed.pendingTurnRecovery;
        managed.pendingTurnRecovery = { ...pending, recoveryDispatch: undefined };
        try {
            if (!sessionOperationContext.owner["persistSession"](managed))
                throw new Error('Clean dispatch retirement could not be queued');
            await sessionOperationContext.owner.flushSession(managed.id);
        }
        catch (error) {
            managed.pendingTurnRecovery = pending;
            sessionLog.warn('Failed to retire consumed clean recovery dispatch', {
                sessionId, error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        if (!ownsStop())
            return;
    }
    // A fallback may have been allocated while the provider was still running.
    // Revoke it durably before queue inspection if that old objective has since
    // completed or a later human turn was accepted during the allocation flush.
    if (sessionOpCancelSupersededAutomaticRecoveries(sessionOperationContext, managed)) {
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        if (!ownsStop())
            return;
    }
    const hasQueuedAutomaticRecovery = managed.messageQueue.some(item => !!item.options?.automaticRecovery);
    const hasQueuedHumanContinuation = sessionOpHasAcceptedHumanContinuationQueued(sessionOperationContext, managed);
    // Technical failures and premature finals may replace `lastCause` after a
    // valid objective continuation. When that inherited budget is exhausted,
    // move it to the explicit-Retry snapshot during this live stop. Waiting for
    // cold-start repair would leave the objective active and its work invisible.
    if (!hasQueuedAutomaticRecovery && !hasQueuedHumanContinuation
        && !sessionOperationContext.state.deferredAutomaticSessions?.has(sessionId)
        && !sessionOperationContext.owner["hasPendingUserInput"](managed) && !sessionOpHasQueuedUserInput(sessionOperationContext, managed)
        && !sessionOpHasPendingDecision(sessionOperationContext, managed)) {
        sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext, managed);
    }
    // Blocked/exhausted objectives are terminal handoffs, never successful
    // completion signals to dependent tasks, telemetry, or the renderer.
    const objectiveState = managed.activeObjective?.terminalState;
    if ((objectiveState === 'blocked_human' || objectiveState === 'blocked_policy')
        && reason !== 'error' && reason !== 'timeout'
        && !(reason === 'interrupted' && managed.stopRequested)) {
        reason = 'error';
    }
    else if (reason === 'complete' && objectiveState === 'exhausted') {
        reason = 'interrupted';
    }
    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`);
    if (managed.terminalErrorGeneration === generationKey) {
        managed.terminalErrorGeneration = undefined;
    }
    sessionOperationContext.owner["finishGenerationTelemetry"](managed, generationKey, reason === 'complete'
        ? 'generation.completed'
        : reason === 'error'
            ? 'generation.failed'
            : 'generation.cancelled', reason === 'timeout' ? { errorCode: 'stop_timeout' } : undefined);
    // A user retry owns one attempt, not a fresh automatic budget. If that
    // attempt fails during setup or transport, preserve the original validation
    // stop even though lastCause now describes the technical failure. Mark it
    // stopped before persistence so startup cannot replay an already failed
    // attempt whose setup error did not create an assistant transcript entry.
    if (reason !== 'complete' && !hasQueuedAutomaticRecovery && !hasQueuedHumanContinuation
        && !sessionOperationContext.state.deferredAutomaticSessions?.has(sessionId)
        && !sessionOperationContext.owner["hasPendingUserInput"](managed) && !sessionOpHasQueuedUserInput(sessionOperationContext, managed)
        && managed.activeObjective?.terminalState === 'active' && sessionOpHasValidationExhaustionMarker(sessionOperationContext, managed)) {
        managed.activeObjective.terminalState = 'exhausted';
    }
    { }
    managed.pendingRuntimeProviderFallback = undefined;
    if (!ownsStop())
        return;
    if (!hasQueuedAutomaticRecovery && !hasQueuedHumanContinuation && !sessionOperationContext.owner["hasPendingUserInput"](managed) && !sessionOpHasQueuedUserInput(sessionOperationContext, managed)
        && !sessionOperationContext.state.deferredAutomaticSessions?.has(sessionId)
        && !sessionOpHasPendingDecision(sessionOperationContext, managed) && !sessionOpHasExhaustedValidation(sessionOperationContext, managed)
        && !sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, managed.pendingTurnRecovery?.recoveryDispatch)
        && managed.activeObjective?.terminalState !== 'active') {
        if (!sessionOpPreserveInterruptedObjectiveContinuation(sessionOperationContext, managed)
            && !sessionOpHasPreservedInterruptedObjectiveContinuation(sessionOperationContext, managed)
            && !sessionOpHasBoundInterruptedTurnRecovery(sessionOperationContext, managed)) {
            sessionOperationContext.owner["clearPendingTurnRecovery"](managed);
        }
    }
    // 1. Cleanup state
    sessionOperationContext.owner["setProcessing"](managed, false);
    const stoppedAdmissionBinding = managed.agent
        ? sessionOperationContext.state.runtimeToolAdmissionBindings.get(managed.agent)
        : undefined;
    if (stoppedAdmissionBinding?.managed === managed
        && stoppedAdmissionBinding.generation === generationKey) {
        stoppedAdmissionBinding.liveToolFallbackIntent = undefined;
    }
    managed.stopRequested = false; // Reset for next turn
    managed.pendingUserSteers?.clear();
    const retainedTerminalMachineInbox = (sessionOpHasTerminalObjectiveState(sessionOperationContext, managed)
        && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed))
        || (sessionOpHasAnyRetainedStoppedAgentDelivery(sessionOperationContext, managed) && sessionOpHasOnlyMachineInbox(sessionOperationContext, managed));
    if (retainedTerminalMachineInbox) {
        // These rows are durable context for an explicit Retry, not runnable
        // work. Keeping them out of admission also releases stale restart slots.
        sessionOperationContext.state.deferredAutomaticSessions.delete(sessionId);
        sessionOperationContext.state.automaticAdmissionReservations.delete(sessionId);
    }
    // 1b. Orphan backstop: with the default per-turn subprocess model, any
    // background sub-agent still marked `running` dies when this turn's
    // subprocess is torn down. Flip those registry entries to `orphaned` so a
    // later "status?" query never reports a dead task as running. Suppressed
    // when WS2 keep-alive keeps the query alive across turns.
    sessionOperationContext.owner["markOrphanedBackgroundTasks"](sessionId);
    // A terminal runtime error can leave a provider subprocess or its MCP
    // transport unusable even though the session state itself is recoverable.
    // Recycle the complete runtime now so retrying starts cleanly. Preserve it
    // only while a genuine background task is still running.
    if ((reason === 'error' || reason === 'timeout') && !sessionOpHasRunningBackgroundTasks(sessionOperationContext, managed)) {
        await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, `${reason} recovery`);
    }
    if (!ownsStop())
        return;
    const turnStartFinalMessageId = managed.turnStartFinalMessageId;
    managed.turnStartFinalMessageId = undefined;
    // Clear agent control overlay between turns. The session keeps browser
    // ownership (boundSessionId) — only the visual overlay is removed.
    // Full unbind happens below when the queue is empty (session truly done).
    const turnBpm = sessionOperationContext.owner.getBrowserPaneManagerForSession(sessionId);
    if (turnBpm) {
        // Same guard as the queue-empty teardown below: a remote BPM throw on a
        // headless server must not abort processing-stop handling.
        try {
            await turnBpm.clearVisualsForSession(sessionId);
        }
        catch (err) {
            sessionLog.warn(`Browser-pane visual clear failed for ${sessionId} (continuing):`, err);
        }
    }
    if (!ownsStop())
        return;
    // 2. Handle unread state based on whether user is viewing this session
    //    This is the explicit state machine for NEW badge:
    //    - If user is viewing: mark as read (they saw it complete)
    //    - If user is NOT viewing: mark as unread (they have new content)
    //    IMPORTANT: only apply this when the turn produced a NEW final assistant message.
    const isViewing = sessionOperationContext.owner["isSessionBeingViewed"](sessionId, managed.workspace.id);
    const currentFinalMessageId = sessionOpGetLastFinalAssistantMessageId(sessionOperationContext, managed.messages);
    const didReceiveNewFinalMessage = !!currentFinalMessageId && currentFinalMessageId !== turnStartFinalMessageId;
    const activeDeliveryId = managed.activeAgentDelivery?.generation === generationKey
        ? managed.activeAgentDelivery.deliveryId
        : managed.lastSentOptions?.internalOrigin?.deliveryId;
    if (activeDeliveryId) {
        const delivered = managed.messages.find(m => m.agentDelivery?.id === activeDeliveryId);
        if (delivered?.agentDelivery?.status === 'processing') {
            // A host-bound delivery is consumed once this generation produced a
            // durable final, even when objective validation deliberately turns the
            // stop into `interrupted` to schedule more work. Treating that receipt
            // as failed would replay evidence the provider already incorporated.
            // Only activity strictly after this exact row can consume it. The
            // diagnostic boundary predates the delivery append, so using it here
            // would let the delivery count itself as a user supersession. Queued
            // machine inbox rows likewise prove no provider consumption.
            const deliveredIndex = managed.messages.indexOf(delivered);
            const didReceiveDurableActivityAfterDelivery = deliveredIndex >= 0
                && managed.messages.slice(deliveredIndex + 1).some(candidate => (isDurableProviderActivityOrHumanSupersession(managed, candidate)));
            const deliveryWasConsumed = !!delivered.providerDispatch
                || reason === 'complete' || didReceiveDurableActivityAfterDelivery;
            delivered.agentDelivery.status = deliveryWasConsumed ? 'processed' : 'failed';
            delivered.isQueued = false;
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            if (!ownsStop())
                return;
            if (delivered.content.startsWith(DELEGATED_TERMINAL_RESULT_PROTOCOL)
                && delivered.internalOrigin?.kind === 'agent-message'
                && delivered.internalOrigin.senderSessionId
                && !deliveryWasConsumed) {
                const child = sessionOperationContext.state.sessions.get(delivered.internalOrigin.senderSessionId);
                if (child) {
                    try {
                        const requeued = await sessionOpEnsureDelegatedTerminalResultDelivery(sessionOperationContext, child, true);
                        if (!requeued)
                            sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
                    }
                    catch (error) {
                        sessionLog.warn('Failed to requeue an unconsumed delegated terminal result before FIFO drain', {
                            childSessionId: child.id,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, child.id);
                    }
                    if (!ownsStop())
                        return;
                }
                else {
                    sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, delivered.internalOrigin.senderSessionId);
                }
            }
        }
    }
    if (managed.activeAgentDelivery?.generation === generationKey) {
        managed.activeAgentDelivery = undefined;
    }
    if (managed.delegation && (sessionOpHasTerminalObjectiveState(sessionOperationContext, managed) || managed.delegation.finishedAt)) {
        if (!managed.delegation.finishedAt)
            managed.delegation.finishedAt = sessionOpMonotonic(sessionOperationContext);
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        if (!ownsStop())
            return;
        try {
            const delivered = await sessionOpEnsureDelegatedTerminalResultDelivery(sessionOperationContext, managed);
            if (!delivered)
                sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, managed.id);
        }
        catch (error) {
            sessionLog.warn('Failed to deliver delegated terminal result', {
                childSessionId: managed.id,
                error: error instanceof Error ? error.message : String(error),
            });
            sessionOpScheduleDelegatedTerminalResultRetry(sessionOperationContext, managed.id);
        }
        if (!ownsStop())
            return;
    }
    emitOperationsEvent({
        kind: 'turn.finished', at: new Date().toISOString(),
        workspaceId: managed.workspace.id, sessionId: managed.id,
        missionId: managed.missionId, workItemId: managed.missionWorkItemId,
        turnId: managed.executionTelemetryGenerations?.get(generationKey)?.turnId,
        outcome: reason,
        finalText: didReceiveNewFinalMessage && currentFinalMessageId
            ? managed.messages.find(candidate => candidate.id === currentFinalMessageId)?.content
            : undefined,
        tokenUsage: managed.tokenUsage,
    });
    if (reason === 'complete' && didReceiveNewFinalMessage) {
        if (isViewing) {
            // User is watching - mark as read immediately
            await sessionOperationContext.owner.markSessionRead(sessionId);
            if (!ownsStop())
                return;
        }
        else {
            // User is not watching - mark as unread for NEW badge
            if (!managed.hasUnread) {
                managed.hasUnread = true;
                await updateSessionMetadata(persistenceRootFor(managed), sessionId, { hasUnread: true }, managed.persistenceRootIdentity);
                if (!ownsStop())
                    return;
                sessionOperationContext.owner["emitUnreadSummaryChanged"]();
            }
        }
    }
    // 3. Auto-complete mini agent sessions to avoid session list clutter
    //    Mini agents are spawned from EditPopovers for quick config edits
    //    and should automatically move to 'done' when finished
    if (reason === 'complete' && managed.systemPromptPreset === 'mini' && managed.sessionStatus !== 'done') {
        sessionLog.info(`Auto-completing mini agent session ${sessionId}`);
        try {
            await sessionOperationContext.owner.setSessionStatus(sessionId, 'done', assertStopOwnership);
        }
        catch (error) {
            if (ownsStop())
                throw error;
        }
        if (!ownsStop())
            return;
    }
    // 4. Apply deferred external metadata updates captured while processing.
    if (managed.pendingExternalMetadata) {
        const pendingHeader = managed.pendingExternalMetadata;
        managed.pendingExternalMetadata = undefined;
        sessionLog.info(`Applying deferred external metadata for session ${sessionId} after processing stop`);
        sessionOpApplyExternalSessionMetadata(sessionOperationContext, managed, pendingHeader);
    }
    // Only assign a terminal handoff when no autonomous continuation is
    // queued. The transition is conditional on our start status still being
    // current, so an explicit user/agent status change made during the turn
    // always wins.
    const stoppedSetupDispatch = managed.pendingTurnRecovery?.recoveryDispatch;
    const setupAttentionRequired = sessionOpIsCleanSetupRetryBlocked(sessionOperationContext, stoppedSetupDispatch)
        || sessionOpIsCleanSetupPersistenceFenced(sessionOperationContext, managed, stoppedSetupDispatch)
        || !!sessionOpProviderDispatchAcceptanceUnknown(sessionOperationContext, managed);
    if (!setupAttentionRequired
        && (managed.messageQueue.length === 0 || retainedTerminalMachineInbox)
        && !sessionOperationContext.state.deferredAutomaticSessions?.has(sessionId)) {
        try {
            await sessionOperationContext.owner["finishAutomaticSessionStatusLifecycle"](managed, reason, assertStopOwnership);
        }
        catch (error) {
            if (!ownsStop())
                return;
            sessionLog.warn('Automatic session status terminal transition failed', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (!ownsStop())
        return;
    const projectTerminalState = managed.activeObjective?.terminalState;
    if (projectTerminalState != null && projectTerminalState !== 'active' && managed.activeObjective && managed.projectId) {
        try {
            await sessionOpCaptureSessionTerminalLearning(sessionOperationContext, managed, projectTerminalState);
        }
        catch (error) {
            sessionLog.warn('Learning proposal capture unavailable', { sessionId, error: String(error) });
        }
    }
    if (!ownsStop())
        return;
    // 5. Check queue and process or complete
    if (managed.messageQueue.length > 0 && !retainedTerminalMachineInbox) {
        // The worker stopped even when a descendant decision keeps its inbox
        // paused. Publish idle without signalling task completion to the Conductor.
        sessionOperationContext.owner["processNextQueuedMessage"](sessionId);
        if (!ownsStop())
            return;
        if (sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasPendingDecision(sessionOperationContext, managed)) {
            sessionOperationContext.owner["sendEvent"]({ type: 'complete', sessionId, reason: 'interrupted', tokenUsage: managed.tokenUsage,
                backgroundTasksAlive: sessionOperationContext.state.keepBackgroundTasksAlive }, managed.workspace.id);
        }
    }
    else {
        // Session is truly done — release browser ownership.
        // The window stays alive (hidden) and becomes reusable by future sessions.
        // On the next turn, getOrCreateForSession() will re-bind it.
        const doneBpm = sessionOperationContext.owner.getBrowserPaneManagerForSession(sessionId);
        if (doneBpm) {
            // Teardown must never block completion. On a headless/WebUI server the BPM is
            // remote and these calls throw (BROWSER_NO_CAPABLE_CLIENT) when no desktop
            // browser client is connected — which previously aborted onProcessingStopped
            // before emitSessionComplete, hanging the Tasks Conductor completion seam.
            try {
                await doneBpm.clearVisualsForSession(sessionId);
                if (!ownsStop())
                    return;
                doneBpm.unbindAllForSession(sessionId);
            }
            catch (err) {
                sessionLog.warn(`Browser-pane teardown failed for ${sessionId} (continuing to completion):`, err);
            }
        }
        if (!ownsStop())
            return;
        // Publish the validated outcome and cleared recovery before the renderer
        // handles the terminal signal. A final text event alone proves neither.
        sessionOperationContext.owner["emitObjectiveChanged"](managed);
        // No queue - emit complete to UI (include tokenUsage and hasUnread for state updates)
        sessionOperationContext.owner["sendEvent"]({
            type: 'complete',
            sessionId,
            reason,
            tokenUsage: managed.tokenUsage,
            hasUnread: managed.hasUnread, // Propagate unread state to renderer
            // WS2: when keep-alive keeps the persistent query open across turns, the
            // turn ending does NOT kill background sub-agents. Tell the renderer so its
            // chip orphan-backstop does not falsely flip live tasks to `orphaned`; a
            // real `task_completed` will arrive when the agent actually finishes.
            backgroundTasksAlive: sessionOperationContext.state.keepBackgroundTasksAlive,
        }, managed.workspace.id);
        // Tasks Conductor seam: signal true completion (queue empty) with the stop
        // reason + this turn's final assistant message, so the Conductor can advance
        // the corresponding node. In-process only; never sent to the renderer/agents.
        if (!setupAttentionRequired && !sessionOperationContext.owner["hasPendingUserInput"](managed)
            && !sessionOpHasQueuedUserInput(sessionOperationContext, managed) && !sessionOperationContext.state.deferredAutomaticSessions?.has(sessionId)) {
            const executionProof = sessionOperationContext.state.executionProofCollector.take(sessionId);
            sessionOperationContext.owner["emitSessionComplete"]({
                sessionId,
                workspaceId: managed.workspace.id,
                reason,
                finalMessageId: currentFinalMessageId,
                finalText: currentFinalMessageId
                    ? managed.messages.find(m => m.id === currentFinalMessageId)?.content
                    : undefined,
                tokenUsage: managed.tokenUsage,
                ...(reason === 'complete' && executionProof ? { executionProof } : {}),
            });
        }
    }
    // 6. Persist only while this stopped turn still owns the session.
    if (ownsStop())
        sessionOperationContext.owner["persistSession"](managed);
    sessionOperationContext.owner["scheduleDeferredAutomaticSessions"]?.();
    // A hard-limit question can be proven unnecessary from the host's durable
    // objective immediately after the turn stops. Apply the same guarded
    // recovery used after a cold start, without requiring an app restart.
    // Defer past the old generation's finally block before admitting a fresh
    // provider boundary. An unauthenticated or ambiguous question remains open.
    if (ownsStop() && sessionOpRetryableContextLimitRequest(sessionOperationContext, managed)) {
        queueMicrotask(() => {
            if (sessionOperationContext.state.sessions.get(sessionId) !== managed || sessionOperationContext.state.shuttingDown
                || managed.stopRequested || managed.isProcessing
                || managed.processingGeneration !== generationKey)
                return;
            void sessionOperationContext.owner["resumePendingTurnAfterRestart"](sessionId).catch(error => {
                sessionLog.error('Live context-limit recovery failed', {
                    sessionId, error: error instanceof Error ? error.message : String(error),
                });
            });
        });
    }
}

export { sessionOpOnProcessingStopped as onProcessingStopped };
