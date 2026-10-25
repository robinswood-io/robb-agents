import type { SessionOperationContext } from '../operation-context.ts';
import { authenticatedTaskFor } from '../policy.ts';
import { createHash } from 'node:crypto';
import { resolveBackendContext } from '@craft-agent/shared/agent/backend';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { ExternalActionPolicy } from '@craft-agent/shared/workspaces';
import { collectionSummaryCache } from '@craft-agent/shared/mcp';
import type { Message } from '@craft-agent/core/types';
import type { SummarizeCallback } from '@craft-agent/shared/sources';
import { buildBackendRuntimeSignature, buildRestartRequiredSignature } from '../../runtime-config';
import { extractAuthenticatedTaskText } from '@craft-agent/shared/config';
import type { ManagedSession } from '../managed-session.ts';
import { hasImmutableMissionRoute } from '../mission-route.ts';
import { sessionLog } from '../runtime-platform.ts';
import { getCollectionCacheScope as sessionOpGetCollectionCacheScope } from './evict-idle-session-runtimes.ts';
import { resolveSpecializedMissionRouteSnapshot as sessionOpResolveSpecializedMissionRouteSnapshot, resolveOrdinaryMissionRouteSnapshot as sessionOpResolveOrdinaryMissionRouteSnapshot } from './resolve-ordinary-mission-route-snapshot.ts';
import { trackManagerOperation as sessionOpTrackManagerOperation, trackSessionOperation as sessionOpTrackSessionOperation, assertSessionOperationOwner as sessionOpAssertSessionOperationOwner, ownsSessionOperation as sessionOpOwnsSessionOperation } from './track-session-operation.ts';
import { retireYoloHumanHandoffs as sessionOpRetireYoloHumanHandoffs } from './retire-yolo-human-handoffs.ts';
import { assertStrongCancellationAdmissionOpen as sessionOpAssertStrongCancellationAdmissionOpen } from './perform-cancel-processing-and-wait.ts';
import { recordAutonomyEvent as sessionOpRecordAutonomyEvent } from './persist-tool-result-after-permission-expiry.ts';

/** Deferred lookup works for API servers built before the backend is ready and after refresh. */
function sessionOpGetCollectionSummarizer(sessionOperationContext: SessionOperationContext, managed: ManagedSession): SummarizeCallback {
    const callback: SummarizeCallback = (prompt, request) => {
        const summarize = managed.agent?.getSummarizeCallback();
        if (!summarize)
            return Promise.resolve(null);
        const scope = sessionOpGetCollectionCacheScope(sessionOperationContext, managed);
        const effectiveScope = scope && request ? {
            ...scope,
            permissionRevision: createHash('sha256').update(JSON.stringify([scope.permissionRevision, request.requestIdentity])).digest('hex'),
            freshEvidence: scope.freshEvidence || !request.allowReuse,
        } : undefined;
        return collectionSummaryCache.summarize(effectiveScope, prompt, () => summarize(prompt));
    };
    callback.onSourceMutation = () => collectionSummaryCache.invalidateWorkspace(managed.workspace.rootPath);
    return callback;
}

/**
 * Refresh an existing agent's runtime config in place when the session's
 * resolved connection signature has drifted from what the agent was created
 * with. No-ops when the agent doesn't exist, when the signature still
 * matches, or when the agent is mid-stream (the gate is `agent.isProcessing()`
 * — `managed.isProcessing` is not used because `sendMessage` flips it before
 * calling `getOrCreateAgent`, which would make every send-path refresh dead
 * code).
 *
 * Concurrency: per-session serialization via `agentRefreshLocks`. A second
 * caller (e.g. `sendMessage` arriving mid-`SAVE`-refresh) awaits the
 * in-flight refresh, then re-evaluates from the post-refresh state — so the
 * subsequent `agent.chat()` is sent only after the subprocess has applied
 * the runtime update (or the agent has been disposed for recreation).
 *
 * The helper distinguishes two kinds of drift:
 *   - Restart-required (provider/auth/slug/piAuthProvider): goes straight
 *     to dispose + recreate because `update_runtime_config` cannot fully
 *     re-route credential/provider state in a live subprocess.
 *   - In-place safe (model/baseUrl/customEndpoint/customModels): attempts
 *     `agent.updateRuntimeConfig` and falls back to dispose if the backend
 *     can't apply the update.
 */
