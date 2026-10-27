import { installProviderTurnHooks } from './provider-turn-hooks.ts';
import { handleProviderTurnEvent } from './provider-turn-events.ts';
import { handleProviderTurnError } from './provider-turn-error.ts';
import { restoreProviderTurnHooks } from './provider-turn-cleanup.ts';
import { isDurableProviderActivityOrHumanSupersession, persistenceRootFor, assertOrdinaryMissionRouteProjection, isLegacyHostObjectiveContractEnabled } from '../policy.ts';
import { canInjectCompletedChatContext, completedChatContext } from '../../completed-chat-retention';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { resolveBackendContext } from '@craft-agent/shared/agent/backend';
import { formatPlaybookPrompt } from '@craft-agent/shared/playbooks';
import { isWorkspaceAutomaticToolFallbackEnabled, loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { emitOperationsEvent } from '../../operations-events.ts';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { toolMetadataStore } from '@craft-agent/shared/interceptor';
import { filterAttachmentsForModelInput } from '../../runtime-config';
import { incompletePlanSteps } from '../../turn-completion';
import { getProjectLearningPolicy } from '../../project-learning';
import { createAutomaticRecoveryToolDeadline, resolveAutomaticRecoveryInactivityTimeoutMs, withAutomaticRecoveryInactivityTimeout } from '../../turn-recovery';
import { buildObjectiveScopePrompt, findObjectiveText } from '../../objective-contract';
import { sessionLog } from '../runtime-platform.ts';
import { RECOVERY_BUDGET_UNAVAILABLE_MESSAGE } from '../runtime-policy.ts';
import { SOURCE_ACTIVATION_PROTOCOL_SUFFIX, sourceActivationObjectiveBinding } from '../source-activation.ts';
import { consumeSourceActivationRestart } from '../user-input-authority.ts';
import { consumeAuthenticatedInternalContinuation as sessionOpConsumeAuthenticatedInternalContinuation, consumeDelegatedDispatchContinuation as sessionOpConsumeDelegatedDispatchContinuation } from './message-authority.ts';
import { buildRecoveryDispatchMessage as sessionOpBuildRecoveryDispatchMessage } from './user-input-recovery.ts';
import { buildObjectiveRuntimePrompt as sessionOpBuildObjectiveRuntimePrompt } from './restore-pre-ack-agent-delivery-dequeues.ts';
import { hasQueuedUserInput as sessionOpHasQueuedUserInput } from './perform-request-user-input.ts';
import { loadSessionPlaybook as sessionOpLoadSessionPlaybook, loadSessionProjectMemoryContext as sessionOpLoadSessionProjectMemoryContext } from './capture-user-correction.ts';
import { assertMissionOwnedRecoveryProviderFence as sessionOpAssertMissionOwnedRecoveryProviderFence } from './preflight-mission-tool-invocation-with-catalog.ts';
import { pendingPermissionWatchdogRemainingMs as sessionOpPendingPermissionWatchdogRemainingMs } from './expire-pending-permission-request.ts';
import { processEvent as sessionOpProcessEvent } from './process-event.ts';
import { flushSessionPersistenceInBackground as sessionOpFlushSessionPersistenceInBackground } from './persistence-barriers.ts';
import type { ProviderTurnInput } from './provider-turn-input.ts';

export async function executeSessionProviderTurn(
    providerTurnInput: ProviderTurnInput
): Promise<void> {
    const {
        assertActivePreparation,
        ownsActiveTurn,
        abandonStoppedTurn,
        recoveryHandoffPaused,
        sessionOperationContext,
        managed,
        activeProviderState,
        activeMessageState,
        userMessage,
        agent,
        sendSpan,
    } = providerTurnInput;
try {
        assertActivePreparation();
        sessionLog.info('Starting chat for session:', providerTurnInput.sessionId);
        sessionLog.info('Workspace:', JSON.stringify(managed.workspace, null, 2));
        sessionLog.info('Message:', activeMessageState.message);
        sessionLog.info('Agent model:', agent.getModel());
        sessionLog.info('process.cwd():', process.cwd());
        // Process the message through the agent
        sessionLog.info('Calling agent.chat()...');
        if (providerTurnInput.attachments?.length) {
            sessionLog.info('Attachments:', providerTurnInput.attachments.length);
        }
        // Skills mentioned via @mentions are handled by the SDK's Skill tool.
        // The UI layer (extractBadges in mentions.ts) injects fully-qualified names
        // in the rawText, and canUseTool in craft-agent.ts provides a fallback
        // to qualify short names. No transformation needed here.
        // Ensure main process reads tool metadata from the correct session directory.
        // This must be set before each chat() call since multiple sessions share the process.
        const chatSessionDir = getSessionStoragePath(persistenceRootFor(managed), providerTurnInput.sessionId);
        toolMetadataStore.setSessionDir(chatSessionDir);
        // Inject interruption context so the LLM knows the previous turn was cut short.
        // Uses <system-reminder> tags so the LLM treats it as transient system guidance
        // rather than part of the user's message content. The original message is stored
        // in session JSONL (line ~3952); this only affects the SDK's in-process context.
        let effectiveMessage = activeMessageState.message;
        if (!providerTurnInput.cleanRecoveryHandoffPrompt && managed.playbookSlug) {
            const playbook = sessionOpLoadSessionPlaybook(sessionOperationContext, managed);
            if (playbook)
                effectiveMessage = `${formatPlaybookPrompt(playbook)}\n\n${effectiveMessage}`;
        }
        if (!providerTurnInput.cleanRecoveryHandoffPrompt && managed.wasInterrupted && !activeMessageState.options?.hidden) {
            effectiveMessage = `${activeMessageState.message}\n\n<system-reminder>The previous assistant response was interrupted by the user and may be incomplete. Do not repeat or continue the interrupted response unless asked. Focus on the new message above.</system-reminder>`;
        }
        managed.wasInterrupted = false;
        try {
            const persistenceRootPath = persistenceRootFor(managed);
            const policy = await getProjectLearningPolicy(persistenceRootPath);
            if (!providerTurnInput.cleanRecoveryHandoffPrompt && policy.enabled && canInjectCompletedChatContext(managed.projectId, activeMessageState.options)) {
                const remembered = await completedChatContext(persistenceRootPath, managed.projectId, activeMessageState.message, managed.id);
                assertActivePreparation();
                if (remembered)
                    effectiveMessage += `\n\n${remembered}`;
            }
        }
        catch (error) {
            sessionLog.warn('Completed-chat context unavailable', { sessionId: providerTurnInput.sessionId, error: String(error) });
        }
        assertActivePreparation();
        if (managed.activeObjective?.terminalState === 'active') {
            const objectivePrompt = isLegacyHostObjectiveContractEnabled(managed)
                ? !providerTurnInput.cleanRecoveryHandoffPrompt ? sessionOpBuildObjectiveRuntimePrompt(sessionOperationContext, managed, managed.activeObjective) : ''
                : buildObjectiveScopePrompt(managed.activeObjective, managed.messages, userMessage.id, incompletePlanSteps(managed.messages, managed.activeObjective.userMessageId));
            if (objectivePrompt)
                effectiveMessage += `\n\n${objectivePrompt}`;
        }
        if (!providerTurnInput.cleanRecoveryHandoffPrompt && managed.projectId) {
            try {
                const memory = await sessionOpLoadSessionProjectMemoryContext(sessionOperationContext, managed, findObjectiveText(managed.messages, managed.activeObjective) ?? activeMessageState.message);
                if (memory)
                    effectiveMessage += `\n\n${memory}`;
            }
            catch (error) {
                sessionLog.warn('Project memory retrieval unavailable', { sessionId: providerTurnInput.sessionId, error: String(error) });
            }
        }
        assertActivePreparation();
        const messageBackendContext = resolveBackendContext({
            sessionConnectionSlug: managed.llmConnection,
            workspaceDefaultConnectionSlug: loadWorkspaceConfig(providerTurnInput.workspaceRootPath)?.defaults?.defaultLlmConnection,
            managedModel: managed.model,
        });
        const modelInputAttachments = filterAttachmentsForModelInput(providerTurnInput.attachments, messageBackendContext.connection, messageBackendContext.resolvedModel);
        if (modelInputAttachments.omittedImages.length > 0) {
            const omittedNames = modelInputAttachments.omittedImages.map(a => a.name).join(', ');
            sessionLog.info(`Omitting ${modelInputAttachments.omittedImages.length} image attachment(s) from model input for ${messageBackendContext.resolvedModel}: ${omittedNames}`);
            sessionOperationContext.owner["sendEvent"]({
                type: 'info',
                sessionId: providerTurnInput.sessionId,
                message: `Image attachment${modelInputAttachments.omittedImages.length === 1 ? '' : 's'} not sent because image input is disabled for ${messageBackendContext.resolvedModel}.`,
                level: 'warning',
            }, managed.workspace.id);
        }
        assertActivePreparation();
        const liveRecoveryDispatch = managed.pendingTurnRecovery?.recoveryDispatch;
        if (!isWorkspaceAutomaticToolFallbackEnabled(loadWorkspaceConfig(providerTurnInput.workspaceRootPath))
            && activeMessageState.options?.automaticRecovery?.cause !== 'user_retry'
            && liveRecoveryDispatch?.phase === 'started'
            && liveRecoveryDispatch.id === userMessage.id
            && liveRecoveryDispatch.id === activeMessageState.options?.automaticRecovery?.dispatchId
            && liveRecoveryDispatch.fallbackIntent) {
            const previousPrompt = activeMessageState.message;
            const genericDispatch = { ...liveRecoveryDispatch };
            delete genericDispatch.fallbackIntent;
            managed.pendingTurnRecovery = {
                ...managed.pendingTurnRecovery!,
                recoveryDispatch: genericDispatch,
            };
            const genericPrompt = sessionOpBuildRecoveryDispatchMessage(sessionOperationContext, managed, managed.pendingTurnRecovery, genericDispatch);
            activeMessageState.message = genericPrompt;
            userMessage.content = genericPrompt;
            if (userMessage.internalOrigin?.kind === 'browser-fallback')
                delete userMessage.internalOrigin;
            if (activeMessageState.options?.internalOrigin?.kind === 'browser-fallback') {
                const { internalOrigin: _disabledFallbackOrigin, ...sanitizedOptions } = activeMessageState.options;
                activeMessageState.options = sanitizedOptions;
            }
            managed.lastSentMessage = genericPrompt;
            managed.lastSentOptions = activeMessageState.options;
            effectiveMessage = effectiveMessage.includes(previousPrompt)
                ? effectiveMessage.replace(previousPrompt, genericPrompt)
                : genericPrompt;
            sessionOperationContext.owner["persistSession"](managed);
            await sessionOperationContext.owner.flushSession(managed.id);
            assertActivePreparation();
        }
        sendSpan.mark('chat.starting');
        const sourceTurnBinding = sourceActivationObjectiveBinding(managed.activeObjective);
        if (sourceTurnBinding) {
            const pendingForTurn = providerTurnInput.sourceActivationOrigin && managed.autoRetryPending?.sourceActivationId === providerTurnInput.sourceActivationOrigin.sourceActivationId
                ? managed.autoRetryPending : undefined;
            managed.sourceActivationTurn = {
                generation: providerTurnInput.myGeneration,
                cancellationEpoch: sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0,
                rawMessage: pendingForTurn?.rawMessage
                    ?? (providerTurnInput.sourceActivationOrigin ? activeMessageState.message.replace(SOURCE_ACTIVATION_PROTOCOL_SUFFIX, '') : activeMessageState.message),
                ...sourceTurnBinding,
            };
        }
        sessionOperationContext.owner["startGenerationTelemetry"](managed, providerTurnInput.myGeneration, {
            turnId: userMessage.id,
            connectionSlug: messageBackendContext.connection?.slug,
            providerType: messageBackendContext.connection?.providerType,
            model: agent.getModel(),
            inputTokens: managed.tokenUsage?.inputTokens,
            recordRoutingOutcome: !providerTurnInput.localCompactCommand,
        });
        // Consume immediately before the synchronous provider handoff. No await
        // separates this point from agent.chat(), so a later human turn cannot
        // reuse the private continuation capability.
        assertActivePreparation();
        sessionOpConsumeAuthenticatedInternalContinuation(sessionOperationContext, providerTurnInput.authenticatedInternalContinuationToken);
        sessionOpConsumeDelegatedDispatchContinuation(sessionOperationContext, providerTurnInput.delegatedDispatchContinuationToken);
        sessionOperationContext.state.runtimeProcessingGenerations.set(agent, providerTurnInput.myGeneration);
        sessionOperationContext.state.runtimeToolAdmissionBindings.set(agent, {
            managed,
            sessionId: managed.id,
            generation: providerTurnInput.myGeneration,
            activeObjective: managed.activeObjective,
            authorityEpoch: sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0,
            userMessage,
            userMessageId: userMessage.id,
            messageCountAtHandoff: managed.messages.length,
            lastSentOptions: managed.lastSentOptions,
            automaticRecovery: activeMessageState.options?.automaticRecovery,
            pendingTurnRecovery: managed.pendingTurnRecovery,
            recoveryDispatch: managed.pendingTurnRecovery?.recoveryDispatch,
        });
        const { hasExplicitProviderHandoff, commitProviderHandoffOnce } = installProviderTurnHooks(providerTurnInput);
        if (activeMessageState.options?.automaticRecovery) {
            // No await may separate this exact MissionRuntime ownership/boundary
            // fence from agent.chat(). A restored reviewer cannot be resumed by
            // the generic scheduler under stale permissions, sources or isolation.
            sessionOpAssertMissionOwnedRecoveryProviderFence(sessionOperationContext, managed);
        }
        // Synchronous last-mile projection fence. The backend's canonical
        // beforeProviderExecution callback rechecks live config/source/credential
        // identities at the actual provider boundary.
        assertOrdinaryMissionRouteProjection(managed);
        activeProviderState.providerHandoffArmed = true;
        emitOperationsEvent({
            kind: 'turn.started', at: new Date().toISOString(),
            workspaceId: managed.workspace.id, sessionId: managed.id,
            missionId: managed.missionId, workItemId: managed.missionWorkItemId,
            turnId: userMessage.id, connectionSlug: messageBackendContext.connection?.slug,
            model: agent.getModel(), thinkingLevel: managed.thinkingLevel,
        });
        const chatIterator = agent.chat(effectiveMessage, modelInputAttachments.attachments);
        const automaticRecoveryInactivityTimeoutMs = activeMessageState.options?.automaticRecovery
            ? resolveAutomaticRecoveryInactivityTimeoutMs(process.env.CRAFT_AUTOMATIC_RECOVERY_INACTIVITY_TIMEOUT_MS)
            : 0;
        const toolDeadline = createAutomaticRecoveryToolDeadline(messageBackendContext.provider, automaticRecoveryInactivityTimeoutMs);
        const chatEvents = activeMessageState.options?.automaticRecovery
            ? withAutomaticRecoveryInactivityTimeout(chatIterator, automaticRecoveryInactivityTimeoutMs, toolDeadline.remainingMs, () => sessionOpPendingPermissionWatchdogRemainingMs(sessionOperationContext, managed.id))
            : chatIterator;
        const monitoredChatEvents: AsyncIterable<AgentEvent> = hasExplicitProviderHandoff
            ? {
                async *[Symbol.asyncIterator]() {
                    const iterator = chatEvents[Symbol.asyncIterator]();
                    try {
                        while (true) {
                            const next = await Promise.race([
                                iterator.next(),
                                activeProviderState.providerHandoffDurabilityFailure,
                            ]);
                            if (next.done)
                                return;
                            yield next.value;
                        }
                    }
                    finally {
                        try {
                            const closing = iterator.return?.(undefined);
                            if (closing)
                                void Promise.resolve(closing).catch(() => { });
                        }
                        catch { /* the owning error path disposes the runtime */ }
                    }
                },
            }
            : chatEvents;
        sessionLog.info('Got chat iterator, starting iteration...');
        for await (const event of monitoredChatEvents) {
            if (!hasExplicitProviderHandoff)
                commitProviderHandoffOnce();
            if (activeProviderState.providerHandoffDurabilityPromise)
                await activeProviderState.providerHandoffDurabilityPromise;
            if (hasExplicitProviderHandoff && !activeProviderState.chatStarted) {
                // Explicit backends may reject a turn locally (missing skill, unsupported
                // attachment, failed child preflight) by yielding an error followed by
                // complete. Neither event proves provider consumption. Keep the error
                // out of the durable transcript — an error row after the claimed agent
                // receipt is otherwise treated as consumption evidence on restart — and
                // route the terminal complete through the exact pre-provider rollback.
                if (event.type === 'error') {
                    activeProviderState.preProviderTerminalError = new Error(event.message);
                    continue;
                }
                if (event.type === 'typed_error') {
                    activeProviderState.preProviderTerminalError = new Error(event.error.message);
                    continue;
                }
                if (event.type === 'runtime_interrupted') {
                    activeProviderState.preProviderTerminalError = new Error(event.message);
                    continue;
                }
                if (event.type === 'complete') {
                    throw activeProviderState.preProviderTerminalError
                        ?? new Error('Agent stream completed before provider handoff');
                }
            }
            // Log events (skip noisy text_delta)
            if (event.type !== 'text_delta') {
                if (event.type === 'tool_start') {
                    sessionLog.info(`tool_start: ${event.toolName} (${event.toolUseId})`);
                }
                else if (event.type === 'tool_result') {
                    sessionLog.info(`tool_result: ${event.toolUseId} isError=${event.isError}`);
                }
                else {
                    sessionLog.info('Got event:', event.type);
                }
            }
            // Process the event first
            if (ownsActiveTurn()) {
                toolDeadline.observe(event);
                if (event.type === 'tool_start')
                    activeProviderState.pendingToolReceipts.add(event.toolUseId);
                else if (event.type === 'tool_result')
                    activeProviderState.pendingToolReceipts.delete(event.toolUseId);
            }
            await sessionOpProcessEvent(sessionOperationContext, managed, event, providerTurnInput.myGeneration);
            if (userMessage.providerDispatch?.state === 'accepted'
                && activeProviderState.exactProviderWriteAheadMatches()) {
                const dispatchIndex = managed.messages.indexOf(userMessage);
                const hasDurableProviderActivity = dispatchIndex >= 0
                    && managed.messages.slice(dispatchIndex + 1).some(candidate => (isDurableProviderActivityOrHumanSupersession(managed, candidate)));
                // Durable output/tool state makes the ACK receipt redundant. A bare
                // `complete` also proves consumption, but cannot clear this fence
                // yet: the same durable snapshot must first contain the distinct
                // generic continuation, otherwise a crash at that seam could replay
                // a structured answer whose provider already completed.
                if (hasDurableProviderActivity)
                    await activeProviderState.clearAcceptedProviderWriteAhead();
            }
            if (sessionOperationContext.state.shuttingDown)
                continue;
            // Fallback: Capture SDK session ID if the onSdkSessionIdUpdate callback didn't fire.
            // Primary capture happens in getOrCreateAgent() via onSdkSessionIdUpdate callback,
            // which immediately flushes to disk. This fallback handles edge cases where the
            // callback might not fire (e.g., SDK version mismatch, callback not supported).
            if (!managed.sdkSessionId) {
                const sdkId = agent.getSessionId();
                if (sdkId) {
                    managed.sdkSessionId = sdkId;
                    sessionLog.info(`Captured SDK session ID via fallback: ${sdkId}`);
                    // Also flush here since we're in fallback mode
                    sessionOperationContext.owner["persistSession"](managed);
                    sessionOpFlushSessionPersistenceInBackground(sessionOperationContext, managed, 'fallback SDK session ID capture');
                }
            }
            if (await handleProviderTurnEvent(providerTurnInput, event))
                return;
            // NOTE: We no longer break early on !isProcessing or stopRequested.
            // After soft interrupt (forceAbort), the backend sets turnComplete=true which causes
            // the generator to yield remaining queued events and then complete naturally.
            // This ensures we don't lose in-flight messages.
        }
        if (sessionOperationContext.state.shuttingDown) {
            sendSpan.end();
            return;
        }
        if (activeProviderState.providerHandoffDurabilityPromise)
            await activeProviderState.providerHandoffDurabilityPromise;
        if (!activeProviderState.chatStarted && ownsActiveTurn()) {
            throw new Error('Agent stream ended before the first provider event');
        }
        // Loop exited - either via complete event (normal) or generator ended after soft interrupt
        if (!managed.isProcessing) {
            await activeProviderState.clearAcceptedProviderWriteAhead();
            sessionLog.info('Chat loop exited after explicit handoff/stop');
            sendSpan.mark('chat.exit.already_stopped');
            sendSpan.end();
        }
        else if (sessionOperationContext.owner["hasPendingUserInput"](managed) || sessionOpHasQueuedUserInput(sessionOperationContext, managed)) {
            await activeProviderState.clearAcceptedProviderWriteAhead();
            sendSpan.end();
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
        }
        else if (managed.stopRequested) {
            sessionLog.info('Chat loop completed after stop request - events drained successfully');
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
        }
        else if (consumeSourceActivationRestart(managed, providerTurnInput.myGeneration)) {
            sessionLog.info('Chat loop exited for scheduled source activation restart', {
                sessionId: providerTurnInput.sessionId,
                generation: providerTurnInput.myGeneration,
            });
            sendSpan.mark('chat.exit.source_activation_restart');
            await activeProviderState.clearAcceptedProviderWriteAhead();
            sendSpan.end();
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'interrupted', providerTurnInput.myGeneration);
        }
        else {
            sessionLog.warn('Chat loop exited unexpectedly', {
                sessionId: providerTurnInput.sessionId,
                generation: providerTurnInput.myGeneration,
                pendingTurnRecovery: managed.pendingTurnRecovery
                    ? {
                        userMessageId: managed.pendingTurnRecovery.userMessageId,
                        attempts: managed.pendingTurnRecovery.attempts,
                    }
                    : undefined,
            });
            const recoveryQueued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'stream_ended');
            if (recoveryHandoffPaused()) {
                sendSpan.end();
                await abandonStoppedTurn();
                return;
            }
            if (!recoveryQueued) {
                await sessionOpProcessEvent(sessionOperationContext, managed, {
                    type: 'error',
                    message: managed.pendingTurnRecovery?.budgetHistoryUnavailable
                        ? RECOVERY_BUDGET_UNAVAILABLE_MESSAGE
                        : 'The agent stream ended unexpectedly after bounded automatic recovery. Completed work was preserved; retry to resume safely.',
                }, providerTurnInput.myGeneration);
            }
            await activeProviderState.clearAcceptedProviderWriteAhead();
            await sessionOperationContext.owner["onProcessingStopped"](providerTurnInput.sessionId, 'error', providerTurnInput.myGeneration);
        }
    }
    catch (error) {
        return await handleProviderTurnError(providerTurnInput, error);
    }
    finally {
        await restoreProviderTurnHooks(providerTurnInput);
    }
}
