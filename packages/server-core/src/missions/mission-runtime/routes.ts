import type { MissionSelectionContext } from '../mission-model-decision.ts';
import { omitUndefined } from '@craft-agent/shared/utils/json';
import { getLlmConnections, getDefaultLlmConnection, getDefaultThinkingLevel } from "@craft-agent/shared/config";
import { loadMissionSnapshot, type MissionExecutionBinding, type MissionSpec, type MissionWorkItem } from "@craft-agent/shared/missions";
import type { Session } from "@craft-agent/shared/protocol";
import { loadWorkspaceConfig } from "@craft-agent/shared/workspaces";
import { getSourcesBySlugs } from "@craft-agent/shared/sources";
import { loadWorkspaceExecutionProofIssuer } from "../../tasks/execution-proof-runtime.ts";
import { type MissionExecutionInput, type MissionWorkExecutor, type OrdinaryMissionRoutePin } from "../MissionRuntime.ts";
import { SessionMissionExecutor } from "../SessionMissionExecutor.ts";
import { resolveExplicitMissionModel } from "../mission-model-decision.ts";
import { specializedCapabilityIdentity } from "../../specialized-profiles/capability-identity.ts";
import { effectiveOrdinaryMissionSourceSlugs, ordinaryMissionConnectionIdentity, ordinaryMissionRouteConfigIdentity, ordinaryMissionSourceBindings, ordinaryMissionSourceIdentityFromBindings } from "../mission-route-identity.ts";
import { canonicalMissionWorkingDirectory } from "../mission-workspace-path.ts";
import { maxSourceSensitivity } from "@craft-agent/shared/config";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import { measuredMissionCostUsd } from './shared.ts';
import type { MissionWorkspace, MissionPreflightConnection } from './shared.ts';

export async function createProductionExecutor(transportOwner: MissionRuntimeService, workspace: MissionWorkspace): Promise<MissionWorkExecutor> {
    const proofIssuer = await loadWorkspaceExecutionProofIssuer(workspace.id);
    return new SessionMissionExecutor({
        host: transportOwner["options"].sessionManager,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        defaultLlmConnection: loadWorkspaceConfig(workspace.rootPath)?.defaults?.defaultLlmConnection
            ?? getDefaultLlmConnection() ?? undefined,
        verifyExecutionProof: (proof, binding) => proofIssuer.verifyForTask(proof, binding),
        resolveSubagentAutonomyContext: (parentSessionId) => transportOwner["options"].resolveSubagentAutonomyContext?.(workspace, parentSessionId) ?? {},
    });
}

export function ordinaryRouteKey(_transportOwner: MissionRuntimeService, workspaceId: string, missionId: string): string {
    return `${workspaceId}\0${missionId}`;
}

export async function withOrdinaryRoutePreparationLock<T>(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string, operation: () => Promise<T>): Promise<T> {
    const key = transportOwner.ordinaryRouteKey(workspaceId, missionId);
    const previous = transportOwner.ordinaryRoutePreparationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    transportOwner.ordinaryRoutePreparationLocks.set(key, tail);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (transportOwner.ordinaryRoutePreparationLocks.get(key) === tail) {
            transportOwner.ordinaryRoutePreparationLocks.delete(key);
        }
    }
}

