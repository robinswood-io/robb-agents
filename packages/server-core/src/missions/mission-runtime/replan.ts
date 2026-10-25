import { MissionSpecSchema, loadMissionSnapshot, type MissionReplanPreview, type MissionSnapshot, type MissionWorkItem } from "@craft-agent/shared/missions";
import { previewAdmissibleMissionReplan } from "../MissionController.ts";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';

export async function previewReplan(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string, expectedRevision: number, proposedWorkItems: MissionWorkItem[]): Promise<MissionReplanPreview> {
    const workspace = transportOwner["resolveWorkspace"](workspaceId);
    if (!workspace)
        throw new Error(`Workspace ${workspaceId} not found`);
    const snapshot = loadMissionSnapshot(workspace.rootPath, missionId);
    if (!snapshot)
        throw new Error(`Unknown mission "${missionId}"`);
    // Preserve the controller's state/lease admission boundary before host
    // capability checks. Both are fail-closed and side-effect free, but an
    // active lease is the authoritative reason a replan cannot be previewed.
    const preview = previewAdmissibleMissionReplan({
        snapshot,
        expectedRevision,
        proposedWorkItems,
    });
    const proposedSpec = await transportOwner["createSpecializedProfileResolver"](workspace).revalidateMissionSpec(MissionSpecSchema.parse({ ...snapshot.spec, workItems: proposedWorkItems }));
    transportOwner["assertAdmissible"](workspace, proposedSpec);
    return preview;
}

export async function replanMission(transportOwner: MissionRuntimeService, input: {
    workspaceId: string;
    missionId: string;
    expectedRevision: number;
    proposedWorkItems: MissionWorkItem[];
    actorId: string;
    reason: string;
}): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](input.workspaceId);
    const before = context.controller.getMission(input.missionId);
    const revalidated = await context.specializedProfiles.revalidateMissionSpec(before.spec);
    transportOwner["assertAdmissible"](context.workspace, revalidated);
    const proposedSpec = await context.specializedProfiles.revalidateMissionSpec(MissionSpecSchema.parse({ ...before.spec, workItems: input.proposedWorkItems }));
    transportOwner["assertAdmissible"](context.workspace, proposedSpec);
    const snapshot = context.controller.replanMission(input.missionId, {
        expectedRevision: input.expectedRevision,
        proposedWorkItems: input.proposedWorkItems,
        actorId: input.actorId,
        reason: input.reason,
    });
    transportOwner["options"].onSnapshot?.(input.workspaceId, snapshot);
    if (!['draft', 'paused', 'blocked', 'waiting-approval'].includes(snapshot.status)) {
        context.runtime.startMission(input.missionId);
    }
    return snapshot;
}
