import { type MissionEvent, type MissionSnapshot, type MissionWorkItem, type StructuredMissionVerdict } from "@craft-agent/shared/missions";
import type { MissionController } from '../MissionController.ts';
import { TERMINAL_MISSION_STATUSES, runtimeItems, isExecution, isReview, currentReplacement, currentObjectiveExecution, objectiveIds, objectiveForWork, uniqueId } from './shared.ts';

export function preservePause(transportOwner: MissionController, missionId: string, before: MissionSnapshot, events: MissionEvent[]): void {
    if (before.status !== 'paused')
        return;
    const projected = transportOwner["preview"](missionId, events);
    if (TERMINAL_MISSION_STATUSES.has(projected.status) ||
        projected.status === 'blocked' || projected.status === 'waiting-approval')
        return;
    events.push(transportOwner["event"]({
        kind: 'mission-status-changed',
        status: 'paused',
        reason: before.statusReason ?? 'Pause preserved after in-flight work settled',
    }));
}

export function assertIndependentSession(transportOwner: MissionController, snapshot: MissionSnapshot, item: MissionWorkItem, sessionId: string, external: boolean): void {
    if (!isReview(item))
        return;
    const forbidden = new Set<string>();
    if (snapshot.spec.originSessionId)
        forbidden.add(snapshot.spec.originSessionId);
    if (snapshot.spec.plannerSessionId)
        forbidden.add(snapshot.spec.plannerSessionId);
    for (const runtime of runtimeItems(snapshot)) {
        if (runtime.definition.id === item.id)
            continue;
        if (item.kind === 'final-review' ||
            (isExecution(runtime.definition) && runtime.definition.objectiveId === item.reviewTargetId)) {
            const history = external ? runtime.externalSessionHistory : runtime.executionHistory;
            for (const executionId of history)
                forbidden.add(executionId);
        }
    }
    if (forbidden.has(sessionId)) {
        throw new Error(`${item.kind} requires an independent session; "${sessionId}" already participated in scope`);
    }
}

export function assertVerdictContract(transportOwner: MissionController, snapshot: MissionSnapshot, review: MissionWorkItem, verdict: StructuredMissionVerdict): void {
    const final = review.kind === 'final-review';
    const expectedType = final ? 'mission' : 'objective';
    const expectedTarget = final ? snapshot.spec.id : review.reviewTargetId;
    if (verdict.targetType !== expectedType || verdict.targetId !== expectedTarget) {
        throw new Error(`Verdict target must be ${expectedType} "${expectedTarget}"`);
    }
    const rubric = final
        ? snapshot.spec.acceptanceCriteria
        : snapshot.workItems[expectedTarget!]?.definition.acceptanceCriteria;
    if (!rubric)
        throw new Error(`Unknown review target "${expectedTarget}"`);
    const expectedIds = new Set(rubric.map((criterion) => criterion.id));
    const actualIds = verdict.criteria.map((criterion) => criterion.criterionId);
    if (new Set(actualIds).size !== actualIds.length || actualIds.length !== expectedIds.size ||
        actualIds.some((id) => !expectedIds.has(id))) {
        throw new Error(`Verdict must cover each target criterion exactly once: ${[...expectedIds].join(', ')}`);
    }
    for (const affectedId of verdict.affectedWorkItemIds) {
        const affected = snapshot.workItems[affectedId];
        if (!affected || !isExecution(affected.definition) || affected.status === 'superseded') {
            throw new Error(`Affected work item "${affectedId}" is not current executable work`);
        }
        if (!final && affected.definition.objectiveId !== expectedTarget) {
            throw new Error(`Affected work item "${affectedId}" is outside objective "${expectedTarget}"`);
        }
    }
    const affectedSet = new Set(verdict.affectedWorkItemIds);
    for (const correction of verdict.corrections) {
        if (!affectedSet.has(correction.correctsWorkItemId)) {
            throw new Error(`Correction brief references unaffected work item "${correction.correctsWorkItemId}"`);
        }
        if (correction.agentProfileId) {
            const profile = snapshot.spec.agentProfiles.find(({ id }) => id === correction.agentProfileId);
            if (!profile || profile.role !== 'worker')
                throw new Error(`Correction profile "${correction.agentProfileId}" is not a worker`);
        }
    }
}

