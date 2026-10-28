import { StructuredMissionVerdictSchema, WorkSubmissionSchema, type MissionEvent, type MissionAttemptTelemetry, type MissionSnapshot, type StructuredMissionVerdict, type WorkSubmission } from "@craft-agent/shared/missions";
import type { MissionController } from '../MissionController.ts';
import { TERMINAL_MISSION_STATUSES, runtimeItems, isExecution, isReview } from './shared.ts';
import type { MissionRuntimeLimitAttempt } from './shared.ts';

export function failMissionForRuntimeLimit(transportOwner: MissionController, missionId: string, reason: string, attempt?: MissionRuntimeLimitAttempt): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    if (TERMINAL_MISSION_STATUSES.has(snapshot.status)) {
        if (snapshot.status === 'failed')
            return snapshot;
        throw new Error(`Mission "${missionId}" is terminal`);
    }
    const events: MissionEvent[] = [];
    if (attempt) {
        const runtime = snapshot.workItems[attempt.workItemId];
        if (!runtime || (runtime.status !== 'reserved' && runtime.status !== 'running') ||
            runtime.dispatchId !== attempt.dispatchId) {
            throw new Error(`Runtime-limit telemetry does not match active work item "${attempt.workItemId}"`);
        }
        events.push(...transportOwner.telemetryEvent(attempt.workItemId, attempt.dispatchId, attempt.telemetry));
    }
    for (const runtime of runtimeItems(snapshot)) {
        if (['accepted', 'rejected', 'superseded', 'blocked', 'cancelled'].includes(runtime.status))
            continue;
        events.push(transportOwner["event"]({
            kind: 'work-item-status-changed',
            workItemId: runtime.definition.id,
            status: 'blocked',
            reason,
        }));
    }
    events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'failed', reason }));
    return transportOwner["commit"](missionId, snapshot.revision, events);
}

export function failWorkItemAttempt(transportOwner: MissionController, missionId: string, workItemId: string, dispatchId: string, failure: {
    reason: string;
    retryable: boolean;
    ambiguousMutation?: boolean;
    telemetry?: MissionAttemptTelemetry;
}): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || (runtime.status !== 'reserved' && runtime.status !== 'running') ||
        runtime.dispatchId !== dispatchId) {
        throw new Error(`Work item "${workItemId}" has no matching active dispatch`);
    }
    const ambiguousMutation = failure.ambiguousMutation ?? false;
    const canRetry = failure.retryable && !ambiguousMutation && runtime.definition.effect === 'read' &&
        runtime.attempt < snapshot.spec.policy.maxTechnicalAttempts;
    const events: MissionEvent[] = [
        ...transportOwner.telemetryEvent(workItemId, dispatchId, failure.telemetry),
        transportOwner["event"]({
            kind: 'work-item-attempt-failed',
            workItemId,
            dispatchId,
            reason: failure.reason,
            retryable: failure.retryable,
            ambiguousMutation,
        }),
    ];
    if (canRetry) {
        events.push(transportOwner["event"]({
            kind: 'work-item-status-changed', workItemId, status: 'pending', reason: failure.reason,
        }));
        const correcting = runtimeItems(snapshot).some((item) => item.definition.kind === 'correction' && !['accepted', 'superseded', 'cancelled'].includes(item.status));
        events.push(transportOwner["event"]({
            kind: 'mission-status-changed', status: correcting ? 'correcting' : 'running', reason: failure.reason,
        }));
    }
    else {
        events.push(transportOwner["event"]({
            kind: 'work-item-status-changed', workItemId, status: 'blocked', reason: failure.reason,
        }));
        events.push(transportOwner["event"]({
            kind: 'mission-status-changed', status: 'blocked',
            reason: ambiguousMutation
                ? `Mutation outcome is ambiguous for "${workItemId}": ${failure.reason}`
                : failure.reason,
        }));
    }
    transportOwner.preservePause(missionId, snapshot, events);
    return transportOwner["commit"](missionId, snapshot.revision, events);
}

export function submitWorkItem(transportOwner: MissionController, missionId: string, workItemId: string, sessionId: string, input: WorkSubmission, telemetry?: MissionAttemptTelemetry): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const runtime = snapshot.workItems[workItemId];
    if (!runtime || !isExecution(runtime.definition))
        throw new Error(`Work item "${workItemId}" is not executable work`);
    if (runtime.status !== 'running' || runtime.sessionId !== sessionId) {
        throw new Error(`Work item "${workItemId}" is not running in session "${sessionId}"`);
    }
    let submission = WorkSubmissionSchema.parse(input);
    const required = new Set(runtime.definition.requiredEvidence.map((requirement) => requirement.id));
    const supplied = new Set(submission.evidence.map((evidence) => evidence.requirementId));
    const missing = [...required].filter((id) => !supplied.has(id));
    if (missing.length > 0)
        throw new Error(`Missing required evidence: ${missing.join(', ')}`);
    if (transportOwner.resolveSubmissionEvidence) {
        submission = WorkSubmissionSchema.parse(transportOwner.resolveSubmissionEvidence(runtime.definition, submission));
    }
    const events: MissionEvent[] = [
        ...transportOwner.telemetryEvent(workItemId, runtime.dispatchId!, telemetry),
        transportOwner["event"]({ kind: 'work-item-submitted', workItemId, sessionId, submission }),
    ];
    transportOwner.addReadyReviews(missionId, events);
    transportOwner.preservePause(missionId, snapshot, events);
    return transportOwner["commit"](missionId, snapshot.revision, events);
}

export function recordVerdict(transportOwner: MissionController, missionId: string, reviewWorkItemId: string, sessionId: string, input: StructuredMissionVerdict, telemetry?: MissionAttemptTelemetry): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const review = snapshot.workItems[reviewWorkItemId];
    if (!review || !isReview(review.definition))
        throw new Error(`Work item "${reviewWorkItemId}" is not a review`);
    if (review.status !== 'running' || review.sessionId !== sessionId) {
        throw new Error(`Review "${reviewWorkItemId}" is not running in session "${sessionId}"`);
    }
    const verdict = StructuredMissionVerdictSchema.parse(input);
    transportOwner.assertVerdictContract(snapshot, review.definition, verdict);
    const events: MissionEvent[] = [
        ...transportOwner.telemetryEvent(reviewWorkItemId, review.dispatchId!, telemetry),
        transportOwner["event"]({ kind: 'verdict-recorded', workItemId: reviewWorkItemId, sessionId, verdict }),
    ];
    if (verdict.result === 'pass') {
        transportOwner.applyPass(missionId, snapshot, review.definition, events);
    }
    else if (verdict.result === 'inconclusive') {
        events.push(transportOwner["event"]({ kind: 'work-item-status-changed', workItemId: reviewWorkItemId, status: 'blocked', reason: verdict.summary }));
        if (review.definition.kind === 'objective-review') {
            events.push(transportOwner["event"]({ kind: 'work-item-status-changed', workItemId: verdict.targetId, status: 'blocked', reason: verdict.summary }));
        }
        events.push(transportOwner["event"]({ kind: 'mission-status-changed', status: 'blocked', reason: verdict.summary }));
    }
    else {
        transportOwner.applyFailure(missionId, snapshot, review.definition, verdict, events);
    }
    transportOwner.preservePause(missionId, snapshot, events);
    return transportOwner["commit"](missionId, snapshot.revision, events);
}
