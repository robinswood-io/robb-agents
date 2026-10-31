import { type MissionSnapshot } from "@craft-agent/shared/missions";
import type { MissionController } from '../MissionController.ts';
import { runtimeItems, isExecution, isReview, profileFor, dependencySatisfied } from './shared.ts';
import type { ReadyMissionWork, MissionDispatchReservation } from './shared.ts';

export function waitForWorkItemApproval(transportOwner: MissionController, missionId: string, workItemId: string, dispatchId: string, reason: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || runtime.status !== 'running' || runtime.dispatchId !== dispatchId ||
        runtime.definition.effect !== 'external-mutation') {
        throw new Error(`Work item "${workItemId}" has no matching brokered mutation awaiting approval`);
    }
    if (snapshot.status === 'waiting-approval' && snapshot.statusReason === reason)
        return snapshot;
    return transportOwner["commit"](missionId, snapshot.revision, [
        transportOwner["event"]({ kind: 'mission-status-changed', status: 'waiting-approval', reason }),
    ]);
}

export function listReadyWork(transportOwner: MissionController, missionId: string): ReadyMissionWork[] {
    const snapshot = transportOwner["requireMission"](missionId);
    if (['draft', 'paused', 'blocked', 'waiting-approval', 'completed', 'failed', 'cancelled'].includes(snapshot.status))
        return [];
    const running = runtimeItems(snapshot).filter((item) => item.status === 'reserved' || item.status === 'running').length;
    const available = Math.max(0, snapshot.spec.policy.maxConcurrentAgents - running);
    return runtimeItems(snapshot)
        .filter((runtime) => runtime.status === 'pending' &&
        (isExecution(runtime.definition) || isReview(runtime.definition)) &&
        runtime.definition.dependsOn.every((id) => dependencySatisfied(snapshot, id)))
        .slice(0, available)
        .map((runtime) => ({ item: runtime.definition, agentProfileId: profileFor(snapshot, runtime.definition) }));
}

export function dispatchWorkItem(transportOwner: MissionController, missionId: string, workItemId: string, sessionId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const ready = transportOwner["listReadyWork"](missionId).find(({ item }) => item.id === workItemId);
    if (!ready)
        throw new Error(`Work item "${workItemId}" is not ready or concurrency is exhausted`);
    transportOwner["assertIndependentSession"](snapshot, ready.item, sessionId);
    const dispatchId = `manual-${workItemId}-${snapshot.workItems[workItemId]!.attempt + 1}`;
    return transportOwner["commit"](missionId, snapshot.revision, [
        transportOwner["event"]({
            kind: 'work-item-dispatch-reserved',
            workItemId,
            dispatchId,
            agentProfileId: ready.agentProfileId,
            binding: { executorKind: 'session', executionId: sessionId },
        }),
        transportOwner["event"]({
            kind: 'work-item-dispatched',
            workItemId,
            dispatchId,
            sessionId,
            agentProfileId: ready.agentProfileId,
        }),
    ]);
}

export function reserveWorkItem(transportOwner: MissionController, missionId: string, workItemId: string, reservation: MissionDispatchReservation): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const ready = transportOwner["listReadyWork"](missionId).find(({ item }) => item.id === workItemId);
    if (!ready)
        throw new Error(`Work item "${workItemId}" is not ready or concurrency is exhausted`);
    if (!reservation.dispatchId.trim())
        throw new Error('dispatchId is required');
    const binding = reservation.binding;
    if (runtimeItems(snapshot).some((runtime) => runtime.dispatchId === reservation.dispatchId ||
        runtime.executionBinding?.executionId === binding.executionId)) {
        throw new Error(`Mission dispatch or execution identity already exists for "${workItemId}"`);
    }
    transportOwner["assertIndependentSession"](snapshot, ready.item, binding.executionId);
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'work-item-dispatch-reserved',
            workItemId,
            dispatchId: reservation.dispatchId,
            agentProfileId: ready.agentProfileId,
            binding,
        })]);
}

export function confirmWorkItemDispatch(transportOwner: MissionController, missionId: string, workItemId: string, dispatchId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || runtime.status !== 'reserved' || runtime.dispatchId !== dispatchId ||
        !runtime.executionBinding || !runtime.agentProfileId) {
        throw new Error(`Work item "${workItemId}" has no matching dispatch reservation`);
    }
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'work-item-dispatched',
            workItemId,
            dispatchId,
            sessionId: runtime.executionBinding.executionId,
            agentProfileId: runtime.agentProfileId,
        })]);
}

export function bindWorkItemSession(transportOwner: MissionController, missionId: string, workItemId: string, dispatchId: string, sessionId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || (runtime.status !== 'reserved' && runtime.status !== 'running') ||
        runtime.dispatchId !== dispatchId) {
        throw new Error(`Work item "${workItemId}" has no matching active dispatch`);
    }
    if (runtime.externalSessionId === sessionId)
        return snapshot;
    if (runtime.externalSessionId) {
        throw new Error(`Work item "${workItemId}" is already bound to session "${runtime.externalSessionId}"`);
    }
    transportOwner["assertIndependentSession"](snapshot, runtime.definition, sessionId, true);
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'work-item-session-bound', workItemId, dispatchId, sessionId,
        })]);
}

export function recordWorkItemTurnAccepted(transportOwner: MissionController, missionId: string, workItemId: string, dispatchId: string, sessionId: string, messageId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || runtime.status !== 'running' || runtime.dispatchId !== dispatchId ||
        runtime.externalSessionId !== sessionId) {
        throw new Error(`Work item "${workItemId}" has no matching bound session turn`);
    }
    if (runtime.acceptedMessageId === messageId)
        return snapshot;
    if (runtime.acceptedMessageId) {
        throw new Error(`Work item "${workItemId}" already accepted message "${runtime.acceptedMessageId}"`);
    }
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'work-item-turn-accepted', workItemId, dispatchId, sessionId, messageId,
        })]);
}
