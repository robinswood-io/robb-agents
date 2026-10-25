import { createRuntimeIdentityCallbacks } from './agent-runtime-identity-callbacks.ts';
import { createRuntimeContextCallbacks } from './agent-runtime-context-callbacks.ts';
import { installRuntimeDebugCallbacks } from './agent-runtime-debug-callbacks.ts';
import { installRuntimeBrowserCallbacks } from './agent-runtime-browser-callbacks.ts';
import { installRuntimePermissionCallbacks } from './agent-runtime-permission-callbacks.ts';
import { installRuntimePlanAuthCallbacks } from './agent-runtime-plan-auth-callbacks.ts';
import { installRuntimeSessionToolCallbacks } from './agent-runtime-session-tool-callbacks.ts';
import { installRuntimeSourceCallbacks } from './agent-runtime-source-callbacks.ts';
import type { SessionOperationContext } from '../operation-context.ts';
import { refreshInheritedWorkspaceSources, persistenceRootFor, loadSpecializedMissionSkillPackages, assertSpecializedMissionSourceSelection, assertOrdinaryMissionRouteProjection, ordinaryMissionSourceBuildOptions } from '../policy.ts';
import { join } from 'path';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { setPermissionMode, hydratePreviousPermissionMode, getPermissionModeDiagnostics } from '@craft-agent/shared/agent';
import { resolveBackendContext, createBackendFromResolvedContext } from '@craft-agent/shared/agent/backend';
import { getDefaultThinkingLevel, monetaryBudgetCostUsd, resolveAgentCostBudgetState, resolveAgentCostControlPolicy, resolveEffectiveAgentContextLimits, getMiniModel, getGitBashPath } from '@craft-agent/shared/config';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { loadAllSources, isSourceUsable } from '@craft-agent/shared/sources';
import { toolMetadataStore } from '@craft-agent/shared/interceptor';
import { McpClientPool, McpPoolServer } from '@craft-agent/shared/mcp';
import { perf } from '@craft-agent/shared/utils';
import { buildBackendRuntimeSignature, buildRestartRequiredSignature } from '../../runtime-config';
import { resolveContextTokenEstimate } from '../../context-token-estimate';
import { objectiveCostUsd } from '../../objective-contract';
import { resizeImageForAPI } from '@craft-agent/server-core/services';
import type { ManagedSession } from '../managed-session.ts';
import { buildBackendHostRuntimeContext, hasImmutableMissionRoute } from '../mission-route.ts';
import { _platform, sessionLog } from '../runtime-platform.ts';
import { AGENT_FLAGS } from '../runtime-policy.ts';
import type { AgentInstance, CostControlledTurnContext } from '../runtime-types.ts';
import { buildServersFromSources } from '../source-build.ts';
import { resolveSupportsBranching } from '../source-selection.ts';
import { resolveManagedSessionContextWindow } from '../user-input-authority.ts';
import { reloadSessionSourcesWithinOperation as sessionOpReloadSessionSourcesWithinOperation } from './workspace-configuration.ts';
import { resolveSpecializedMissionRouteSnapshot as sessionOpResolveSpecializedMissionRouteSnapshot, resolveOrdinaryMissionRouteSnapshot as sessionOpResolveOrdinaryMissionRouteSnapshot, assertOrdinaryMissionSourceBindingAtTransport as sessionOpAssertOrdinaryMissionSourceBindingAtTransport, assertMissionProviderExecution as sessionOpAssertMissionProviderExecution } from './resolve-ordinary-mission-route-snapshot.ts';
import { getCollectionSummarizer as sessionOpGetCollectionSummarizer } from './try-refresh-agent-runtime.ts';
import { getCollectionCacheScope as sessionOpGetCollectionCacheScope } from './evict-idle-session-runtimes.ts';
import { isManagedSessionYolo as sessionOpIsManagedSessionYolo, reportBackendAuthUnavailable as sessionOpReportBackendAuthUnavailable } from './is-managed-session-yolo.ts';
import { resolveRuntimeObjectiveMutationAuthority as sessionOpResolveRuntimeObjectiveMutationAuthority } from './resolve-objective-mutation-authority.ts';
import { admitBackendToolExecution as sessionOpAdmitBackendToolExecution } from './admit-backend-tool-execution.ts';
import { trackSessionOperation as sessionOpTrackSessionOperation } from './track-session-operation.ts';
import { spawnDelegatedSession as sessionOpSpawnDelegatedSession } from './spawn-delegated-session.ts';

