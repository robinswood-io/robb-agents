import { compactPreparedAgentContext } from './runtime-context-compaction.ts';
import { handleRuntimePreparationError } from './runtime-preparation-error.ts';
import { queuedCostLimitContinuationForAgentDelivery, persistenceRootFor, assertSpecializedMissionSourceSelection, captureSpecializedMissionSourceSnapshot, ordinaryMissionSourceBuildOptions } from '../policy.ts';
import { resolveSessionConnection } from '@craft-agent/shared/agent/backend';
import { decideCostProviderAdmission, monetaryBudgetCostUsd, resolveAgentCostBudgetState, resolveAgentCostControlPolicy, resolveEffectiveAgentContextLimits } from '@craft-agent/shared/config';
import type { CostControlledTurnKind } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import type { PendingTurnRecovery } from '@craft-agent/shared/sessions';
import { loadAllSources, getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources';
import type { LoadedSource } from '@craft-agent/shared/sources';
import { buildCleanRecoveryContinuationPrompt, createPendingTurnRecovery } from '../../turn-recovery';
import { resolveContextTokenEstimate } from '../../context-token-estimate';
import { objectiveCostUsd } from '../../objective-contract';
import { consumeContextProviderBaselineAdmission, decideContextProviderAdmission } from '../../context-compaction';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import type { AgentInstance } from '../runtime-types.ts';
import { buildServersFromSources, refreshExpiredCredentials } from '../source-build.ts';
import { COST_LIMIT_NEXT_STEP_QUESTIONS, isCostLimitContinuationAnswer, isExactContextLimitNextStepQuestion, resolveManagedSessionContextWindow } from '../user-input-authority.ts';
import type { SessionOperations } from '../operation-types.ts';
import { consumeQueuedCostLimitContinuation as sessionOpConsumeQueuedCostLimitContinuation } from './perform-request-user-input.ts';
import { getCollectionSummarizer as sessionOpGetCollectionSummarizer } from './try-refresh-agent-runtime.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo, stopYoloHumanHandoff as sessionOpStopYoloHumanHandoff } from './is-managed-session-yolo.ts';
import type { RuntimePreparationInput, PreparedAgentRuntime } from './runtime-preparation-input.ts';

export async function prepareSessionAgentRuntime(
    runtimePreparationInput: RuntimePreparationInput
): Promise<PreparedAgentRuntime | undefined> {
    const {
        managed,
        activeMessageState,
        userMessage,
        sessionOperationContext,
        assertActivePreparation,
        sendSpan,
    } = runtimePreparationInput;
    let cleanRecoveryProviderReset: boolean = runtimePreparationInput.cleanRecoveryProviderReset;
    let cleanRecoveryHandoffPrompt = cleanRecoveryProviderReset;
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
            && !!runtimePreparationInput.trustedUserInput
            && isCostLimitContinuationAnswer(runtimePreparationInput.trustedUserInput);
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
                await sessionOperationContext.owner["onProcessingStopped"](runtimePreparationInput.sessionId, 'interrupted', runtimePreparationInput.myGeneration);
                return;
            }
            const hasPendingQuestion = managed.userInputRequests?.some(request => request.status === 'pending') === true;
            if (!hasPendingQuestion) {
                await sessionOperationContext.owner.requestUserInput(managed.id, COST_LIMIT_NEXT_STEP_QUESTIONS);
                assertActivePreparation();
            }
            sendSpan.mark('cost.hard-limit-provider-blocked');
            sendSpan.end();
            await sessionOperationContext.owner["onProcessingStopped"](runtimePreparationInput.sessionId, 'interrupted', runtimePreparationInput.myGeneration);
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
        let sources: LoadedSource[] = runtimePreparationInput.hasSources ? getSourcesBySlugs(runtimePreparationInput.workspaceRootPath, runtimePreparationInput.enabledSlugs)
            : [];
        assertSpecializedMissionSourceSelection(managed, runtimePreparationInput.enabledSlugs);
        if (managed.missionCapabilityLock) {
            if (sources.length !== runtimePreparationInput.enabledSlugs.length) {
                throw new Error('Specialized Mission source snapshot is incomplete');
            }
            sources = await captureSpecializedMissionSourceSnapshot(managed, sources);
            managed.missionTurnSourceSnapshot = sources;
        }
        if (runtimePreparationInput.hasSources && managed.tokenRefreshManager && !managed.missionCapabilityLock) {
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
            await compactPreparedAgentContext(runtimePreparationInput, agent, contextTokens, effectiveContextLimits, contextCompactionObjectiveRootId);
            assertActivePreparation();
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
                    const businessAnswerHandoff = runtimePreparationInput.trustedUserInput && !runtimePreparationInput.trustedContextLimitAnswer
                        && pending && !hasPendingContextLimit
                        ? sessionOperationContext.owner["createAutonomousContextLimitHandoff"](managed, pending)
                        : undefined;
                    if (businessAnswerHandoff) {
                        const queued = await sessionOperationContext.owner["enqueueAutomaticTurnRecovery"](managed, 'objective_continue', pending?.validationGaps, businessAnswerHandoff.remainingWork, undefined, undefined, true);
                        if (queued || managed.pendingTurnRecovery?.exhaustedAt) {
                            sendSpan.mark(`context.hard-limit-business-answer-handoff`);
                            sendSpan.end();
                            await sessionOperationContext.owner["onProcessingStopped"](runtimePreparationInput.sessionId, 'interrupted', runtimePreparationInput.myGeneration);
                            return;
                        }
                    }
                    const answeredContextLimit = (managed.userInputRequests ?? []).find(request => request.status === 'answered'
                        && request.responseMessageId === userMessage.id
                        && isExactContextLimitNextStepQuestion(request));
                    const isContextLimitAnswerOrigin = runtimePreparationInput.trustedContextLimitAnswer !== undefined
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
            : loadAllSources(runtimePreparationInput.workspaceRootPath);
        agent.setAllSources(allSources);
        sendSpan.mark('sources.loaded');
        // Apply source servers if any are enabled
        if (runtimePreparationInput.hasSources) {
            const sessionPath = getSessionStoragePath(persistenceRootFor(managed), runtimePreparationInput.sessionId);
            // Single fresh build — tokens already refreshed above.
            const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, sessionOpGetCollectionSummarizer(sessionOperationContext, managed), managed.missionCapabilityLock ? () => sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed) : undefined, managed.missionCapabilityLock, ordinaryMissionSourceBuildOptions(managed));
            assertActivePreparation();
            if (errors.length > 0) {
                sessionLog.warn(`Source build errors:`, errors);
            }
            const mcpCount = Object.keys(mcpServers).length;
            const apiCount = Object.keys(apiServers).length;
            if (mcpCount > 0 || apiCount > 0 || runtimePreparationInput.enabledSlugs.length > 0) {
                const usableSources = sources.filter(isSourceUsable);
                const intendedSlugs = usableSources.map(s => s.config.slug);
                await agent.setSourceServers(mcpServers, apiServers, intendedSlugs);
                assertActivePreparation();
                assertActivePreparation();
                sessionLog.info(`Applied ${mcpCount} MCP + ${apiCount} API sources to session ${runtimePreparationInput.sessionId} (${allSources.length} total)`);
            }
            sendSpan.mark('servers.applied');
        }
    }
    catch (error) {
        await handleRuntimePreparationError(runtimePreparationInput, error, cleanRecoveryConversionFlushFailed, cleanRecoveryHandoffPrompt);
        return;
    }
    return { agent, cleanRecoveryHandoffPrompt };
}
