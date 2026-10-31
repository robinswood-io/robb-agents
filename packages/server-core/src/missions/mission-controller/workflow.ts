import { MissionSpecSchema, appendMissionEvents, loadMissionSnapshot, type MissionEvent, type MissionSnapshot, type MissionSpec, type MissionWorkItem, type MissionReplanPreview } from "@craft-agent/shared/missions";
import type { MissionController } from '../MissionController.ts';
import { TERMINAL_MISSION_STATUSES, runtimeItems, previewAdmissibleMissionReplan } from './shared.ts';
import type { MissionReplanInput } from './shared.ts';

export function commit(transportOwner: MissionController, missionId: string, revision: number, events: readonly MissionEvent[]): MissionSnapshot {
    appendMissionEvents(transportOwner["workspaceRoot"], missionId, events, revision);
    return transportOwner["requireMission"](missionId);
}

export function createMission(transportOwner: MissionController, input: MissionSpec): MissionSnapshot {
    const spec = MissionSpecSchema.parse(input);
    if (loadMissionSnapshot(transportOwner["workspaceRoot"], spec.id))
        throw new Error(`Mission "${spec.id}" already exists`);
    const event = transportOwner["event"]({ kind: 'mission-created', spec });
    appendMissionEvents(transportOwner["workspaceRoot"], spec.id, [event], 0);
    return transportOwner["requireMission"](spec.id);
}

export function previewReplan(transportOwner: MissionController, missionId: string, expectedRevision: number, proposedWorkItems: MissionWorkItem[]): MissionReplanPreview {
    const snapshot = transportOwner["requireMission"](missionId);
    return previewAdmissibleMissionReplan({
        snapshot,
        expectedRevision,
        proposedWorkItems,
    });
}

export function replanMission(transportOwner: MissionController, missionId: string, input: MissionReplanInput): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    if (!input.actorId.trim())
        throw new Error('Mission replan actor identity is required');
    if (!input.reason.trim())
        throw new Error('Mission replan reason is required');
    const preview = previewAdmissibleMissionReplan({
        snapshot,
        expectedRevision: input.expectedRevision,
        proposedWorkItems: input.proposedWorkItems,
    });
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'mission-replanned',
            actorId: input.actorId.trim(),
            reason: input.reason.trim(),
            proposedWorkItems: input.proposedWorkItems,
            preview,
        })]);
}

export function startMission(transportOwner: MissionController, missionId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    if (snapshot.status !== 'draft' && snapshot.status !== 'paused') {
        throw new Error(`Mission "${missionId}" cannot start from ${snapshot.status}`);
    }
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({ kind: 'mission-status-changed', status: 'running' })]);
}

export function pauseMission(transportOwner: MissionController, missionId: string, reason: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    if (TERMINAL_MISSION_STATUSES.has(snapshot.status))
        throw new Error(`Mission "${missionId}" is terminal`);
    return transportOwner["commit"](missionId, snapshot.revision, [
        transportOwner["event"]({ kind: 'mission-status-changed', status: 'paused', reason }),
    ]);
}

export function resumeAfterApproval(transportOwner: MissionController, missionId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    if (snapshot.status !== 'waiting-approval') {
        throw new Error(`Mission "${missionId}" is not waiting for approval`);
    }
    return transportOwner["commit"](missionId, snapshot.revision, [
        transportOwner["event"]({ kind: 'mission-status-changed', status: 'running', reason: 'Host approval resolved' }),
    ]);
}

export function cancelMission(transportOwner: MissionController, missionId: string, reason: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    if (TERMINAL_MISSION_STATUSES.has(snapshot.status)) {
        if (snapshot.status === 'cancelled')
            return snapshot;
        throw new Error(`Mission "${missionId}" is terminal`);
    }
    const events: MissionEvent[] = runtimeItems(snapshot)
        .filter((runtime) => !['accepted', 'rejected', 'superseded', 'cancelled'].includes(runtime.status))
        .map((runtime) => transportOwner["event"]({
        kind: 'work-item-status-changed',
        workItemId: runtime.definition.id,
        status: 'cancelled',
        reason,
    }));
    events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'cancelled', reason }));
    return transportOwner["commit"](missionId, snapshot.revision, events);
}