async function sessionOpTryRefreshAgentRuntime(sessionOperationContext: SessionOperationContext, managed: ManagedSession, reason: string, assertActivePreparation?: () => void): Promise<void> {
    // Serialize against any in-flight refresh on this session. The waiter
    // doesn't propagate the prior call's errors — those are logged at the
    // origin call site.
    const inflight = sessionOperationContext.state.agentRefreshLocks.get(managed.id);
    if (inflight) {
        await inflight.catch(() => undefined);
    }
    assertActivePreparation?.();
    // A specialized runtime is immutable. Revalidate its authenticated route,
    // but never reconcile it against a later mutable connection snapshot.
    if (managed.missionRouteLockSha256) {
        await sessionOpResolveSpecializedMissionRouteSnapshot(sessionOperationContext, managed);
        return;
    }
    if (managed.missionOrdinaryRouteLock) {
        await sessionOpResolveOrdinaryMissionRouteSnapshot(sessionOperationContext, managed);
        return;
    }
    if (!managed.agent)
        return;
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath);
    const backendContext = resolveBackendContext({
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
    if (!managed.backendRuntimeSignature || !managed.backendRestartSignature) {
        managed.backendRuntimeSignature = runtimeSignature;
        managed.backendRestartSignature = restartSignature;
        return;
    }
    const restartRequired = managed.backendRestartSignature !== restartSignature;
    const runtimeChanged = managed.backendRuntimeSignature !== runtimeSignature;
    if (!restartRequired && !runtimeChanged)
        return;
    if (managed.agent.isProcessing()) {
        sessionLog.info(`Runtime config changed for ${managed.id}; deferring refresh until session is idle (${reason})`);
        return;
    }
    const work = sessionOpRunAgentRuntimeRefresh(sessionOperationContext, managed, backendContext, runtimeSignature, restartSignature, restartRequired, reason, assertActivePreparation);
    // Track the work so concurrent callers serialize. Swallow errors on the
    // tracked promise — the awaiter shouldn't get someone else's exception;
    // errors are logged inside `runAgentRuntimeRefresh`.
    const tracked = work.then(() => undefined, () => undefined);
    sessionOperationContext.state.agentRefreshLocks.set(managed.id, tracked);
    try {
        await work;
    }
    finally {
        // Concurrent callers awaited `tracked` before reaching this point and
        // each registered their own work serially, so the slot is always ours
        // to clear when our own work resolves.
        if (sessionOperationContext.state.agentRefreshLocks.get(managed.id) === tracked) {
            sessionOperationContext.state.agentRefreshLocks.delete(managed.id);
        }
    }
}

async function sessionOpRunAgentRuntimeRefresh(sessionOperationContext: SessionOperationContext, managed: ManagedSession, backendContext: ReturnType<typeof resolveBackendContext>, runtimeSignature: string, restartSignature: string, restartRequired: boolean, reason: string, assertActivePreparation?: () => void): Promise<void> {
    if (restartRequired) {
        sessionLog.info(`Restart-required field changed for session ${managed.id}; recreating backend runtime (${reason})`);
        await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'restart-required runtime change');
        return;
    }
    const connection = backendContext.connection;
    let refreshed = false;
    if (managed.agent?.updateRuntimeConfig) {
        try {
            refreshed = await managed.agent.updateRuntimeConfig({
                model: backendContext.resolvedModel,
                providerType: connection?.providerType,
                authType: backendContext.authType,
                runtime: connection ? {
                    baseUrl: connection.baseUrl,
                    piAuthProvider: connection.piAuthProvider,
                    customEndpoint: connection.customEndpoint,
                    customModels: connection.models?.map(model => {
                        if (typeof model === 'string')
                            return model;
                        const supportsImages = typeof model.supportsImages === 'boolean' ? model.supportsImages : undefined;
                        const supportsThinking = typeof model.supportsThinking === 'boolean' ? model.supportsThinking : undefined;
                        const maxTokens = typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : undefined;
                        if (model.contextWindow || supportsImages !== undefined || supportsThinking !== undefined || maxTokens !== undefined) {
                            return {
                                id: model.id,
                                ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
                                ...(supportsImages !== undefined ? { supportsImages } : {}),
                                ...(supportsThinking !== undefined ? { supportsThinking } : {}),
                                ...(maxTokens !== undefined ? { maxTokens } : {}),
                            };
                        }
                        return model.id;
                    }),
                } : undefined,
            });
        }
        catch (error) {
            sessionLog.warn(`Runtime config in-place refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`);
        }
    }
    assertActivePreparation?.();
    if (refreshed) {
        managed.backendRuntimeSignature = runtimeSignature;
        managed.backendRestartSignature = restartSignature;
        sessionLog.info(`Refreshed runtime config for session ${managed.id} (${reason})`);
    }
    else {
        sessionLog.info(`Recreating backend runtime for session ${managed.id} after config change (${reason})`);
        await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'runtime config refresh');
    }
}

