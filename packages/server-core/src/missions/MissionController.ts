import { MissionEventSchema, loadMissionSnapshot, readMissionEvents, reduceMissionEvents, type MissionEvent, type MissionAttemptTelemetry, type MissionSnapshot, type MissionSpec, type MissionWorkItem, type StructuredMissionVerdict, type WorkSubmission, type MissionReplanPreview } from "@craft-agent/shared/missions";
import type { MissionControllerOptions, ReadyMissionWork, MissionDispatchReservation, MissionReplanInput, MissionRuntimeLimitAttempt } from './mission-controller/shared.ts';
import * as missionControllerWorkflow from './mission-controller/workflow.ts';
import * as missionControllerDispatch from './mission-controller/dispatch.ts';
import * as missionControllerReport from './mission-controller/report.ts';
import * as missionControllerResults from './mission-controller/results.ts';
import * as missionControllerReview from './mission-controller/review.ts';
export type { MissionControllerOptions, ReadyMissionWork, MissionDispatchReservation, MissionReplanInput, MissionRuntimeLimitAttempt } from './mission-controller/shared.ts';
export { previewAdmissibleMissionReplan } from './mission-controller/shared.ts';

export class MissionController {
    private readonly workspaceRoot: string;
    private readonly now: () => Date;
    /** @internal */ public readonly resolveSubmissionEvidence?: MissionControllerOptions['resolveSubmissionEvidence'];
    constructor(options: MissionControllerOptions) {
        this.workspaceRoot = options.workspaceRoot;
        this.now = options.now ?? (() => new Date());
        this.resolveSubmissionEvidence = options.resolveSubmissionEvidence;
    }
    private at(): string {
        return this.now().toISOString();
    }
    private event<T extends Omit<MissionEvent, 'at'>>(event: T): MissionEvent {
        return MissionEventSchema.parse({ ...event, at: this.at() });
    }
    /** @internal */ public telemetryEvent(workItemId: string, dispatchId: string, telemetry?: MissionAttemptTelemetry): MissionEvent[] {
        return telemetry
            ? [this.event({ kind: 'work-item-attempt-metered', workItemId, dispatchId, telemetry })]
            : [];
    }
    private requireMission(missionId: string): MissionSnapshot {
        const snapshot = loadMissionSnapshot(this.workspaceRoot, missionId);
        if (!snapshot)
            throw new Error(`Unknown mission "${missionId}"`);
        return snapshot;
    }
    /** @internal */ public preview(missionId: string, events: readonly MissionEvent[]): MissionSnapshot {
        return reduceMissionEvents([...readMissionEvents(this.workspaceRoot, missionId), ...events]);
    }
    private commit(missionId: string, revision: number, events: readonly MissionEvent[]): MissionSnapshot {
        return missionControllerWorkflow.commit(this, missionId, revision, events);
    }
    createMission(input: MissionSpec): MissionSnapshot {
        return missionControllerWorkflow.createMission(this, input);
    }
    getMission(missionId: string): MissionSnapshot {
        return this.requireMission(missionId);
    }
    previewReplan(missionId: string, expectedRevision: number, proposedWorkItems: MissionWorkItem[]): MissionReplanPreview {
        return missionControllerWorkflow.previewReplan(this, missionId, expectedRevision, proposedWorkItems);
    }
    replanMission(missionId: string, input: MissionReplanInput): MissionSnapshot {
        return missionControllerWorkflow.replanMission(this, missionId, input);
    }
    startMission(missionId: string): MissionSnapshot {
        return missionControllerWorkflow.startMission(this, missionId);
    }
    pauseMission(missionId: string, reason: string): MissionSnapshot {
        return missionControllerWorkflow.pauseMission(this, missionId, reason);
    }
    waitForWorkItemApproval(missionId: string, workItemId: string, dispatchId: string, reason: string): MissionSnapshot {
        return missionControllerDispatch.waitForWorkItemApproval(this, missionId, workItemId, dispatchId, reason);
    }
    resumeAfterApproval(missionId: string): MissionSnapshot {
        return missionControllerWorkflow.resumeAfterApproval(this, missionId);
    }
    listReadyWork(missionId: string): ReadyMissionWork[] {
        return missionControllerDispatch.listReadyWork(this, missionId);
    }
    dispatchWorkItem(missionId: string, workItemId: string, sessionId: string): MissionSnapshot {
        return missionControllerDispatch.dispatchWorkItem(this, missionId, workItemId, sessionId);
    }
    reserveWorkItem(missionId: string, workItemId: string, reservation: MissionDispatchReservation): MissionSnapshot {
        return missionControllerDispatch.reserveWorkItem(this, missionId, workItemId, reservation);
    }
    confirmWorkItemDispatch(missionId: string, workItemId: string, dispatchId: string): MissionSnapshot {
        return missionControllerDispatch.confirmWorkItemDispatch(this, missionId, workItemId, dispatchId);
    }
    bindWorkItemSession(missionId: string, workItemId: string, dispatchId: string, sessionId: string): MissionSnapshot {
        return missionControllerDispatch.bindWorkItemSession(this, missionId, workItemId, dispatchId, sessionId);
    }
    recordWorkItemTurnAccepted(missionId: string, workItemId: string, dispatchId: string, sessionId: string, messageId: string): MissionSnapshot {
        return missionControllerDispatch.recordWorkItemTurnAccepted(this, missionId, workItemId, dispatchId, sessionId, messageId);
    }
    cancelMission(missionId: string, reason: string): MissionSnapshot {
        return missionControllerWorkflow.cancelMission(this, missionId, reason);
    }
    /**
     * Fail closed on a host-observed runtime limit while preserving the measured
     * cost of the attempt that crossed it. Unfinished work is blocked atomically,
     * so a late executor result cannot resurrect or advance the mission.
     */
    failMissionForRuntimeLimit(missionId: string, reason: string, attempt?: MissionRuntimeLimitAttempt): MissionSnapshot {
        return missionControllerResults.failMissionForRuntimeLimit(this, missionId, reason, attempt);
    }
    reserveMissionReport(missionId: string, reportId: string, originSessionId: string): MissionSnapshot {
        return missionControllerReport.reserveMissionReport(this, missionId, reportId, originSessionId);
    }
    recordMissionReportAccepted(missionId: string, reportId: string, originSessionId: string, messageId: string): MissionSnapshot {
        return missionControllerReport.recordMissionReportAccepted(this, missionId, reportId, originSessionId, messageId);
    }
    recordMissionReportDelivered(missionId: string, reportId: string, originSessionId: string, finalMessageId: string): MissionSnapshot {
        return missionControllerReport.recordMissionReportDelivered(this, missionId, reportId, originSessionId, finalMessageId);
    }
    recordMissionReportFailed(missionId: string, reportId: string, originSessionId: string, reason: string): MissionSnapshot {
        return missionControllerReport.recordMissionReportFailed(this, missionId, reportId, originSessionId, reason);
    }
    failWorkItemAttempt(missionId: string, workItemId: string, dispatchId: string, failure: {
        reason: string;
        retryable: boolean;
        ambiguousMutation?: boolean;
        telemetry?: MissionAttemptTelemetry;
    }): MissionSnapshot {
        return missionControllerResults.failWorkItemAttempt(this, missionId, workItemId, dispatchId, failure);
    }
    submitWorkItem(missionId: string, workItemId: string, sessionId: string, input: WorkSubmission, telemetry?: MissionAttemptTelemetry): MissionSnapshot {
        return missionControllerResults.submitWorkItem(this, missionId, workItemId, sessionId, input, telemetry);
    }
    recordVerdict(missionId: string, reviewWorkItemId: string, sessionId: string, input: StructuredMissionVerdict, telemetry?: MissionAttemptTelemetry): MissionSnapshot {
        return missionControllerResults.recordVerdict(this, missionId, reviewWorkItemId, sessionId, input, telemetry);
    }
    /** @internal */ public preservePause(missionId: string, before: MissionSnapshot, events: MissionEvent[]): void {
        return missionControllerReview.preservePause(this, missionId, before, events);
    }
    private assertIndependentSession(snapshot: MissionSnapshot, item: MissionWorkItem, sessionId: string, external = false): void {
        return missionControllerReview.assertIndependentSession(this, snapshot, item, sessionId, external);
    }
    /** @internal */ public assertVerdictContract(snapshot: MissionSnapshot, review: MissionWorkItem, verdict: StructuredMissionVerdict): void {
        return missionControllerReview.assertVerdictContract(this, snapshot, review, verdict);
    }
    /** @internal */ public addReadyReviews(missionId: string, events: MissionEvent[]): void {
        return missionControllerReview.addReadyReviews(this, missionId, events);
    }
    /** @internal */ public applyPass(missionId: string, before: MissionSnapshot, review: MissionWorkItem, events: MissionEvent[]): void {
        return missionControllerReview.applyPass(this, missionId, before, review, events);
    }
    /** @internal */ public addFinalReview(missionId: string, events: MissionEvent[]): void {
        return missionControllerReview.addFinalReview(this, missionId, events);
    }
    /** @internal */ public applyFailure(missionId: string, before: MissionSnapshot, review: MissionWorkItem, verdict: StructuredMissionVerdict, events: MissionEvent[]): void {
        return missionControllerReview.applyFailure(this, missionId, before, review, verdict, events);
    }
    /** @internal */ public expandAffectedFrontier(snapshot: MissionSnapshot, initial: readonly string[]): string[] {
        return missionControllerReview.expandAffectedFrontier(this, snapshot, initial);
    }
}
