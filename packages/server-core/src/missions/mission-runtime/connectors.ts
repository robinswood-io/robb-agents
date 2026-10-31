import { listMissionIds, type MissionSnapshot } from "@craft-agent/shared/missions";
import { type PendingMissionConnectorApproval } from "../BrokeredMissionConnectorExecutor.ts";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';

export async function getPendingConnectorApproval(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string, workItemId: string): Promise<PendingMissionConnectorApproval | null> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    const snapshot = context.controller.getMission(missionId);
    if (!snapshot.workItems[workItemId])
        throw new Error(`Unknown mission work item "${workItemId}"`);
    return context.connectorExecutor?.pendingApproval(missionId, workItemId) ?? null;
}

export async function listPendingConnectorApprovals(transportOwner: MissionRuntimeService, workspaceId: string): Promise<PendingMissionConnectorApproval[]> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    if (!context.connectorExecutor)
        return [];
    const approvals: PendingMissionConnectorApproval[] = [];
    for (const missionId of listMissionIds(context.workspace.rootPath)) {
        const snapshot = context.controller.getMission(missionId);
        for (const runtime of Object.values(snapshot.workItems)) {
            if (runtime.definition.effect !== 'external-mutation')
                continue;
            const pending = context.connectorExecutor.pendingApproval(missionId, runtime.definition.id);
            if (pending)
                approvals.push(pending);
        }
    }
    return approvals.sort((left, right) => left.expiresAt.localeCompare(right.expiresAt)
        || left.missionId.localeCompare(right.missionId)
        || left.workItemId.localeCompare(right.workItemId));
}

export async function resolveConnectorApproval(transportOwner: MissionRuntimeService, input: {
    workspaceId: string;
    missionId: string;
    workItemId: string;
    approvalId: string;
    requestHash: string;
    decision: 'approved' | 'denied';
    resolvedBy: string;
}): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](input.workspaceId);
    if (!context.connectorExecutor)
        throw new Error('Mission connector broker is unavailable');
    const before = context.controller.getMission(input.missionId);
    const revalidated = await context.specializedProfiles.revalidateMissionSpec(before.spec);
    transportOwner.assertAdmissible(context.workspace, revalidated);
    const workItem = before.workItems[input.workItemId];
    if (!workItem || workItem.definition.effect !== 'external-mutation') {
        throw new Error(`Unknown external-mutation work item "${input.workItemId}"`);
    }
    context.connectorExecutor.resolveApproval(input);
    const current = context.controller.getMission(input.missionId);
    const resumed = current.status === 'waiting-approval'
        ? context.controller.resumeAfterApproval(input.missionId)
        : current;
    if (resumed !== current)
        transportOwner["options"].onSnapshot?.(input.workspaceId, resumed);
    return context.runtime.startMission(input.missionId);
}

export async function refreshExpiredConnectorApproval(transportOwner: MissionRuntimeService, workspaceId: string, missionId: string, workItemId: string): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    const before = context.controller.getMission(missionId);
    const revalidated = await context.specializedProfiles.revalidateMissionSpec(before.spec);
    transportOwner.assertAdmissible(context.workspace, revalidated);
    const workItem = before.workItems[workItemId];
    if (!workItem || workItem.definition.effect !== 'external-mutation') {
        throw new Error(`Unknown external-mutation work item "${workItemId}"`);
    }
    if (!context.connectorExecutor?.approvalExpired(missionId, workItemId)) {
        throw new Error('Mission connector approval is not expired');
    }
    const snapshot = context.controller.getMission(missionId);
    if (snapshot.status !== 'waiting-approval')
        throw new Error('Mission is not waiting for connector approval');
    const resumed = context.controller.resumeAfterApproval(missionId);
    transportOwner["options"].onSnapshot?.(workspaceId, resumed);
    return context.runtime.startMission(missionId);
}