/**
 * Get or create agent for a session (lazy loading)
 * Creates the appropriate backend agent based on LLM connection.
 *
 * Provider resolution order:
 * 1. session.llmConnection (locked after first message)
 * 2. workspace.defaults.defaultLlmConnection
 * 3. global defaultLlmConnection
 * 4. fallback: no connection configured
 */
async function sessionOpGetOrCreateAgent(sessionOperationContext: SessionOperationContext, managed: ManagedSession, costTurn?: CostControlledTurnContext, assertActivePreparation?: () => void): Promise<AgentInstance> {
    // A failed deletion teardown can restore the transcript to the runtime map
    // while deliberately keeping this exact ManagedSession retired. Until a
    // later deletion retry proves the old process is gone, no code path may
    // attach a replacement runtime beside that unproven process.
    if (sessionOperationContext.state.retiringSessions.has(managed)) {
        throw new Error(`Session ${managed.id} runtime is still being retired`);
    }
    assertActivePreparation?.();
    // Restart recovery constructs descendants before their parents. Hydrate the
    // authority owner before installing a terminal child runtime so exact
    // persisted observation replays cannot disappear merely because the parent
    // transcript is still cold. Malformed lineage remains untouched here and
    // is denied by resolveObjectiveMutationAuthority below.
    const delegation = managed.delegation;
    if (delegation) {
        const authorityOwner = sessionOperationContext.state.sessions.get(delegation.rootSessionId);
        const structurallyBoundReviewer = !!delegation.reviewBinding
            && delegation.role === 'reviewer'
            && delegation.depth === 1
            && managed.parentSessionId === delegation.rootSessionId
            && delegation.rootObjectiveId === delegation.reviewBinding.objectiveId
            && delegation.parentObjectiveId === delegation.reviewBinding.objectiveId;
        if (authorityOwner && authorityOwner.workspace.id === managed.workspace.id
            && (structurallyBoundReviewer || authorityOwner.activeObjective?.terminalReconciliation)
            && !authorityOwner.messagesLoaded) {
            await sessionOperationContext.owner["ensureMessagesLoaded"](authorityOwner);
            assertActivePreparation?.();
        }
    }
    let workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
    await sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed);
    if (managed.missionCapabilityLock && !managed.missionSealedSkillPackages) {
        managed.missionSealedSkillPackages = loadSpecializedMissionSkillPackages(managed, managed.missionCapabilityLock);
    }
    assertActivePreparation?.();
    assertOrdinaryMissionRouteProjection(managed);
    const inheritedSourcesChanged = hasImmutableMissionRoute(managed)
        ? false
        : refreshInheritedWorkspaceSources(managed, workspaceConfig);
    if (inheritedSourcesChanged) {
        sessionOperationContext.owner["sendEvent"]({
            type: 'sources_changed',
            sessionId: managed.id,
            enabledSourceSlugs: managed.enabledSourceSlugs ?? [],
        }, managed.workspace.id);
    }
    if (inheritedSourcesChanged && managed.agent) {
        await sessionOpReloadSessionSourcesWithinOperation(sessionOperationContext, managed);
        assertActivePreparation?.();
    }
    const externalActionPolicy = workspaceConfig?.defaults?.externalActionPolicy ?? 'confirm';
    if (managed.agent) {
        sessionOperationContext.owner["applyExternalActionPolicyToRuntime"](managed, managed.pendingExternalActionPolicy ?? externalActionPolicy, 'send-path refresh');
    }
    { }
    assertActivePreparation?.();
    // The policy handoff can await summary generation or runtime teardown.
    // Re-read the master switch before every downstream model/thinking choice
    // so an ON -> OFF toggle cannot leak into cost-control in the same turn.
    workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
    const specializedRouteSnapshot = await sessionOpResolveSpecializedMissionRouteSnapshot(sessionOperationContext, managed);
    const ordinaryRouteSnapshot = await sessionOpResolveOrdinaryMissionRouteSnapshot(sessionOperationContext, managed);
    let sealedRouteSnapshot = specializedRouteSnapshot ?? ordinaryRouteSnapshot;
    const availableContext = sealedRouteSnapshot?.context ?? resolveBackendContext({
        sessionConnectionSlug: managed.llmConnection,
        workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
        managedModel: managed.model,
    });
    if (costTurn && !hasImmutableMissionRoute(managed)) {
        const policy = resolveAgentCostControlPolicy(workspaceConfig?.costControl);
        const contextTokens = resolveContextTokenEstimate(managed.tokenUsage?.contextTokens, managed.messages);
        const limits = resolveEffectiveAgentContextLimits(policy.context, resolveManagedSessionContextWindow(managed));
        const budgetState = resolveAgentCostBudgetState(monetaryBudgetCostUsd(availableContext.connection, objectiveCostUsd(managed.activeObjective, managed.tokenUsage?.costUsd)), policy.budgets);
        managed.pendingRoutingMeta = { ...managed.pendingRoutingMeta, costControl: { turnKind: costTurn.options?.automaticRecovery ? 'automatic-recovery' : 'direct', budgetState, thinkingLevel: managed.thinkingLevel ?? getDefaultThinkingLevel(), contextTokensBefore: contextTokens, compactAtTokens: limits.compactAtTokens, hardLimitTokens: limits.hardLimitTokens, hardContextLimitReached: contextTokens >= limits.hardLimitTokens } };
    }
    // Refresh runtime config in-place when the connection has drifted since
    // the agent was created. May null out `managed.agent` if the in-place
    // refresh fails, in which case the create branch below rebuilds it.
    await sessionOperationContext.owner["tryRefreshAgentRuntime"](managed, 'send-path refresh', assertActivePreparation);
    assertActivePreparation?.();
    // Refresh the sealed snapshot after every await-capable reconciliation.
    // The backend receives this exact frozen connection and revalidates the
    // canonical identities once more immediately before provider execution.
    sealedRouteSnapshot = await sessionOpResolveSpecializedMissionRouteSnapshot(sessionOperationContext, managed)
        ?? await sessionOpResolveOrdinaryMissionRouteSnapshot(sessionOperationContext, managed);
    const backendContext = sealedRouteSnapshot?.context ?? resolveBackendContext({
        sessionConnectionSlug: managed.llmConnection,
        workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
        managedModel: managed.model,
    });
    const connection = backendContext.connection;
    const sigInput = {
        connection,
        provider: backendContext.provider,
        authType: backendContext.authType,
        resolvedModel: backendContext.resolvedModel,
    };
    const runtimeSignature = buildBackendRuntimeSignature(sigInput);
    const restartSignature = buildRestartRequiredSignature(sigInput);
    if (!managed.agent) {
        const end = perf.start('agent.create', { sessionId: managed.id });
        // Lock the connection after first resolution
        // This ensures the session always uses the same provider
        if (connection && !managed.connectionLocked) {
            managed.llmConnection = connection.slug;
            managed.connectionLocked = true;
            sessionLog.info(`Locked session ${managed.id} to connection "${connection.slug}"`);
            sessionOperationContext.owner["persistSession"](managed);
            // Keep renderer session capabilities in sync when auto-locking the connection.
            sessionOperationContext.owner["sendEvent"]({
                type: 'connection_changed',
                sessionId: managed.id,
                connectionSlug: connection.slug,
                supportsBranching: resolveSupportsBranching(managed),
            }, managed.workspace.id);
        }
        const provider = backendContext.provider;
        if (connection) {
            sessionLog.info(`Using LLM connection "${connection.slug}" (${connection.providerType}) for session ${managed.id}`);
        }
        else {
            sessionLog.warn(`No LLM connection found for session ${managed.id}, using default anthropic provider`);
        }
        // Set session directory for tool metadata cross-process sharing.
        // The SDK subprocess reads CRAFT_SESSION_DIR to write tool-metadata.json;
        // the main process reads it via toolMetadataStore.setSessionDir().
        const sessionDirForMetadata = getSessionStoragePath(persistenceRootFor(managed), managed.id);
        process.env.CRAFT_SESSION_DIR = sessionDirForMetadata;
        toolMetadataStore.setSessionDir(sessionDirForMetadata);
        // Set up agentReady promise so title generation can await agent creation
        managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r; });
        // ============================================================
        // Common setup: sources, MCP pool, session config
        // ============================================================
        const sessionPath = getSessionStoragePath(persistenceRootFor(managed), managed.id);
        const enabledSlugs = managed.enabledSourceSlugs || [];
        assertSpecializedMissionSourceSelection(managed, enabledSlugs);
        const allSources = managed.missionCapabilityLock
            ? (managed.missionTurnSourceSnapshot ?? [])
            : loadAllSources(managed.workspace.rootPath);
        const enabledSources = allSources.filter(s => enabledSlugs.includes(s.config.slug) && isSourceUsable(s));
        // Build server configs for enabled sources
        const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, sessionOpGetCollectionSummarizer(sessionOperationContext, managed), managed.missionCapabilityLock ? () => sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed) : undefined, managed.missionCapabilityLock, ordinaryMissionSourceBuildOptions(managed));
        assertActivePreparation?.();
        // Create centralized MCP client pool (all backends use it)
        managed.mcpPool = new McpClientPool({ debug: (msg) => sessionLog.debug(msg), workspaceRootPath: managed.workspace.rootPath, sessionPath });
        managed.mcpPool.setCollectionCacheScope(() => sessionOpGetCollectionCacheScope(sessionOperationContext, managed));
        managed.mcpPool.setBeforeSourceToolExecution(({ sourceSlug }) => sessionOpAssertOrdinaryMissionSourceBindingAtTransport(sessionOperationContext, managed, sourceSlug));
        // Backends that run as external subprocesses need an HTTP pool server
        let poolServerUrl: string | undefined;
        if (backendContext.capabilities.needsHttpPoolServer) {
            const poolServer = new McpPoolServer(managed.mcpPool, { debug: (msg) => sessionLog.debug(msg) });
            managed.poolServer = poolServer;
            managed.mcpPool.onToolsChanged = () => poolServer.notifyToolsChanged();
            poolServerUrl = await poolServer.start();
            assertActivePreparation?.();
            await managed.mcpPool.sync(mcpServers); // Ensure pool has tools before SDK connects
            assertActivePreparation?.();
        }
        // Per-session env overrides
        const miniModel = connection ? (getMiniModel(connection) ?? connection.defaultModel) : undefined;
        const persistedGitBashPath = getGitBashPath();
        const envOverrides: Record<string, string> = {
            CRAFT_WORKSPACE_PATH: managed.workspace.rootPath,
            // Built-in tools such as WebFetch summarize task content with the
            // selected model. The mini model is reserved for title metadata.
            ANTHROPIC_DEFAULT_HAIKU_MODEL: backendContext.resolvedModel,
            // Pass persisted Git Bash path to SDK subprocess so bash tool
            // resolves custom gitBashPath from config.json (fixes #935)
            ...(persistedGitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: persistedGitBashPath } : {}),
        };
        managed.envOverrides = envOverrides;
        // ============================================================
        // Common session + callback config (identical for all backends)
        // ============================================================
        const sessionConfig = {
            id: managed.id,
            workspaceRootPath: managed.workspace.rootPath,
            sdkSessionId: managed.sdkSessionId,
            branchFromSdkSessionId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkSessionId : undefined,
            branchFromSessionPath: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSessionPath : undefined,
            branchFromSdkCwd: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkCwd : undefined,
            branchFromSdkTurnId: managed.branchContextStrategy === 'sdk-fork' ? managed.branchFromSdkTurnId : undefined,
            branchFromMessageId: managed.branchFromMessageId,
            createdAt: managed.lastMessageAt,
            lastUsedAt: managed.lastMessageAt,
            workingDirectory: managed.workingDirectory,
            sdkCwd: managed.sdkCwd,
            model: managed.model,
            llmConnection: managed.llmConnection,
            permissionMode: managed.permissionMode,
            previousPermissionMode: managed.previousPermissionMode,
            projectId: managed.projectId,
            executionIsolation: managed.executionIsolation,
        };
        let createdAgent: AgentInstance | undefined;
        const isCurrentRuntime = () => !!createdAgent && managed.agent === createdAgent;
        const { onSdkSessionIdUpdate, onSdkSessionIdCleared, onBranchForkInvalidated } = createRuntimeIdentityCallbacks(sessionOperationContext, managed, isCurrentRuntime);
        const { getRecoveryMessages, getBranchFallbackMessages, getBranchSeedMessages, markBranchSeedApplied, getTransferredSessionSummary, markTransferredSessionSummaryApplied } = createRuntimeContextCallbacks(sessionOperationContext, managed, isCurrentRuntime);
        // ============================================================
        // Construct backend via factory
        // ============================================================
        const enable1MContext = await sessionOperationContext.owner["loadAgentContextWindowPreference"]();
        assertActivePreparation?.();
        managed.agent = createBackendFromResolvedContext({
            context: backendContext,
            hostRuntime: buildBackendHostRuntimeContext(),
            coreConfig: {
                workspace: managed.workspace,
                isModelRoutePinned: () => managed.modelRoutePinned === true,
                externalActionPolicy,
                getHumanInputAllowed: () => !sessionOpIsManagedSessionYolo(sessionOperationContext, managed),
                getObjectiveMutationAuthority: currentUserRequest => (sessionOpResolveRuntimeObjectiveMutationAuthority(sessionOperationContext, managed, currentUserRequest)),
                beforeToolExecution: async (request) => {
                    if (!createdAgent)
                        throw new Error('Tool runtime was not fully initialized');
                    await sessionOpAdmitBackendToolExecution(sessionOperationContext, managed, createdAgent, request);
                },
                beforeProviderExecution: async () => {
                    await sessionOpAssertMissionProviderExecution(sessionOperationContext, managed);
                },
                missionCapabilityLock: managed.missionCapabilityLock,
                sealedSkillPackages: managed.missionSealedSkillPackages,
                ...(sealedRouteSnapshot ? {
                    sealedLlmConnection: sealedRouteSnapshot.connection,
                    ...(sealedRouteSnapshot.credentialBinding ? {
                        expectedLlmCredentialBindingId: sealedRouteSnapshot.credentialBinding.bindingId,
                    } : {}),
                } : {}),
                miniModel,
                thinkingLevel: managed.thinkingLevel,
                session: sessionConfig,
                onSdkSessionIdUpdate,
                onSdkSessionIdCleared,
                onBranchForkInvalidated,
                getRecoveryMessages,
                getBranchFallbackMessages,
                getBranchSeedMessages,
                markBranchSeedApplied,
                getTransferredSessionSummary,
                markTransferredSessionSummaryApplied,
                mcpPool: managed.mcpPool,
                poolServerUrl,
                envOverrides,
                // Claude-specific
                isHeadless: !AGENT_FLAGS.defaultModesEnabled,
                skipConfigWatcher: true, // Server owns workspace-level ConfigWatcher — don't duplicate in agents
                automationSystem: sessionOperationContext.state.automationSystems.get(managed.workspace.rootPath),
                systemPromptPreset: managed.systemPromptPreset,
                debugMode: _platform?.isDebugMode ? { enabled: true, logFilePath: _platform.getLogFilePath?.() } : undefined,
                enable1MContext,
                // Image resize callback — prevents oversized images from entering conversation history
                onImageResize: (filePath: string, maxSizeBytes: number): Promise<string | null> => {
                    if (sessionOperationContext.state.retiringSessions.has(managed) || sessionOperationContext.state.sessions.get(managed.id) !== managed) {
                        return Promise.resolve(null);
                    }
                    return sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
                        try {
                            const buffer = await readFile(filePath);
                            const result = await resizeImageForAPI(buffer, { maxSizeBytes });
                            if (!result)
                                return null;
                            // Write to session tmp directory (cleaned up with session)
                            const sessionTmpDir = join(sessionPath, 'tmp');
                            await mkdir(sessionTmpDir, { recursive: true });
                            const ext = result.format === 'jpeg' ? 'jpg' : 'png';
                            const outPath = join(sessionTmpDir, `resized-${randomUUID()}.${ext}`);
                            await writeFile(outPath, result.buffer);
                            sessionLog.info(`Image resized for Read: ${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(result.buffer.length / 1024 / 1024).toFixed(1)}MB (→ ${result.width}×${result.height})`);
                            return outPath;
                        }
                        catch (err) {
                            sessionLog.error('Image resize failed:', err);
                            return null;
                        }
                    });
                },
                // Source configs for postInit() — backends set up their own bridge/config
                initialSources: {
                    enabledSources,
                    mcpServers,
                    apiServers,
                    enabledSlugs,
                },
            },
        }) as AgentInstance;
        createdAgent = managed.agent;
        sessionLog.info(`Created ${provider} agent for session ${managed.id} (model: ${backendContext.resolvedModel})${managed.sdkSessionId ? ' (resuming)' : ''}`);
        // ============================================================
        // Post-construction: debug callback, auth callback, postInit()
        // ============================================================
        installRuntimeDebugCallbacks(sessionOperationContext, managed, isCurrentRuntime);
        // Run post-init (auth injection) — each backend handles its own
        if (sealedRouteSnapshot) {
            if (managed.missionRouteLockSha256) {
                await sessionOpResolveSpecializedMissionRouteSnapshot(sessionOperationContext, managed);
            }
            else {
                await sessionOpResolveOrdinaryMissionRouteSnapshot(sessionOperationContext, managed);
            }
        }
        const postInitResult = await managed.agent.postInit();
        assertActivePreparation?.();
        if (postInitResult.authWarning) {
            sessionLog.warn(`Auth warning for session ${managed.id}: ${postInitResult.authWarning}`);
            sessionOpReportBackendAuthUnavailable(sessionOperationContext, managed, postInitResult.authWarning, postInitResult.authWarningLevel || 'error');
        }
        // Wire up large response handling in the MCP pool (all backends)
        if (managed.mcpPool && managed.agent) {
            managed.mcpPool.setSummarizeCallback(prompt => managed.agent?.getSummarizeCallback()(prompt) ?? Promise.resolve(null));
        }
        // Wire up browser pane tools — merge BrowserPaneFns into session callbacks
        // so browser_* tools can delegate to BrowserPaneManager.
        //
        // Always register when EITHER a local BPM is set OR an RPC server is
        // available (which lets `getBrowserPaneManagerForSession` lazily build a
        // RemoteBrowserPaneManager). Calls fail per-method with
        // BROWSER_NO_CAPABLE_CLIENT if no desktop client is connected, instead
        // of "tool unavailable".
        installRuntimeBrowserCallbacks(sessionOperationContext, managed);
        // Signal that the agent instance is ready (unblocks title generation)
        managed.agentReadyResolve?.();
        // Set up permission handler to forward requests to renderer
        installRuntimePermissionCallbacks(sessionOperationContext, managed, createdAgent);
        // Wire up onPlanSubmitted to add plan message to conversation
        installRuntimePlanAuthCallbacks(sessionOperationContext, managed);
        // Wire up onSpawnSession to create independent sessions from agent tool calls
        managed.agent.onSpawnSession = input => sessionOpSpawnDelegatedSession(sessionOperationContext, managed, input);
        // Wire up session self-management tools (set_session_labels, set_session_status, etc.)
        installRuntimeSessionToolCallbacks(sessionOperationContext, managed, createdAgent);
        // WS2 keep-alive: forward background task events that arrive BETWEEN turns
        // (idle — no chat() generator consuming) into the normal event pipeline, so
        // the running-task registry + renderer chips reflect a completion even when
        // it lands while the session is idle. During a turn these events flow through
        // the chat() generator as usual; this only covers the idle gap. No-op unless
        // the backend supports a persistent cross-turn query (Claude keep-alive).
        installRuntimeSourceCallbacks(sessionOperationContext, managed, isCurrentRuntime, createdAgent);
        // NOTE: Source reloading is now handled by ConfigWatcher callbacks
        // which detect filesystem changes and update all affected sessions.
        // See setupConfigWatcher() for the full reload logic.
        // Apply session-scoped permission mode to the newly created agent
        // This ensures the UI toggle state is reflected in the agent before first message
        if (managed.permissionMode) {
            setPermissionMode(managed.id, managed.permissionMode, { changedBy: 'restore' });
            if (managed.previousPermissionMode) {
                hydratePreviousPermissionMode(managed.id, managed.previousPermissionMode);
            }
            managed.agent!.setPermissionMode(managed.permissionMode);
            const diagnostics = getPermissionModeDiagnostics(managed.id);
            sessionLog.info('Applied permission mode to agent', {
                sessionId: managed.id,
                permissionMode: managed.permissionMode,
                modeVersion: diagnostics.modeVersion,
                changedBy: diagnostics.lastChangedBy,
                changedAt: diagnostics.lastChangedAt,
            });
        }
        managed.backendRuntimeSignature = runtimeSignature;
        managed.backendRestartSignature = restartSignature;
        managed.runtimeLastActiveAt = Date.now();
        end();
    }
    return managed.agent;
}

export { sessionOpGetOrCreateAgent as getOrCreateAgent };