/** Build one budget-aware route from the latest journal snapshot. */
export async function prepareOrdinaryMissionDispatchRoute(transportOwner: MissionRuntimeService, workspaceId: string, input: MissionExecutionInput): Promise<OrdinaryMissionRoutePin | undefined> {
    if (input.specializedProfile)
        return undefined;
    return transportOwner.withOrdinaryRoutePreparationLock(workspaceId, input.mission.id, async () => {
        const workspace = transportOwner["resolveWorkspace"](workspaceId);
        if (!workspace)
            throw new Error(`Workspace ${workspaceId} not found`);
        const config = loadWorkspaceConfig(workspace.rootPath);
        const snapshot = loadMissionSnapshot(workspace.rootPath, input.mission.id);
        if (!snapshot)
            throw new Error('Mission route decision requires its current journal snapshot');
        const currentRuntime = snapshot.workItems[input.item.id];
        if (!currentRuntime || JSON.stringify(currentRuntime.definition) !== JSON.stringify(input.item)) {
            throw new Error(`Mission work item "${input.item.id}" drifted before route preparation`);
        }
        const connections = transportOwner.currentMissionConnections();
        const origin = input.mission.originSessionId
            ? transportOwner["options"].sessionManager.getSessions(workspaceId)
                .find(session => session.id === input.mission.originSessionId)
            : undefined;
        const measuredMissionUsd = measuredMissionCostUsd(snapshot);
        const environmentSha256 = transportOwner.missionEstimateEnvironmentIdentity(workspace, snapshot, config, connections, origin);
        const projectedRemainingUsd = await transportOwner.projectedRemainingMissionCostUsd({
            workspace,
            snapshot,
            config,
            connections,
            origin,
            measuredMissionUsd,
            environmentSha256,
            currentItem: input.item,
        });
        const route = transportOwner.resolveOrdinaryRouteForItem({
            workspace,
            spec: input.mission,
            item: input.item,
            profile: input.profile,
            config,
            connections,
            origin,
            measuredMissionUsd,
            ...(projectedRemainingUsd !== undefined ? { projectedRemainingUsd: projectedRemainingUsd } : {}),
        });
        if (!route.policyAllowed || !route.connectionSlug || !route.routingDecision) {
            throw new Error(`Mission route preflight refused before dispatch: ${route.explanation}`);
        }
        const connection = connections.find(candidate => candidate.slug === route.connectionSlug);
        if (!connection)
            throw new Error(`Mission connection "${route.connectionSlug}" is unavailable`);
        const effectiveSourceSlugs = effectiveOrdinaryMissionSourceSlugs(input.profile, config);
        const effectiveSourceBindings = await ordinaryMissionSourceBindings(workspace.rootPath, effectiveSourceSlugs);
        const sourceIdentitySha256 = ordinaryMissionSourceIdentityFromBindings(effectiveSourceBindings);
        const cwd = canonicalMissionWorkingDirectory(workspace.rootPath, input.mission.cwd);
        const runtimeIdentitySha256 = transportOwner.validOrdinaryRuntimeIdentity();
        const connectionIdentitySha256 = await ordinaryMissionConnectionIdentity({
            agentProfileId: input.profile.id,
            connection,
            connectionSlug: route.connectionSlug,
            model: route.routingDecision.model,
            thinkingLevel: route.routingDecision.thinkingLevel,
            ...(runtimeIdentitySha256 !== undefined ? { runtimeIdentitySha256: runtimeIdentitySha256 } : {}),
            credentialBindingResolver: transportOwner["options"].ordinaryRouteCredentialBindingResolver,
        });
        const routeConfigIdentitySha256 = ordinaryMissionRouteConfigIdentity({
            profile: input.profile,
            config,
            ...(origin !== undefined ? { origin: origin } : {}),
            defaults: {
                defaultLlmConnection: getDefaultLlmConnection(),
                defaultThinkingLevel: getDefaultThinkingLevel(),
            },
        });
        const routeDecisionSha256 = specializedCapabilityIdentity({
            schemaVersion: 1,
            connectionSlug: route.connectionSlug,
            routingDecision: route.routingDecision,
            measuredMissionUsd,
            projectedRemainingUsd: projectedRemainingUsd ?? null,
        });
        return {
            schemaVersion: 1,
            routeDecisionSha256,
            routeConfigIdentitySha256,
            connectionIdentitySha256,
            sourceIdentitySha256,
            agentProfileId: input.profile.id,
            connectionSlug: route.connectionSlug,
            version: route.routingDecision.version,
            profile: route.routingDecision.profile,
            origin: route.routingDecision.origin,
            ...(route.routingDecision.requestedModel
                ? { requestedModel: route.routingDecision.requestedModel }
                : {}),
            model: route.routingDecision.model,
            thinkingLevel: route.routingDecision.thinkingLevel,
            measuredMissionUsd,
            ...(projectedRemainingUsd === undefined ? {} : { projectedRemainingUsd }),
            effectiveSourceSlugs,
            effectiveSourceBindings,
            cwd,
            ...(runtimeIdentitySha256 ? { runtimeIdentitySha256 } : {}),
        };
    });
}

/**
   * Execute never recomputes mission cost or a global plan. It verifies only
   * the persisted route/config/source identities before passing the immutable
   * pin to the session executor.
   */
