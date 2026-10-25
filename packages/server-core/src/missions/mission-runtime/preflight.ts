import { getLlmConnections, getDefaultLlmConnection, getDefaultThinkingLevel } from "@craft-agent/shared/config";
import { MissionSpecSchema, loadMissionSnapshot, simulateMissionDigitalTwin, type MissionConnectorPreflight, type MissionDigitalTwinReport } from "@craft-agent/shared/missions";
import { loadWorkspaceConfig } from "@craft-agent/shared/workspaces";
import { getSourcesBySlugs } from "@craft-agent/shared/sources";
import { resolveExplicitMissionModel, type MissionRouteConnection } from "../mission-model-decision.ts";
import { maxSourceSensitivity } from "@craft-agent/shared/config";
import type { MissionSelectionContext } from "../mission-model-decision.ts";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import { normalizedError, maxMissionDifficulty, measuredMissionCostUsd, remainingMissionBudgetUsd, unavailableConnectorReadiness } from './shared.ts';
import type { MissionPreflightTarget } from './shared.ts';

export async function preflightMission(transportOwner: MissionRuntimeService, workspaceId: string, target: MissionPreflightTarget): Promise<MissionDigitalTwinReport> {
    return transportOwner["preflightMissionInternal"](workspaceId, target, false);
}