/**
 * Push a connection's runtime updates (e.g. `supportsImages` toggle) to every
 * active session that uses it. Called from the `llmConnections.SAVE` handler
 * so capability changes reach live Pi subprocesses immediately instead of
 * waiting for the next send to lazily notice the signature drift.
 */
async function sessionOpRefreshConnectionRuntime(sessionOperationContext: SessionOperationContext, connectionSlug: string): Promise<void> {
    return sessionOpTrackManagerOperation(sessionOperationContext, () => sessionOpPerformRefreshConnectionRuntime(sessionOperationContext, connectionSlug));
}

async function sessionOpPerformRefreshConnectionRuntime(sessionOperationContext: SessionOperationContext, connectionSlug: string): Promise<void> {
    for (const managed of sessionOperationContext.state.sessions.values()) {
        if (managed.llmConnection !== connectionSlug)
            continue;
        // The new connection definition no longer has the identity certified for
        // this session. Keep an in-flight runtime on its old immutable config;
        // the exact hash check at the next admission fails closed.
        if (hasImmutableMissionRoute(managed))
            continue;
        try {
            await sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
                await sessionOperationContext.owner["tryRefreshAgentRuntime"](managed, 'connection update', () => sessionOpAssertSessionOperationOwner(sessionOperationContext, managed));
                sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
            });
        }
        catch (error) {
            sessionLog.warn(`refreshConnectionRuntime failed for ${managed.id}: ${error instanceof Error ? error.message : error}`);
        }
    }
}

function sessionOpApplyExternalActionPolicyToRuntime(_sessionOperationContext: SessionOperationContext, managed: ManagedSession, policy: ExternalActionPolicy, reason: string): boolean {
    const agent = managed.agent;
    if (!agent) {
        managed.pendingExternalActionPolicy = undefined;
        return true;
    }
    if (agent.isProcessing()) {
        managed.pendingExternalActionPolicy = policy;
        sessionLog.info(`External action policy changed for ${managed.id}; deferring until next turn (${reason})`);
        return false;
    }
    agent.setExternalActionPolicy(policy);
    managed.pendingExternalActionPolicy = undefined;
    sessionLog.info(`Applied external action policy to live session ${managed.id} (${reason})`);
    return true;
}

/**
 * Push a workspace policy change to live idle agents without interrupting a
 * provider stream. Busy agents retain only the latest value and apply it on
 * the next send path before chat() starts.
 */
async function sessionOpRefreshWorkspaceExternalActionPolicy(sessionOperationContext: SessionOperationContext, workspaceId: string, policy: ExternalActionPolicy): Promise<void> {
    return sessionOpTrackManagerOperation(sessionOperationContext, () => sessionOpPerformRefreshWorkspaceExternalActionPolicy(sessionOperationContext, workspaceId, policy));
}