export function addReadyReviews(transportOwner: MissionController, missionId: string, events: MissionEvent[]): void {
    let snapshot = transportOwner["preview"](missionId, events);
    const reserved = new Set<string>();
    let addedObjectiveReview = false;
    for (const objectiveId of objectiveIds(snapshot)) {
        const objective = snapshot.workItems[objectiveId];
        if (objective.status === 'accepted' || objective.status === 'blocked')
            continue;
        const frontier = currentObjectiveExecution(snapshot, objectiveId);
        if (frontier.length === 0 || frontier.some((item) => item.status !== 'submitted' && item.status !== 'accepted'))
            continue;
        const cycle = snapshot.correctionCycles[objectiveId] ?? 0;
        const expectedBase = `review-${objectiveId}-${cycle}`;
        if (runtimeItems(snapshot).some((item) => item.definition.kind === 'objective-review' && item.definition.id.startsWith(expectedBase)))
            continue;
        if (runtimeItems(snapshot).length + 1 > snapshot.spec.policy.maxWorkItems) {
            events.push(transportOwner["event"]({
                kind: 'mission-status-changed', status: 'failed',
                reason: 'Mission maxWorkItems exceeded by objective review',
            }));
            return;
        }
        const item: MissionWorkItem = {
            id: uniqueId(snapshot, expectedBase, reserved),
            kind: 'objective-review',
            title: `Contrôle de l'objectif : ${objective.definition.title}`,
            prompt: `Évaluer indépendamment l'objectif "${objective.definition.title}" et rendre un verdict structuré fondé sur les preuves.`,
            parentId: objectiveId,
            objectiveId,
            dependsOn: frontier.map((candidate) => candidate.definition.id),
            reviewTargetId: objectiveId,
            acceptanceCriteria: objective.definition.acceptanceCriteria,
            requiredEvidence: [],
            agentProfileId: snapshot.spec.reviewerProfileId,
            effect: 'read',
        };
        events.push(transportOwner["event"]({ kind: 'work-item-added', item }));
        addedObjectiveReview = true;
        snapshot = transportOwner["preview"](missionId, events);
    }
    if (addedObjectiveReview) {
        events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'objective-review' }));
    }
}

export function applyPass(transportOwner: MissionController, missionId: string, before: MissionSnapshot, review: MissionWorkItem, events: MissionEvent[]): void {
    events.push(transportOwner["event"]({ kind: 'work-item-status-changed', workItemId: review.id, status: 'accepted' }));
    if (review.kind === 'final-review') {
        events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'completed' }));
        return;
    }
    const objectiveId = review.reviewTargetId!;
    for (const runtime of currentObjectiveExecution(before, objectiveId)) {
        if (runtime.status === 'submitted') {
            events.push(transportOwner["event"]({ kind: 'work-item-status-changed', workItemId: runtime.definition.id, status: 'accepted' }));
        }
    }
    events.push(transportOwner["event"]({ kind: 'work-item-status-changed', workItemId: objectiveId, status: 'accepted' }));
    const snapshot = transportOwner["preview"](missionId, events);
    if (objectiveIds(snapshot).every((id) => snapshot.workItems[id]?.status === 'accepted')) {
        transportOwner["addFinalReview"](missionId, events);
    }
    else {
        events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'running' }));
    }
}

export function addFinalReview(transportOwner: MissionController, missionId: string, events: MissionEvent[]): void {
    const snapshot = transportOwner["preview"](missionId, events);
    if (runtimeItems(snapshot).length + 1 > snapshot.spec.policy.maxWorkItems) {
        events.push(transportOwner["event"]({
            kind: 'mission-status-changed', status: 'failed',
            reason: 'Mission maxWorkItems exceeded by final review',
        }));
        return;
    }
    const count = runtimeItems(snapshot).filter((runtime) => runtime.definition.kind === 'final-review').length;
    const item: MissionWorkItem = {
        id: uniqueId(snapshot, `final-review-${count}`, new Set()),
        kind: 'final-review',
        title: `Supervision finale : ${snapshot.spec.title}`,
        prompt: 'Contrôler indépendamment la mission complète, ses preuves et ses critères, puis rendre un verdict structuré.',
        dependsOn: objectiveIds(snapshot),
        reviewTargetId: snapshot.spec.id,
        acceptanceCriteria: snapshot.spec.acceptanceCriteria,
        requiredEvidence: [],
        agentProfileId: snapshot.spec.supervisorProfileId,
        effect: 'read',
    };
    events.push(transportOwner["event"]({ kind: 'work-item-added', item }));
    events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'final-review' }));
}

