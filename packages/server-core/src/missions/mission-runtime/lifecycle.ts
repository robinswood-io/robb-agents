import { listMissionIds, type MissionSnapshot } from "@craft-agent/shared/missions";
import { MissionController } from "../MissionController.ts";
import { MissionRuntime } from "../MissionRuntime.ts";
import { EffectRoutingMissionExecutor } from "../BrokeredMissionConnectorExecutor.ts";
import { resolveMissionSubmissionEvidence } from "../MissionEvidenceResolver.ts";
import { loadMissionProofPassportService } from "../proof-passport-runtime.ts";
import { SpecializedProfileMissionExecutor } from "../../specialized-profiles/MissionSpecializedProfileResolver.ts";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import { OrdinaryMissionRouteBindingExecutor, evaluateMissionRuntimePolicy } from './shared.ts';
import type { WorkspaceMissionRuntime } from './shared.ts';

export async function getMission(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    return (await transportOwner["contextFor"](workspaceId)).controller.getMission(missionId);
}

export async function listMissions(transportOwner: MissionRuntimeService, workspaceId: string): Promise<MissionSnapshot[]> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    return listMissionIds(context.workspace.rootPath)
        .map((missionId) => context.controller.getMission(missionId))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function pauseMission(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string, reason: string): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    const snapshot = context.controller.pauseMission(missionId, reason);
    transportOwner["options"].onSnapshot?.(workspaceId, snapshot);
    return snapshot;
}

export async function resumeMission(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    const before = context.controller.getMission(missionId);
    const revalidated = await context.specializedProfiles.revalidateMissionSpec(before.spec);
    transportOwner["assertAdmissible"](context.workspace, revalidated);
    return context.runtime.startMission(missionId);
}

export async function cancelMission(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string, reason: string): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    const before = context.controller.getMission(missionId);
    const activeSessionIds = Object.values(before.workItems)
        .filter((runtime) => runtime.status === 'reserved' || runtime.status === 'running')
        .flatMap((runtime) => runtime.externalSessionId ? [runtime.externalSessionId] : []);
    const snapshot = context.controller.cancelMission(missionId, reason);
    transportOwner["ordinaryRouteEstimates"].delete(transportOwner["ordinaryRouteKey"](workspaceId, missionId));
    transportOwner["options"].onSnapshot?.(workspaceId, snapshot);
    await Promise.allSettled(activeSessionIds.map((sessionId) => transportOwner["options"].sessionManager.cancelProcessing(sessionId, true)));
    return snapshot;
}

export async function enforceRuntimePolicies(transportOwner: MissionRuntimeService): Promise<number> {
    await transportOwner["start"]();
    let halted = 0;
    for (const workspace of transportOwner["listWorkspaces"]()) {
        const context = await transportOwner["contextFor"](workspace.id);
        for (const missionId of listMissionIds(workspace.rootPath)) {
            const before = context.controller.getMission(missionId);
            if (['completed', 'failed', 'cancelled'].includes(before.status))
                continue;
            const after = await context.runtime.enforceRunPolicy(missionId);
            if (after.status !== before.status && ['completed', 'failed', 'cancelled'].includes(after.status))
                halted += 1;
        }
    }
    return halted;
}

export async function contextFor(transportOwner: MissionRuntimeService, workspaceId: string): Promise<WorkspaceMissionRuntime> {
    const existing = transportOwner["contexts"].get(workspaceId);
    if (existing)
        return existing;
    const pending = transportOwner["createContext"](workspaceId);
    transportOwner["contexts"].set(workspaceId, pending);
    try {
        return await pending;
    }
    catch (error) {
        transportOwner["contexts"].delete(workspaceId);
        throw error;
    }
}

export async function createContext(transportOwner: MissionRuntimeService, workspaceId: string): Promise<WorkspaceMissionRuntime> {
    const workspace = transportOwner["resolveWorkspace"](workspaceId);
    if (!workspace)
        throw new Error(`Workspace ${workspaceId} not found`);
    const controller = new MissionController({
        workspaceRoot: workspace.rootPath,
        resolveSubmissionEvidence: (item, submission) => resolveMissionSubmissionEvidence({
            workspaceRoot: workspace.rootPath,
            item,
            submission,
        }).submission,
    });
    const ordinaryExecutor = transportOwner["options"].executorFactory
        ? await transportOwner["options"].executorFactory(workspace)
        : await transportOwner["createProductionExecutor"](workspace);
    const routeBoundOrdinaryExecutor = new OrdinaryMissionRouteBindingExecutor(ordinaryExecutor, (input) => transportOwner["prepareOrdinaryMissionDispatchRoute"](workspace.id, input), (input, route) => transportOwner["revalidateOrdinaryMissionDispatchRoute"](workspace.id, input, route));
    const connectorExecutor = transportOwner["options"].connectorExecutorFactory
        ? await transportOwner["options"].connectorExecutorFactory(workspace)
        : undefined;
    const effectExecutor = connectorExecutor
        ? new EffectRoutingMissionExecutor(routeBoundOrdinaryExecutor, connectorExecutor)
        : routeBoundOrdinaryExecutor;
    const specializedProfiles = transportOwner["createSpecializedProfileResolver"](workspace);
    const executor = new SpecializedProfileMissionExecutor(effectExecutor, specializedProfiles);
    const proofPassports = transportOwner["options"].proofPassportFactory
        ? await transportOwner["options"].proofPassportFactory(workspace) ?? undefined
        : transportOwner["options"].executorFactory
            ? undefined
            : await loadMissionProofPassportService(workspace.id, workspace.rootPath);
    let context: WorkspaceMissionRuntime;
    const runtime = new MissionRuntime({
        workspaceRoot: workspace.rootPath,
        controller,
        executor,
        nowMs: transportOwner["options"].nowMs,
        evaluateRunPolicy: (snapshot, pendingTelemetry, completedAttempt) => evaluateMissionRuntimePolicy({
            workspace,
            snapshot,
            pendingTelemetry,
            completedAttempt,
            killSwitch: transportOwner["options"].getKillSwitch?.(),
            nowMs: transportOwner["options"].nowMs?.() ?? Date.now(),
        }),
        onPolicyHalt: async (before) => {
            const activeSessionIds = Object.values(before.workItems)
                .filter((item) => item.status === 'reserved' || item.status === 'running')
                .flatMap((item) => item.externalSessionId ? [item.externalSessionId] : []);
            await Promise.allSettled(activeSessionIds.map((sessionId) => transportOwner["options"].sessionManager.cancelProcessing(sessionId, true)));
        },
        onAttemptSettled: ({ missionId, workItemId }) => {
            transportOwner["releaseOrdinaryMissionEstimate"](workspace.id, missionId, workItemId);
        },
        onSnapshot: (snapshot) => {
            transportOwner["options"].onSnapshot?.(workspace.id, snapshot);
            if (['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
                transportOwner["ordinaryRouteEstimates"].delete(transportOwner["ordinaryRouteKey"](workspace.id, snapshot.spec.id));
            }
            if (transportOwner["ensureCompletionPassport"](context, snapshot))
                transportOwner["scheduleReport"](context, snapshot);
        },
        onError: ({ missionId, workItemId, error }) => transportOwner["reportError"]({ workspaceId: workspace.id, missionId, workItemId, error }),
    });
    context = { workspace, controller, runtime, proofPassports, connectorExecutor, specializedProfiles };
    return context;
}
