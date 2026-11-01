import type { SessionOperationContext } from '../operation-context.ts';
import { loadCollectionCacheSources } from '../../collection-cache-sources';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { createHash } from 'node:crypto';
import { resolveBackendContext } from '@craft-agent/shared/agent/backend';
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { CollectionCacheScope } from '@craft-agent/shared/mcp';
import { getAppPermissionsDir, getWorkspacePermissionsPath, getSourcePermissionsPath } from '@craft-agent/shared/agent/permissions-config';
import { getMiniModel } from '@craft-agent/shared/config';
import { getDelegatedReviewRequest } from '../../delegated-review-outcome';
import { isExplicitReadOnlyReview } from '../../objective-contract';
import type { ManagedSession } from '../managed-session.ts';
import { isTerminalReviewSession } from '../review-lifecycle.ts';
import { sessionLog } from '../runtime-platform.ts';
import { MIN_SESSION_RUNTIME_IDLE_TIMEOUT_MS, SESSION_RUNTIME_EVICTION_CONCURRENCY, SESSION_RUNTIME_SWEEP_INTERVAL_MS } from '../runtime-policy.ts';

function sessionOpFinishManagedAgentRuntimeDisposal(sessionOperationContext: SessionOperationContext, sessionId: string, operation: Promise<void>): void {
    const operations = sessionOperationContext.state.runtimeDisposalsInFlight.get(sessionId);
    operations?.delete(operation);
    if (operations?.size === 0)
        sessionOperationContext.state.runtimeDisposalsInFlight.delete(sessionId);
}

function sessionOpHasRunningBackgroundTasks(_sessionOperationContext: SessionOperationContext, managed: ManagedSession): boolean {
    for (const task of managed.backgroundTaskRegistry.values()) {
        if (task.status === 'running')
            return true;
    }
    return false;
}

/**
 * Release runtimes for sessions that have been idle long enough. Transcript
 * state and provider session IDs remain persisted, so the next message lazily
 * recreates a clean runtime and resumes the conversation.
 */
async function sessionOpEvictIdleSessionRuntimes(sessionOperationContext: SessionOperationContext, now = Date.now()): Promise<number> {
    if (sessionOperationContext.state.runtimeIdleTimeoutMs === 0 || sessionOperationContext.state.runtimeEvictionSweepInFlight)
        return 0;
    sessionOperationContext.state.runtimeEvictionSweepInFlight = true;
    let evicted = 0;
    try {
        const candidates = Array.from(sessionOperationContext.state.sessions.values()).filter(managed => {
            const hasRuntime = !!managed.agent || !!managed.poolServer || !!managed.mcpPool;
            if (!hasRuntime
                || managed.isProcessing
                || managed.messageQueue.length > 0
                || sessionOpHasRunningBackgroundTasks(sessionOperationContext, managed)
                || sessionOperationContext.state.agentRefreshLocks.has(managed.id)) {
                return false;
            }
            const lastActiveAt = managed.runtimeLastActiveAt ?? managed.lastMessageAt;
            return now - lastActiveAt >= sessionOperationContext.state.runtimeIdleTimeoutMs;
        });
        // Bound teardown concurrency: serial cleanup is too slow when a leaked
        // historical process has many runtimes, while unbounded Promise.all can
        // overwhelm the machine with simultaneous subprocess shutdowns.
        for (let offset = 0; offset < candidates.length; offset += SESSION_RUNTIME_EVICTION_CONCURRENCY) {
            const batch = candidates.slice(offset, offset + SESSION_RUNTIME_EVICTION_CONCURRENCY);
            const results = await Promise.all(batch.map(async (managed) => {
                // Re-check immediately before detaching. A queued or active message
                // may have arrived while an earlier batch was being disposed.
                const hasRuntime = !!managed.agent || !!managed.poolServer || !!managed.mcpPool;
                const lastActiveAt = managed.runtimeLastActiveAt ?? managed.lastMessageAt;
                if (!hasRuntime
                    || managed.isProcessing
                    || managed.messageQueue.length > 0
                    || sessionOpHasRunningBackgroundTasks(sessionOperationContext, managed)
                    || sessionOperationContext.state.agentRefreshLocks.has(managed.id)
                    || now - lastActiveAt < sessionOperationContext.state.runtimeIdleTimeoutMs) {
                    return false;
                }
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'idle runtime eviction');
                sessionLog.info('Evicted idle session runtime', {
                    sessionId: managed.id,
                    idleMs: now - lastActiveAt,
                });
                return true;
            }));
            evicted += results.filter(Boolean).length;
        }
    }
    finally {
        sessionOperationContext.state.runtimeEvictionSweepInFlight = false;
    }
    return evicted;
}

