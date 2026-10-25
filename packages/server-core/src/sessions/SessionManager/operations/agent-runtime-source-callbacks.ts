import type { SessionOperationContext } from '../operation-context.ts';
import { persistenceRootFor, assertSpecializedMissionSourceSelection, ordinaryMissionSourceBuildOptions } from '../policy.ts';
import type { AgentEvent } from '@craft-agent/shared/agent';
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions';
import { getSourcesBySlugs, isSourceUsable } from '@craft-agent/shared/sources';
import type { ManagedSession } from '../managed-session.ts';
import { sessionLog } from '../runtime-platform.ts';
import { withRuntimeDisposeTimeout } from '../runtime-policy.ts';
import { commitRevocableSourceActivationRuntime, sourceActivationObjectiveBinding } from '../source-activation.ts';
import { buildServersFromSources } from '../source-build.ts';
import { getCollectionSummarizer as sessionOpGetCollectionSummarizer } from './try-refresh-agent-runtime.ts';
import { processEvent as sessionOpProcessEvent } from './process-event.ts';
import { serializeSourceActivation as sessionOpSerializeSourceActivation } from './message-authority.ts';

export function installRuntimeSourceCallbacks(sessionOperationContext: SessionOperationContext, managed: ManagedSession, isCurrentRuntime: () => boolean, createdAgent: NonNullable<ManagedSession['agent']>) {
    // WS2 keep-alive: forward background task events that arrive BETWEEN turns
    // (idle — no chat() generator consuming) into the normal event pipeline, so
    // the running-task registry + renderer chips reflect a completion even when
    // it lands while the session is idle. During a turn these events flow through
    // the chat() generator as usual; this only covers the idle gap. No-op unless
    // the backend supports a persistent cross-turn query (Claude keep-alive).
    managed.agent!.setBackgroundEventSink?.((event: AgentEvent) => {
        if (!isCurrentRuntime())
            return;
        void sessionOpProcessEvent(sessionOperationContext, managed, event);
    });
    // Wire up onSourceActivationRequest to auto-enable sources when agent tries to use them
    managed.agent!.onSourceActivationRequest = (sourceSlug: string): Promise<boolean> => sessionOpSerializeSourceActivation(sessionOperationContext, managed, async () => {
        sessionLog.info(`Source activation request for session ${managed.id}:`, sourceSlug);
        if (managed.missionOrdinaryRouteLock
            && !managed.missionOrdinaryRouteLock.effectiveSourceSlugs.includes(sourceSlug)) {
            sessionLog.warn('Rejected source activation outside ordinary Mission route lock', {
                sessionId: managed.id,
                sourceSlug,
            });
            return false;
        }
        try {
            assertSpecializedMissionSourceSelection(managed, [sourceSlug]);
            if (managed.missionCapabilityLock)
                await sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed);
        }
        catch (error) {
            sessionLog.warn(`Rejected specialized Mission source activation for ${sourceSlug}:`, error);
            return false;
        }
        const activationAgent = createdAgent!;
        const activationGeneration = managed.processingGeneration;
        const activationCancellationEpoch = sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0;
        const activationAuthorityEpoch = sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0;
        const activationBinding = sourceActivationObjectiveBinding(managed.activeObjective);
        const activationCurrent = () => {
            const currentBinding = sourceActivationObjectiveBinding(managed.activeObjective);
            return !sessionOperationContext.state.shuttingDown && sessionOperationContext.state.sessions.get(managed.id) === managed
                && managed.agent! === activationAgent && managed.processingGeneration === activationGeneration
                && (sessionOperationContext.state.turnCancellationEpochs.get(managed) ?? 0) === activationCancellationEpoch
                && (sessionOperationContext.state.objectiveAuthorityEpochs.get(managed) ?? 0) === activationAuthorityEpoch
                && !!activationBinding && !!currentBinding
                && activationBinding.objectiveId === currentBinding.objectiveId
                && activationBinding.objectiveRevision === currentBinding.objectiveRevision;
        };
        if (!activationCurrent())
            return false;
        const workspaceRootPath = managed.workspace.rootPath;
        // Check if source is already enabled
        if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
            sessionLog.info(`Source ${sourceSlug} already in enabledSourceSlugs, checking server status`);
            // Source is in the list but server might not be active (e.g., build failed previously)
        }
        // Load the source to check if it exists and is ready
        const sources = getSourcesBySlugs(workspaceRootPath, [sourceSlug]);
        if (sources.length === 0) {
            sessionLog.warn(`Source ${sourceSlug} not found in workspace`);
            return false;
        }
        const source = sources[0];
        // Check if source is usable (enabled and authenticated if auth is required)
        if (!isSourceUsable(source)) {
            sessionLog.warn(`Source ${sourceSlug} is not usable (disabled or requires authentication)`);
            return false;
        }
        // Build against a local candidate. Do not mutate the durable session or
        // live bridge before the asynchronous build has proved that the exact
        // runtime/generation/objective which requested it is still current.
        const originalSlugs = [...(managed.enabledSourceSlugs || [])];
        const originalRuntime = activationAgent.getSourceServerSnapshot?.();
        const slugSet = new Set(originalSlugs);
        const wasAlreadyEnabled = slugSet.has(sourceSlug);
        if (!wasAlreadyEnabled)
            slugSet.add(sourceSlug);
        const candidateSlugs = Array.from(slugSet);
        // Build server configs for all enabled sources
        const allEnabledSources = getSourcesBySlugs(workspaceRootPath, candidateSlugs);
        // Pass session path so large API responses can be saved to session folder
        const sessionPath = getSessionStoragePath(persistenceRootFor(managed), managed.id);
        const { mcpServers, apiServers, errors } = await buildServersFromSources(allEnabledSources, sessionPath, managed.tokenRefreshManager, sessionOpGetCollectionSummarizer(sessionOperationContext, managed), managed.missionCapabilityLock ? () => sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed) : undefined, managed.missionCapabilityLock, ordinaryMissionSourceBuildOptions(managed));
        if (!activationCurrent())
            return false;
        // Most live runtimes expose their exact last committed server objects.
        // Keep a reconstruction fallback for legacy/test backends so rollback
        // never broadens to the newly requested source.
        const originalEnabledSources = getSourcesBySlugs(workspaceRootPath, originalSlugs)
            .filter(isSourceUsable);
        const fallbackRuntime = originalRuntime ? undefined : await buildServersFromSources(originalEnabledSources, sessionPath, managed.tokenRefreshManager, sessionOpGetCollectionSummarizer(sessionOperationContext, managed), managed.missionCapabilityLock ? () => sessionOperationContext.owner["assertSpecializedMissionCapabilities"](managed) : undefined, managed.missionCapabilityLock, ordinaryMissionSourceBuildOptions(managed));
        if (!activationCurrent())
            return false;
        const rollbackMcpServers = originalRuntime?.mcpServers ?? fallbackRuntime!.mcpServers;
        const rollbackApiServers = originalRuntime?.apiServers ?? fallbackRuntime!.apiServers;
        const rollbackIntendedSlugs = originalRuntime?.intendedSlugs
            ?? originalEnabledSources.map(item => item.config.slug);
        if (errors.length > 0) {
            sessionLog.warn(`Source build errors during auto-enable:`, errors);
        }
        // Check if our target source was built successfully
        const sourceBuilt = sourceSlug in mcpServers || sourceSlug in apiServers;
        if (!sourceBuilt) {
            sessionLog.warn(`Source ${sourceSlug} failed to build`);
            return false;
        }
        // Apply source servers to the agent
        const intendedSlugs = allEnabledSources
            .filter(isSourceUsable)
            .map(s => s.config.slug);
        const rollbackRuntime = async (stage: string): Promise<void> => {
            sessionLog.info('Rolling back superseded source activation runtime', {
                sessionId: managed.id,
                sourceSlug,
                stage,
            });
            const rollbackErrors: unknown[] = [];
            try {
            }
            catch (error) {
                rollbackErrors.push(error);
                sessionLog.warn('Failed to restore bridge state after superseded source activation', {
                    sessionId: managed.id,
                    sourceSlug,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            try {
                await activationAgent.setSourceServers(rollbackMcpServers, rollbackApiServers, rollbackIntendedSlugs);
            }
            catch (error) {
                rollbackErrors.push(error);
                sessionLog.warn('Failed to restore source servers after superseded source activation', {
                    sessionId: managed.id,
                    sourceSlug,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            if (rollbackErrors.length > 0) {
                throw new AggregateError(rollbackErrors, 'Source activation runtime rollback failed');
            }
        };
        const quarantineActivationRuntime = async (): Promise<void> => {
            sessionLog.warn('Quarantining runtime after source activation rollback failure', {
                sessionId: managed.id,
                sourceSlug,
            });
            if (managed.agent! === activationAgent) {
                await sessionOperationContext.owner["disposeManagedAgentRuntime"](managed, 'source activation rollback failure');
                return;
            }
            try {
                if (activationAgent.disposeForRestart) {
                    await withRuntimeDisposeTimeout(activationAgent.disposeForRestart(), `Stale source activation runtime disposal for ${managed.id}`);
                }
                else {
                    activationAgent.dispose();
                }
            }
            catch (error) {
                sessionLog.warn('Failed to dispose stale source activation runtime', {
                    sessionId: managed.id,
                    sourceSlug,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        };
        // These provider operations can mutate before their promises settle;
        // therefore every stale or failed commit restores the exact preceding
        // runtime snapshot before another activation transaction can start.
        const runtimeCommit = await commitRevocableSourceActivationRuntime({
            isCurrent: activationCurrent,
            applyServers: async () => {
                await activationAgent.setSourceServers(mcpServers, apiServers, intendedSlugs);
            },
            restorePrevious: rollbackRuntime,
            quarantine: quarantineActivationRuntime,
        });
        if (runtimeCommit !== 'committed') {
            sessionLog.warn('Source runtime activation did not commit', {
                sessionId: managed.id,
                sourceSlug,
                result: runtimeCommit,
            });
            return false;
        }
        const originalInheritsWorkspaceSourceSlugs = managed.inheritsWorkspaceSourceSlugs;
        if (!wasAlreadyEnabled) {
            managed.enabledSourceSlugs = candidateSlugs;
            managed.inheritsWorkspaceSourceSlugs = false;
            sessionLog.info(`Added source ${sourceSlug} to session enabled sources`);
        }
        sessionLog.info(`Auto-enabled source ${sourceSlug} for session ${managed.id}`);
        // Persist session with updated enabled sources
        sessionOperationContext.owner["persistSession"](managed);
        await sessionOperationContext.owner.flushSession(managed.id);
        if (!activationCurrent()) {
            managed.enabledSourceSlugs = originalSlugs;
            managed.inheritsWorkspaceSourceSlugs = originalInheritsWorkspaceSourceSlugs;
            await rollbackRuntime('persistence-superseded');
            sessionOperationContext.owner["persistSession"](managed);
            try {
                await sessionOperationContext.owner.flushSession(managed.id);
            }
            catch (error) {
                sessionLog.warn('Failed to flush source metadata rollback after supersession', {
                    sessionId: managed.id,
                    sourceSlug,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return false;
        }
        // Notify renderer of source change
        sessionOperationContext.owner["sendEvent"]({
            type: 'sources_changed',
            sessionId: managed.id,
            enabledSourceSlugs: managed.enabledSourceSlugs || [],
        }, managed.workspace.id);
        return true;
    });
}