export function applyFailure(transportOwner: MissionController, missionId: string, before: MissionSnapshot, review: MissionWorkItem, verdict: StructuredMissionVerdict, events: MissionEvent[]): void {
    events.push(transportOwner["event"]({
        kind: 'work-item-status-changed', workItemId: review.id, status: 'rejected', reason: verdict.summary,
    }));
    const affected = transportOwner["expandAffectedFrontier"](before, verdict.affectedWorkItemIds);
    const affectedObjectives = new Set(affected.map((id) => objectiveForWork(before, id)));
    const cycles = new Map<string, number>();
    for (const objectiveId of affectedObjectives) {
        const cycle = (before.correctionCycles[objectiveId] ?? 0) + 1;
        if (cycle > before.spec.policy.maxCorrectionCycles) {
            events.push(transportOwner["event"]({
                kind: 'mission-status-changed', status: 'failed',
                reason: `Correction limit exceeded for objective "${objectiveId}"`,
            }));
            return;
        }
        cycles.set(objectiveId, cycle);
        events.push(transportOwner["event"]({ kind: 'correction-cycle-started', objectiveId, cycle }));
        events.push(transportOwner["event"]({ kind: 'work-item-status-changed', workItemId: objectiveId, status: 'rejected', reason: verdict.summary }));
    }
    if (runtimeItems(before).length + affected.length > before.spec.policy.maxWorkItems) {
        events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'failed', reason: 'Mission maxWorkItems exceeded by corrections' }));
        return;
    }
    const reserved = new Set<string>();
    const replacements = new Map<string, string>();
    for (const id of affected) {
        const cycle = cycles.get(objectiveForWork(before, id))!;
        replacements.set(id, uniqueId(before, `${id}-fix-${cycle}`, reserved));
    }
    const briefs = new Map(verdict.corrections.map((brief) => [brief.correctsWorkItemId, brief]));
    for (const id of affected) {
        events.push(transportOwner["event"]({ kind: 'work-item-status-changed', workItemId: id, status: 'superseded', reason: verdict.summary }));
        const original = before.workItems[id]!.definition;
        const brief = briefs.get(id);
        const item: MissionWorkItem = {
            ...original,
            id: replacements.get(id)!,
            kind: 'correction',
            title: brief?.title ?? `Correction : ${original.title}`,
            prompt: brief?.prompt ?? `Corriger le travail "${original.title}" après ce rejet : ${verdict.summary}\n\nConsigne initiale : ${original.prompt ?? original.title}`,
            dependsOn: original.dependsOn.map((dependency) => replacements.get(dependency) ?? currentReplacement(before, dependency).definition.id),
            correctsWorkItemId: id,
            reviewTargetId: undefined,
            acceptanceCriteria: brief?.acceptanceCriteria ?? original.acceptanceCriteria,
            agentProfileId: brief?.agentProfileId ?? original.agentProfileId ?? before.spec.defaultWorkerProfileId,
        };
        events.push(transportOwner["event"]({ kind: 'work-item-added', item }));
    }
    events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'correcting', reason: verdict.summary }));
}

export function expandAffectedFrontier(transportOwner: MissionController, snapshot: MissionSnapshot, initial: readonly string[]): string[] {
    const affected = new Set(initial);
    let changed = true;
    while (changed) {
        changed = false;
        for (const runtime of runtimeItems(snapshot)) {
            if (!isExecution(runtime.definition) || runtime.status === 'superseded' || affected.has(runtime.definition.id))
                continue;
            if (runtime.definition.dependsOn.some((dependency) => affected.has(currentReplacement(snapshot, dependency).definition.id))) {
                affected.add(runtime.definition.id);
                changed = true;
            }
        }
    }
    return runtimeItems(snapshot)
        .map((runtime) => runtime.definition.id)
        .filter((id) => affected.has(id));
}
