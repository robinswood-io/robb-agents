import { type MissionSnapshot } from "@craft-agent/shared/missions";
import type { MissionController } from '../MissionController.ts';

export function reserveMissionReport(transportOwner: MissionController, missionId: string, reportId: string, originSessionId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    if (snapshot.status !== 'completed')
        throw new Error(`Mission "${missionId}" is not completed`);
    if (snapshot.report) {
        if (snapshot.report.reportId === reportId && snapshot.report.originSessionId === originSessionId)
            return snapshot;
        throw new Error(`Mission "${missionId}" already has a report reservation`);
    }
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'mission-report-dispatch-reserved', reportId, originSessionId,
        })]);
}

export function recordMissionReportAccepted(transportOwner: MissionController, missionId: string, reportId: string, originSessionId: string, messageId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const report = snapshot.report;
    if (!report || report.reportId !== reportId || report.originSessionId !== originSessionId) {
        throw new Error(`Mission "${missionId}" has no matching report reservation`);
    }
    if (report.messageId === messageId)
        return snapshot;
    if (report.messageId)
        throw new Error(`Mission "${missionId}" report already accepted another message`);
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'mission-report-turn-accepted', reportId, originSessionId, messageId,
        })]);
}

export function recordMissionReportDelivered(transportOwner: MissionController, missionId: string, reportId: string, originSessionId: string, finalMessageId: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const report = snapshot.report;
    if (!report || report.reportId !== reportId || report.originSessionId !== originSessionId || !report.messageId) {
        throw new Error(`Mission "${missionId}" has no matching accepted report turn`);
    }
    if (report.status === 'delivered') {
        if (report.finalMessageId === finalMessageId)
            return snapshot;
        throw new Error(`Mission "${missionId}" report already delivered another message`);
    }
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'mission-report-delivered', reportId, originSessionId, finalMessageId,
        })]);
}

export function recordMissionReportFailed(transportOwner: MissionController, missionId: string, reportId: string, originSessionId: string, reason: string): MissionSnapshot {
    const snapshot = transportOwner["requireMission"](missionId);
    const report = snapshot.report;
    if (!report || report.reportId !== reportId || report.originSessionId !== originSessionId || report.status === 'delivered') {
        throw new Error(`Mission "${missionId}" has no matching undelivered report`);
    }
    return transportOwner["commit"](missionId, snapshot.revision, [transportOwner["event"]({
            kind: 'mission-report-failed', reportId, originSessionId, reason,
        })]);
}