async function sessionOpPerformRefreshWorkspaceExternalActionPolicy(sessionOperationContext: SessionOperationContext, workspaceId: string, policy: ExternalActionPolicy): Promise<void> {
    for (const managed of sessionOperationContext.state.sessions.values()) {
        if (managed.workspace.id !== workspaceId)
            continue;
        try {
            await sessionOpTrackSessionOperation(sessionOperationContext, managed, async () => {
                sessionOperationContext.owner["applyExternalActionPolicyToRuntime"](managed, policy, 'workspace setting update');
                if (policy === 'allow-in-execute')
                    await sessionOpRetireYoloHumanHandoffs(sessionOperationContext, managed);
            });
        }
        catch (error) {
            sessionLog.warn(`External action policy refresh failed for ${managed.id}: ${error instanceof Error ? error.message : error}`);
            if (sessionOpOwnsSessionOperation(sessionOperationContext, managed))
                managed.pendingExternalActionPolicy = policy;
        }
    }
}

async function sessionOpRestartAgentRuntime(sessionOperationContext: SessionOperationContext, sessionId: string): Promise<void> {
    const managed = sessionOperationContext.state.sessions.get(sessionId);
    if (!managed) {
        throw new Error(`Session ${sessionId} not found`);
    }
    return sessionOpTrackSessionOperation(sessionOperationContext, managed, () => sessionOpPerformRestartAgentRuntime(sessionOperationContext, managed));
}

async function sessionOpPerformRestartAgentRuntime(sessionOperationContext: SessionOperationContext, managed: ManagedSession): Promise<void> {
    sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
    const inflight = sessionOperationContext.state.agentRefreshLocks.get(managed.id);
    if (inflight) {
        await inflight.catch(() => undefined);
    }
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    sessionOpAssertStrongCancellationAdmissionOpen(sessionOperationContext, managed);
    if (managed.isProcessing || managed.agent?.isProcessing()) {
        throw new Error('Cannot reconnect runtime while session is processing');
    }
    const work = sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'manual runtime reconnect');
    const tracked = work.then(() => undefined, () => undefined);
    sessionOperationContext.state.agentRefreshLocks.set(managed.id, tracked);
    try {
        await work;
    }
    finally {
        if (sessionOperationContext.state.agentRefreshLocks.get(managed.id) === tracked) {
            sessionOperationContext.state.agentRefreshLocks.delete(managed.id);
        }
    }
    sessionOpAssertSessionOperationOwner(sessionOperationContext, managed);
    sessionOpRecordAutonomyEvent(sessionOperationContext, managed, {
        phase: 'fallback',
        message: 'Execution runtime bridge was reconnected; retry the failed turn to recreate the runtime.',
        evidence: 'Session runtime disposed by restartRuntime command.',
    });
}

/** Semantic objective for a host-authenticated orchestration message. */
function sessionOpObjectiveContractTextFor(_sessionOperationContext: SessionOperationContext, managed: ManagedSession, message: Message): string {
    const authenticated = authenticatedTaskFor(managed, message);
    return authenticated.authenticatedTaskText
        ?? extractAuthenticatedTaskText(message.content, authenticated.authenticatedEnvelope);
}

async function sessionOpLoadAgentContextWindowPreference(_sessionOperationContext: SessionOperationContext): Promise<boolean> {
    const { getEnable1MContext } = await import('@craft-agent/shared/config/storage');
    return getEnable1MContext();
}

export { sessionOpGetCollectionSummarizer as getCollectionSummarizer };
export { sessionOpTryRefreshAgentRuntime as tryRefreshAgentRuntime };
export { sessionOpRunAgentRuntimeRefresh as runAgentRuntimeRefresh };
export { sessionOpRefreshConnectionRuntime as refreshConnectionRuntime };
export { sessionOpPerformRefreshConnectionRuntime as performRefreshConnectionRuntime };
export { sessionOpApplyExternalActionPolicyToRuntime as applyExternalActionPolicyToRuntime };
export { sessionOpRefreshWorkspaceExternalActionPolicy as refreshWorkspaceExternalActionPolicy };
export { sessionOpPerformRefreshWorkspaceExternalActionPolicy as performRefreshWorkspaceExternalActionPolicy };
export { sessionOpRestartAgentRuntime as restartAgentRuntime };
export { sessionOpPerformRestartAgentRuntime as performRestartAgentRuntime };
export { sessionOpObjectiveContractTextFor as objectiveContractTextFor };
export { sessionOpLoadAgentContextWindowPreference as loadAgentContextWindowPreference };