export async function revalidateOrdinaryMissionDispatchRoute(transportOwner: MissionRuntimeService, workspaceId: string, input: MissionExecutionInput, route: MissionExecutionBinding['missionRoute']): Promise<void> {
    const workspace = transportOwner["resolveWorkspace"](workspaceId);
    if (!workspace)
        throw new Error(`Workspace ${workspaceId} not found`);
    const config = loadWorkspaceConfig(workspace.rootPath);
    const routingEnabled = true;
    if (!route) {
        if (routingEnabled) {
            throw new Error('Mission route decision is missing from the durable dispatch binding');
        }
        return;
    }
    if (!routingEnabled) {
        throw new Error('Mission route configuration changed after route preparation');
    }
    if (route.agentProfileId !== input.profile.id) {
        throw new Error('Mission agent profile drifted after route preparation');
    }
    const origin = input.mission.originSessionId
        ? transportOwner["options"].sessionManager.getSessions(workspaceId)
            .find(session => session.id === input.mission.originSessionId)
        : undefined;
    if (ordinaryMissionRouteConfigIdentity({
        profile: input.profile,
        config,
        ...(origin !== undefined ? { origin: origin } : {}),
        defaults: {
            defaultLlmConnection: getDefaultLlmConnection(),
            defaultThinkingLevel: getDefaultThinkingLevel(),
        },
    })
        !== route.routeConfigIdentitySha256) {
        throw new Error('Mission route configuration drifted after prepare');
    }
    const effectiveSourceSlugs = effectiveOrdinaryMissionSourceSlugs(input.profile, config);
    if (JSON.stringify(effectiveSourceSlugs) !== JSON.stringify(route.effectiveSourceSlugs)) {
        throw new Error('Mission effective sources drifted after prepare');
    }
    const effectiveSourceBindings = await ordinaryMissionSourceBindings(workspace.rootPath, effectiveSourceSlugs);
    if (JSON.stringify(effectiveSourceBindings) !== JSON.stringify(route.effectiveSourceBindings)
        || ordinaryMissionSourceIdentityFromBindings(effectiveSourceBindings)
            !== route.sourceIdentitySha256) {
        throw new Error('Mission source configuration or credential binding drifted after prepare');
    }
    const cwd = canonicalMissionWorkingDirectory(workspace.rootPath, input.mission.cwd);
    if (cwd !== route.cwd)
        throw new Error('Mission working directory drifted after prepare');
    const runtimeIdentitySha256 = transportOwner.validOrdinaryRuntimeIdentity();
    if (route.runtimeIdentitySha256 && route.runtimeIdentitySha256 !== runtimeIdentitySha256) {
        throw new Error('Mission host runtime identity drifted after prepare');
    }
    const connection = transportOwner.currentMissionConnections()
        .find(candidate => candidate.slug === route.connectionSlug);
    if (!connection)
        throw new Error(`Mission connection "${route.connectionSlug}" is unavailable`);
    const connectionIdentitySha256 = await ordinaryMissionConnectionIdentity({
        agentProfileId: route.agentProfileId,
        connection,
        connectionSlug: route.connectionSlug,
        model: route.model,
        thinkingLevel: route.thinkingLevel,
        ...(route.runtimeIdentitySha256 !== undefined ? { runtimeIdentitySha256: route.runtimeIdentitySha256 } : {}),
        credentialBindingResolver: transportOwner["options"].ordinaryRouteCredentialBindingResolver,
    });
    if (connectionIdentitySha256 !== route.connectionIdentitySha256) {
        throw new Error('Mission connection endpoint, protocol, authentication, or credential binding drifted after prepare');
    }
}

export function currentMissionConnections(transportOwner: MissionRuntimeService): MissionPreflightConnection[] {
    return [...(transportOwner["options"].preflightConnections?.() ?? getLlmConnections())];
}

export function validOrdinaryRuntimeIdentity(transportOwner: MissionRuntimeService): string | undefined {
    const identity = transportOwner["options"].specializedProfileRuntimeIdentitySha256;
    return identity && /^[a-f0-9]{64}$/.test(identity) ? identity : undefined;
}

export function resolveOrdinaryRouteForItem(_transportOwner: MissionRuntimeService, input: {
    workspace: MissionWorkspace;
    spec: MissionSpec;
    item: MissionWorkItem;
    profile: MissionExecutionInput['profile'];
    config: ReturnType<typeof loadWorkspaceConfig>;
    connections: readonly MissionPreflightConnection[];
    origin: Session | undefined;
    measuredMissionUsd: number;
    projectedRemainingUsd?: number;
}) {
    const sourceSlugs = effectiveOrdinaryMissionSourceSlugs(input.profile, input.config);
    const sources = sourceSlugs.length > 0
        ? getSourcesBySlugs(input.workspace.rootPath, sourceSlugs)
        : [];
    const assignment = input.item.prompt ?? input.item.title;
    const classification = { difficulty: undefined, requiredCapabilities: [] };
    return resolveExplicitMissionModel({
        profile: input.profile,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        defaultConnectionSlug: input.config?.defaults?.defaultLlmConnection
            ?? getDefaultLlmConnection() ?? undefined,
        defaultThinkingLevel: input.config?.defaults?.thinkingLevel ?? getDefaultThinkingLevel(),
        connections: input.connections,
        routingContext: omitUndefined<MissionSelectionContext>({
            sensitivity: maxSourceSensitivity(sources.map(source => source.config.routingSensitivity)),
            sourceSlugs,
            ...(classification.difficulty !== undefined ? { difficulty: classification.difficulty } : {}),
            requiredCapabilities: classification.requiredCapabilities,
        }),
        missionObjective: input.spec.objective,
        assignment,
        reviewOnly: input.profile.role === 'reviewer' || input.profile.role === 'supervisor',
        measuredMissionUsd: input.measuredMissionUsd,
        ...(input.projectedRemainingUsd !== undefined ? { projectedMissionUsd: input.projectedRemainingUsd } : {}),
    });
}