export async function preflightMissionInternal(transportOwner: MissionRuntimeService, workspaceId: string, target: MissionPreflightTarget,
/** The spec already passed the host-owned specialized binder. */
trustedBoundSpec: boolean): Promise<MissionDigitalTwinReport> {
    const workspace = transportOwner["resolveWorkspace"](workspaceId);
    if (!workspace)
        throw new Error(`Workspace ${workspaceId} not found`);
    const persistedSnapshot = 'missionId' in target && target.missionId
        ? loadMissionSnapshot(workspace.rootPath, target.missionId)
        : null;
    if ('missionId' in target && target.missionId && !persistedSnapshot) {
        throw new Error(`Unknown mission "${target.missionId}"`);
    }
    const snapshot = persistedSnapshot;
    const parsedSpec = MissionSpecSchema.parse(persistedSnapshot?.spec ?? target.spec);
    const specializedProfiles = transportOwner["createSpecializedProfileResolver"](workspace);
    const spec = persistedSnapshot || trustedBoundSpec
        ? await specializedProfiles.revalidateMissionSpec(parsedSpec)
        : await specializedProfiles.bindMissionSpec(parsedSpec);
    // Preflight is the diagnostic form of admission. Runtime creation remains
    // guarded by assertAdmissible(), while the dry-run records path, autonomy,
    // sandbox, connector, and budget refusals as gates so callers receive the
    // complete host verdict instead of the first thrown policy error.
    const config = loadWorkspaceConfig(workspace.rootPath);
    if (!config)
        throw new Error(`Failed to load workspace config: ${workspaceId}`);
    const connections: MissionRouteConnection[] = (transportOwner["options"].preflightConnections?.() ?? getLlmConnections())
        .map(({ slug, providerType, models, defaultModel, piAuthProvider }) => ({
        slug,
        providerType,
        ...(models ? { models } : {}),
        ...(defaultModel ? { defaultModel } : {}),
        ...(piAuthProvider ? { piAuthProvider } : {}),
    }));
    const executing = spec.workItems.filter((item) => ['task', 'subtask', 'integration', 'correction'].includes(item.kind));
    const profileIds = new Set([
        ...executing.map((item) => item.agentProfileId ?? spec.defaultWorkerProfileId),
        spec.reviewerProfileId,
        spec.supervisorProfileId,
    ]);
    const routeByProfileId: NonNullable<Parameters<typeof simulateMissionDigitalTwin>[0]['routeByProfileId']> = {};
    const routeByWorkItemId: NonNullable<Parameters<typeof simulateMissionDigitalTwin>[0]['routeByWorkItemId']> = {};
    const origin = spec.originSessionId
        ? transportOwner["options"].sessionManager.getSessions(workspaceId).find(session => session.id === spec.originSessionId)
        : undefined;
    const profileById = new Map(spec.agentProfiles.map(profile => [profile.id, profile]));
    const routingContextFor = (profileId: string, _assignment: string): MissionSelectionContext => {
        const profile = profileById.get(profileId);
        if (!profile)
            return {};
        // SessionMissionExecutor uses workspace defaults only when the profile
        // does not explicitly declare sources. Mirror that exact source set so
        // sensitivity policy cannot turn a dry-run green and the live turn red.
        const sourceSlugs = profile.sources.length > 0
            ? profile.sources
            : config.defaults?.enabledSourceSlugs ?? [];
        const sources = sourceSlugs.length > 0
            ? getSourcesBySlugs(workspace.rootPath, sourceSlugs)
            : [];
        const classification = { difficulty: undefined, requiredCapabilities: [] };
        return {
            sensitivity: maxSourceSensitivity(sources.map(source => source.config.routingSensitivity)),
            sourceSlugs,
            difficulty: classification.difficulty,
            requiredCapabilities: classification.requiredCapabilities,
        };
    };
    const routingContextByWorkItemId = new Map(executing.map(item => {
        const profileId = item.agentProfileId ?? spec.defaultWorkerProfileId;
        return [item.id, routingContextFor(profileId, item.prompt ?? item.title)] as const;
    }));
    const aggregateRouteInputByProfileId = new Map([...profileIds].map(profileId => {
        const assignedContexts = executing
            .filter(item => (item.agentProfileId ?? spec.defaultWorkerProfileId) === profileId)
            .map(item => routingContextByWorkItemId.get(item.id)!);
        const assignedPrompts = executing
            .filter(item => (item.agentProfileId ?? spec.defaultWorkerProfileId) === profileId)
            .map(item => item.prompt ?? item.title);
        const roleAssignment = profileId === spec.reviewerProfileId
            ? 'Évaluer indépendamment les objectifs et rendre un verdict structuré fondé sur les preuves.'
            : 'Contrôler indépendamment la mission complète, ses preuves et ses critères, puis rendre un verdict structuré.';
        const contexts = assignedContexts.length > 0
            ? assignedContexts
            : [routingContextFor(profileId, roleAssignment)];
        return [profileId, {
                assignment: assignedPrompts.length > 0 ? assignedPrompts.join('\n') : roleAssignment,
                context: {
                    sensitivity: maxSourceSensitivity(contexts.map(context => context.sensitivity)),
                    sourceSlugs: Array.from(new Set(contexts.flatMap(context => context.sourceSlugs ?? []))),
                    difficulty: maxMissionDifficulty(contexts.map(context => context.difficulty)),
                    requiredCapabilities: Array.from(new Set(contexts.flatMap(context => context.requiredCapabilities ?? []))) as string[],
                } satisfies MissionSelectionContext,
            }] as const;
    }));
    const resolveRoute = (profileId: string, context: MissionSelectionContext, assignment: string, projectedMissionUsd?: number) => {
        const profile = profileById.get(profileId);
        if (!profile)
            return undefined;
        const defaultConnection = config.defaults?.defaultLlmConnection
            ?? getDefaultLlmConnection() ?? undefined;
        return resolveExplicitMissionModel({
            profile,
            origin,
            defaultConnectionSlug: defaultConnection,
            defaultThinkingLevel: config.defaults?.thinkingLevel ?? getDefaultThinkingLevel(),
            connections,
            routingContext: context,
            missionObjective: spec.objective,
            assignment,
            reviewOnly: profile.role === 'reviewer' || profile.role === 'supervisor',
            measuredMissionUsd: snapshot ? measuredMissionCostUsd(snapshot) : 0,
            projectedMissionUsd,
        });
    };
    const resolveRoutes = (projectedMissionUsd?: number) => {
        for (const profileId of [...profileIds].sort()) {
            const aggregate = aggregateRouteInputByProfileId.get(profileId);
            if (!aggregate)
                continue;
            const route = resolveRoute(profileId, aggregate.context, aggregate.assignment, projectedMissionUsd);
            if (route)
                routeByProfileId[profileId] = route;
        }
        for (const item of executing) {
            const profileId = item.agentProfileId ?? spec.defaultWorkerProfileId;
            const context = routingContextByWorkItemId.get(item.id);
            if (!context)
                continue;
            const route = resolveRoute(profileId, context, item.prompt ?? item.title, projectedMissionUsd);
            if (route)
                routeByWorkItemId[item.id] = route;
        }
    };
    resolveRoutes();
    const pathPolicyAllowedByWorkItemId = Object.fromEntries(executing.map((item) => [
        item.id,
        transportOwner["workItemPathsAreAuthorized"](workspace, spec, item),
    ]));
    const connectorByWorkItemId: Record<string, MissionConnectorPreflight> = {};
    for (const item of executing.filter((candidate) => candidate.effect === 'external-mutation')) {
        const invocation = item.connectorInvocation!;
        if (!transportOwner["options"].connectorExecutorFactory) {
            connectorByWorkItemId[item.id] = unavailableConnectorReadiness();
            continue;
        }
        if (!transportOwner["options"].connectorReadiness)
            continue;
        try {
            connectorByWorkItemId[item.id] = await transportOwner["options"].connectorReadiness.inspect({
                workspace,
                missionId: spec.id,
                workItemId: item.id,
                connectorPack: invocation.pack,
                operationId: invocation.operationId,
                resourceType: invocation.resourceType,
            });
        }
        catch (error) {
            transportOwner["reportError"]({
                workspaceId,
                missionId: spec.id,
                workItemId: item.id,
                error: normalizedError(error),
            });
            connectorByWorkItemId[item.id] = unavailableConnectorReadiness();
        }
    }
    const estimatedCostUsdByWorkItemId: Record<string, number> = {};
    if (transportOwner["options"].preflightCostEstimator) {
        for (const item of executing) {
            const runtime = snapshot?.workItems[item.id];
            // A journaled item outside the scheduler's executable states has
            // already consumed its measured cost (or will not run again). Keep a
            // zero entry so the remaining-budget projection stays complete without
            // double-counting accepted/submitted work. A changed replan definition
            // is estimated again because the controller will invalidate it.
            if (runtime
                && !['pending', 'reserved', 'running'].includes(runtime.status)
                && JSON.stringify(runtime.definition) === JSON.stringify(item)) {
                estimatedCostUsdByWorkItemId[item.id] = 0;
                continue;
            }
            const connectionSlug = routeByWorkItemId[item.id]?.connectionSlug;
            if (!connectionSlug)
                continue;
            const estimate = await transportOwner["options"].preflightCostEstimator.estimateUsd({
                workspace,
                spec,
                item,
                connectionSlug,
            });
            if (estimate === undefined)
                continue;
            if (!Number.isFinite(estimate) || estimate < 0) {
                throw new Error(`Invalid host cost estimate for work item "${item.id}"`);
            }
            estimatedCostUsdByWorkItemId[item.id] = estimate;
        }
    }
    if (Object.keys(estimatedCostUsdByWorkItemId).length === executing.length) {
        resolveRoutes(Object.values(estimatedCostUsdByWorkItemId).reduce((sum, value) => sum + value, 0));
    }
    return simulateMissionDigitalTwin({
        spec,
        routeByProfileId,
        routeByWorkItemId,
        pathPolicyAllowedByWorkItemId,
        ...(Object.keys(connectorByWorkItemId).length > 0 ? { connectorByWorkItemId } : {}),
        ...(Object.keys(estimatedCostUsdByWorkItemId).length > 0 ? { estimatedCostUsdByWorkItemId } : {}),
        ...remainingMissionBudgetUsd(config.governance, snapshot, spec),
        generatedAt: (transportOwner["options"].preflightNow?.() ?? new Date()).toISOString(),
    });
}