function sessionOpStartRuntimeEvictionSweep(sessionOperationContext: SessionOperationContext): void {
    if (sessionOperationContext.state.runtimeIdleTimeoutMs === 0 || sessionOperationContext.state.runtimeEvictionTimer)
        return;
    const intervalMs = Math.min(SESSION_RUNTIME_SWEEP_INTERVAL_MS, Math.max(MIN_SESSION_RUNTIME_IDLE_TIMEOUT_MS, Math.floor(sessionOperationContext.state.runtimeIdleTimeoutMs / 3)));
    sessionOperationContext.state.runtimeEvictionTimer = setInterval(() => {
        void sessionOpEvictIdleSessionRuntimes(sessionOperationContext).catch((error: unknown) => {
            sessionLog.warn('Idle runtime eviction sweep failed', {
                error: error instanceof Error ? error.message : String(error),
            });
        });
    }, intervalMs);
    sessionOperationContext.state.runtimeEvictionTimer.unref?.();
    sessionLog.info('Session runtime eviction enabled', {
        idleTimeoutMs: sessionOperationContext.state.runtimeIdleTimeoutMs,
        intervalMs,
    });
}

/** Reuse is confined to one objective family and the current authority/model boundary. */
function sessionOpGetCollectionCacheScope(sessionOperationContext: SessionOperationContext, managed: ManagedSession): CollectionCacheScope | undefined {
    try {
        let root = managed;
        const visited = new Set<string>();
        while (root.parentSessionId) {
            if (visited.has(root.id))
                return undefined;
            visited.add(root.id);
            const parent = sessionOperationContext.state.sessions.get(root.parentSessionId);
            if (!parent || parent.workspace.id !== managed.workspace.id || parent.workspace.rootPath !== managed.workspace.rootPath)
                return undefined;
            root = parent;
        }
        const objectiveId = root.activeObjective?.objectiveId ?? root.activeObjective?.userMessageId;
        if (!objectiveId)
            return undefined;
        const workspace = managed.workspace.rootPath;
        const config = loadWorkspaceConfig(workspace);
        const backend = resolveBackendContext({ ...(managed.llmConnection !== undefined ? { sessionConnectionSlug: managed.llmConnection } : {}), ...(config?.defaults?.defaultLlmConnection !== undefined ? { workspaceDefaultConnectionSlug: config?.defaults?.defaultLlmConnection } : {}), ...(managed.model !== undefined ? { managedModel: managed.model } : {}) });
        if (!backend.connection)
            return undefined;
        const sources = loadCollectionCacheSources(workspace, managed.enabledSourceSlugs);
        if (!sources)
            return undefined;
        const permissionFiles = [join(getAppPermissionsDir(), 'default.json'), getWorkspacePermissionsPath(workspace), ...sources.map(source => getSourcePermissionsPath(workspace, source.config.slug))];
        const permissionRevision = createHash('sha256').update(JSON.stringify([
            managed.permissionMode ?? 'safe', config, managed.executionIsolation, managed.externalActionAuthorizations,
            sources.map(source => source.config), permissionFiles.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null),
        ])).digest('hex');
        const routeRevision = createHash('sha256').update(JSON.stringify([
            backend.connection, getMiniModel(backend.connection) ?? backend.connection.defaultModel,
            backend.resolvedModel, managed.thinkingLevel,
        ])).digest('hex');
        return {
            workspace,
            audience: JSON.stringify([root.id, objectiveId, managed.projectId ?? root.projectId ?? null]),
            permissionRevision, routeRevision,
            freshEvidence: isTerminalReviewSession(managed)
                || managed.activeObjective?.delegatedRole === 'reviewer'
                || managed.activeObjective?.risk === 'high-stakes' || root.activeObjective?.risk === 'high-stakes'
                || managed.activeObjective?.completionCriteria.includes('independent-review-passed')
                || isExplicitReadOnlyReview(managed.activeObjective?.originalText ?? '')
                || Boolean(getDelegatedReviewRequest(managed.activeObjective?.originalText ?? '', managed.enabledSourceSlugs)),
        };
    }
    catch {
        return undefined;
    } // Incomplete policy/config state disables reuse; never blocks the live source.
}

export { sessionOpFinishManagedAgentRuntimeDisposal as finishManagedAgentRuntimeDisposal };
export { sessionOpHasRunningBackgroundTasks as hasRunningBackgroundTasks };
export { sessionOpEvictIdleSessionRuntimes as evictIdleSessionRuntimes };
export { sessionOpStartRuntimeEvictionSweep as startRuntimeEvictionSweep };
export { sessionOpGetCollectionCacheScope as getCollectionCacheScope };
