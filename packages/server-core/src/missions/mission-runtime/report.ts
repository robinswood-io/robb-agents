import { type MissionSnapshot } from "@craft-agent/shared/missions";
import type { ISessionManager } from "../../handlers/session-manager-interface.ts";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import { DEFAULT_REPORT_TIMEOUT_MS, normalizedError, findMessageContaining, findAssistantAfter, buildFinalReportPrompt } from './shared.ts';
import type { WorkspaceMissionRuntime } from './shared.ts';

export function scheduleReport(transportOwner: MissionRuntimeService, context: WorkspaceMissionRuntime, snapshot: MissionSnapshot): void {
    if (snapshot.status !== 'completed' || !snapshot.spec.originSessionId || snapshot.report?.status === 'delivered')
        return;
    const key = `${context.workspace.id}:${snapshot.spec.id}`;
    if (transportOwner["reportLoops"].has(key))
        return;
    const loop = transportOwner["deliverReport"](context, snapshot.spec.id)
        .catch((error: unknown) => transportOwner["reportError"]({
        workspaceId: context.workspace.id,
        missionId: snapshot.spec.id,
        error: normalizedError(error),
    }))
        .finally(() => transportOwner["reportLoops"].delete(key));
    transportOwner["reportLoops"].set(key, loop);
}

export async function deliverReport(transportOwner: MissionRuntimeService, context: WorkspaceMissionRuntime, missionId: string): Promise<void> {
    let snapshot = context.controller.getMission(missionId);
    const originSessionId = snapshot.spec.originSessionId;
    if (snapshot.status !== 'completed' || !originSessionId || snapshot.report?.status === 'delivered')
        return;
    const reportId = `mission-${missionId}-final-report`;
    if (!snapshot.report) {
        snapshot = context.controller.reserveMissionReport(missionId, reportId, originSessionId);
        transportOwner["options"].onSnapshot?.(context.workspace.id, snapshot);
    }
    const completion = transportOwner["waitForSessionCompletion"](originSessionId, transportOwner["options"].reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS);
    try {
        const origin = await transportOwner["options"].sessionManager.getSession(originSessionId);
        if (!origin || origin.workspaceId !== context.workspace.id) {
            completion.cancel();
            transportOwner["emitReportFailure"](context, missionId, reportId, originSessionId, 'Origin session is unavailable');
            return;
        }
        const marker = `<mission-final-report id="${reportId}" mission-id="${missionId}">`;
        const markerMessage = findMessageContaining(origin, marker, 'user');
        if (markerMessage) {
            if (!snapshot.report?.messageId) {
                snapshot = context.controller.recordMissionReportAccepted(missionId, reportId, originSessionId, markerMessage.id);
                transportOwner["options"].onSnapshot?.(context.workspace.id, snapshot);
            }
            const assistant = findAssistantAfter(origin, markerMessage.id);
            if (assistant) {
                completion.cancel();
                const delivered = context.controller.recordMissionReportDelivered(missionId, reportId, originSessionId, assistant.id);
                transportOwner["options"].onSnapshot?.(context.workspace.id, delivered);
                return;
            }
            if (!origin.isProcessing) {
                completion.cancel();
                transportOwner["emitReportFailure"](context, missionId, reportId, originSessionId, 'The report turn was durably accepted but has no assistant response');
                return;
            }
        }
        else {
            await transportOwner["options"].sessionManager.sendMessage(originSessionId, buildFinalReportPrompt(snapshot, marker), undefined, undefined, { hidden: true }, undefined, undefined, (messageId) => {
                const accepted = context.controller.recordMissionReportAccepted(missionId, reportId, originSessionId, messageId);
                transportOwner["options"].onSnapshot?.(context.workspace.id, accepted);
            });
        }
        const event = await completion.promise;
        if (event.reason !== 'complete') {
            transportOwner["emitReportFailure"](context, missionId, reportId, originSessionId, `Origin report turn ended with ${event.reason}`);
            return;
        }
        const refreshed = await transportOwner["options"].sessionManager.getSession(originSessionId);
        const acceptedMessageId = context.controller.getMission(missionId).report?.messageId;
        const assistant = refreshed && acceptedMessageId
            ? findAssistantAfter(refreshed, acceptedMessageId)
            : undefined;
        const finalMessageId = event.finalMessageId ?? assistant?.id;
        if (!finalMessageId) {
            transportOwner["emitReportFailure"](context, missionId, reportId, originSessionId, 'Origin report completed without a final message');
            return;
        }
        const delivered = context.controller.recordMissionReportDelivered(missionId, reportId, originSessionId, finalMessageId);
        transportOwner["options"].onSnapshot?.(context.workspace.id, delivered);
    }
    catch (error) {
        transportOwner["emitReportFailure"](context, missionId, reportId, originSessionId, `Could not deliver mission report: ${normalizedError(error).message}`);
    }
    finally {
        completion.cancel();
    }
}

export function emitReportFailure(transportOwner: MissionRuntimeService, context: WorkspaceMissionRuntime, missionId: string, reportId: string, originSessionId: string, reason: string): void {
    const current = context.controller.getMission(missionId);
    if (current.report?.status === 'delivered')
        return;
    const failed = context.controller.recordMissionReportFailed(missionId, reportId, originSessionId, reason);
    transportOwner["options"].onSnapshot?.(context.workspace.id, failed);
}

export function waitForSessionCompletion(transportOwner: MissionRuntimeService, sessionId: string, timeoutMs: number): {
    promise: Promise<Parameters<Parameters<ISessionManager['onSessionComplete']>[0]>[0]>;
    cancel: () => void;
} {
    let unsubscribe = () => { };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
        if (settled)
            return;
        settled = true;
        if (timer)
            clearTimeout(timer);
        unsubscribe();
    };
    const promise = new Promise<Parameters<Parameters<ISessionManager['onSessionComplete']>[0]>[0]>((resolve, reject) => {
        unsubscribe = transportOwner["options"].sessionManager.onSessionComplete((event) => {
            if (event.sessionId !== sessionId)
                return;
            cleanup();
            resolve(event);
        });
        timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Mission report timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();
    });
    return { promise, cancel: cleanup };
}
