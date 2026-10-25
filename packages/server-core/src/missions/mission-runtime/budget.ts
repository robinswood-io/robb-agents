import { type MissionSnapshot, type MissionWorkItem } from "@craft-agent/shared/missions";
import type { Session } from "@craft-agent/shared/protocol";
import { loadWorkspaceConfig } from "@craft-agent/shared/workspaces";
import { getSourcesBySlugs } from "@craft-agent/shared/sources";
import { specializedCapabilityIdentity } from "../../specialized-profiles/capability-identity.ts";
import { parseSpecializedMissionProfileReference } from "@craft-agent/shared/specialized-profiles";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import { missionProfileForItem, isActiveProviderMissionWork } from './shared.ts';
import type { MissionWorkspace, MissionPreflightConnection, OrdinaryMissionRouteEstimateCache } from './shared.ts';

export function missionEstimateEnvironmentIdentity(transportOwner: MissionRuntimeService, workspace: MissionWorkspace, snapshot: MissionSnapshot, config: ReturnType<typeof loadWorkspaceConfig>, connections: readonly MissionPreflightConnection[], origin: Session | undefined): string {
    const sourceSlugs = [...new Set([
            ...(config?.defaults?.enabledSourceSlugs ?? []),
            ...snapshot.spec.agentProfiles.flatMap(profile => profile.sources),
        ])].sort();
    const sources = sourceSlugs.length > 0
        ? getSourcesBySlugs(workspace.rootPath, sourceSlugs).map(source => ({
            slug: source.config.slug,
            enabled: source.config.enabled,
            routingSensitivity: source.config.routingSensitivity ?? null,
        }))
        : [];
    return specializedCapabilityIdentity({
        planVersion: snapshot.planVersion,
        config: {
            defaults: config?.defaults ?? null,
        },
        connections: connections.map(connection => ({
            slug: connection.slug,
            providerType: connection.providerType,
            type: connection.type ?? null,
            baseUrl: connection.baseUrl ?? null,
            authType: connection.authType ?? null,
            models: connection.models ?? [],
            defaultModel: connection.defaultModel ?? null,
            modelSelectionMode: connection.modelSelectionMode ?? null,
            piAuthProvider: connection.piAuthProvider ?? null,
            googleCloudProject: connection.googleCloudProject ?? null,
            customEndpoint: connection.customEndpoint ?? null,
        })),
        profiles: snapshot.spec.agentProfiles,
        origin: origin ? {
            llmConnection: origin.llmConnection,
            connectionRoutePinned: origin.connectionRoutePinned,
            model: origin.model,
            modelRoutePinned: origin.modelRoutePinned,
            thinkingLevel: origin.thinkingLevel,
            thinkingLevelPinned: origin.thinkingLevelPinned,
        } : null,
        sources,
    });
}

export async function projectedRemainingMissionCostUsd(transportOwner: MissionRuntimeService, input: {
    workspace: MissionWorkspace;
    snapshot: MissionSnapshot;
    config: ReturnType<typeof loadWorkspaceConfig>;
    connections: readonly MissionPreflightConnection[];
    origin: Session | undefined;
    measuredMissionUsd: number;
    environmentSha256: string;
    currentItem: MissionWorkItem;
}): Promise<number | undefined> {
    if (!transportOwner["options"].preflightCostEstimator)
        return undefined;
    const key = transportOwner["ordinaryRouteKey"](input.workspace.id, input.snapshot.spec.id);
    let cache = transportOwner["ordinaryRouteEstimates"].get(key);
    if (!cache
        || cache.planVersion !== input.snapshot.planVersion
        || cache.environmentSha256 !== input.environmentSha256) {
        cache = {
            planVersion: input.snapshot.planVersion,
            environmentSha256: input.environmentSha256,
            remainingEstimateUsd: 0,
            estimatesByWorkItemId: new Map(),
            unknownEstimateCount: 0,
        };
        transportOwner["ordinaryRouteEstimates"].set(key, cache);
        for (const runtime of Object.values(input.snapshot.workItems)) {
            if (!isActiveProviderMissionWork(runtime.status, runtime.definition))
                continue;
            await transportOwner["addOrdinaryMissionEstimate"](cache, {
                ...input,
                item: runtime.definition,
            });
        }
    }
    else {
        if (!cache.estimatesByWorkItemId.has(input.currentItem.id)) {
            await transportOwner["addOrdinaryMissionEstimate"](cache, { ...input, item: input.currentItem });
        }
    }
    return cache.unknownEstimateCount === 0
        ? Math.max(0, cache.remainingEstimateUsd)
        : undefined;
}

/** O(1) retirement after an actual provider attempt; retries are re-estimated on their next prepare. */
export function releaseOrdinaryMissionEstimate(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string, workItemId: string): void {
    const cache = transportOwner["ordinaryRouteEstimates"].get(transportOwner["ordinaryRouteKey"](workspaceId, missionId));
    if (!cache || !cache.estimatesByWorkItemId.has(workItemId))
        return;
    const estimate = cache.estimatesByWorkItemId.get(workItemId);
    if (estimate === null)
        cache.unknownEstimateCount = Math.max(0, cache.unknownEstimateCount - 1);
    else if (estimate !== undefined) {
        cache.remainingEstimateUsd = Math.max(0, cache.remainingEstimateUsd - estimate);
    }
    cache.estimatesByWorkItemId.delete(workItemId);
}

export async function addOrdinaryMissionEstimate(transportOwner: MissionRuntimeService, cache: OrdinaryMissionRouteEstimateCache, input: {
    workspace: MissionWorkspace;
    snapshot: MissionSnapshot;
    config: ReturnType<typeof loadWorkspaceConfig>;
    connections: readonly MissionPreflightConnection[];
    origin: Session | undefined;
    measuredMissionUsd: number;
    item: MissionWorkItem;
}): Promise<void> {
    if (cache.estimatesByWorkItemId.has(input.item.id))
        return;
    const profile = missionProfileForItem(input.snapshot.spec, input.item);
    if (parseSpecializedMissionProfileReference(profile.systemPrompt))
        return;
    const route = transportOwner["resolveOrdinaryRouteForItem"]({
        workspace: input.workspace,
        spec: input.snapshot.spec,
        item: input.item,
        profile,
        config: input.config,
        connections: input.connections,
        origin: input.origin,
        measuredMissionUsd: input.measuredMissionUsd,
    });
    if (!route.policyAllowed || !route.connectionSlug) {
        throw new Error(`Mission route estimate refused for "${input.item.id}": ${route.explanation}`);
    }
    const estimate = await transportOwner["options"].preflightCostEstimator!.estimateUsd({
        workspace: input.workspace,
        spec: input.snapshot.spec,
        item: input.item,
        connectionSlug: route.connectionSlug,
    });
    if (estimate === undefined) {
        cache.estimatesByWorkItemId.set(input.item.id, null);
        cache.unknownEstimateCount += 1;
        return;
    }
    if (!Number.isFinite(estimate) || estimate < 0) {
        throw new Error(`Invalid host cost estimate for work item "${input.item.id}"`);
    }
    cache.estimatesByWorkItemId.set(input.item.id, estimate);
    cache.remainingEstimateUsd += estimate;
}
