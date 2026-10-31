import { MissionSpecSchema, listMissionIds, loadMissionSnapshot, type MissionSnapshot, type MissionSpec } from "@craft-agent/shared/missions";
import { missionCorpusFingerprint } from "../../specialized-profiles/SpecializedProfileService.ts";
import type { SpecializedProfileEvaluation } from "@craft-agent/shared/specialized-profiles";
import { parseSpecializedMissionProfileReference } from "@craft-agent/shared/specialized-profiles";
import type { MissionRuntimeService } from '../MissionRuntimeService.ts';
import { normalizedError, missionSpecsMatchIgnoringSpecializedPrompt } from './shared.ts';

export function start(transportOwner: MissionRuntimeService): Promise<string[]> {
    if (transportOwner.startPromise)
        return transportOwner.startPromise;
    transportOwner.startPromise = transportOwner.startInternal();
    return transportOwner.startPromise;
}

export async function startInternal(transportOwner: MissionRuntimeService): Promise<string[]> {
    await transportOwner["options"].sessionManager.waitForInit();
    const recovered: string[] = [];
    for (const workspace of transportOwner.listWorkspaces()) {
        try {
            const missionIds = listMissionIds(workspace.rootPath);
            if (missionIds.length === 0)
                continue;
            const context = await transportOwner["contextFor"](workspace.id);
            const admittedMissionIds = new Set<string>();
            for (const missionId of missionIds) {
                const snapshot = context.controller.getMission(missionId);
                try {
                    await context.specializedProfiles.revalidateMissionSpec(snapshot.spec);
                    transportOwner.assertAdmissible(workspace, snapshot.spec);
                    admittedMissionIds.add(missionId);
                }
                catch (error) {
                    const reason = `Mission revalidation failed closed: ${normalizedError(error).message}`;
                    if (!['paused', 'blocked', 'completed', 'failed', 'cancelled'].includes(snapshot.status)) {
                        const paused = context.controller.pauseMission(missionId, reason);
                        transportOwner["options"].onSnapshot?.(workspace.id, paused);
                    }
                    transportOwner["reportError"]({
                        workspaceId: workspace.id,
                        missionId,
                        error: normalizedError(error),
                    });
                }
            }
            recovered.push(...context.runtime.recoverNonTerminalMissions(admittedMissionIds)
                .map((missionId) => `${workspace.id}:${missionId}`));
            for (const missionId of missionIds) {
                if (!admittedMissionIds.has(missionId))
                    continue;
                let snapshot = context.controller.getMission(missionId);
                if (snapshot.status === 'waiting-approval' && context.connectorExecutor) {
                    const hasDurablyResolvedApproval = Object.values(snapshot.workItems).some((runtime) => runtime.status === 'running'
                        && runtime.definition.effect === 'external-mutation'
                        && (context.connectorExecutor!.resolvedApproval(missionId, runtime.definition.id) !== null
                            || context.connectorExecutor!.approvalExpired(missionId, runtime.definition.id)));
                    if (hasDurablyResolvedApproval) {
                        snapshot = context.controller.resumeAfterApproval(missionId);
                        transportOwner["options"].onSnapshot?.(workspace.id, snapshot);
                        context.runtime.startMission(missionId);
                        recovered.push(`${workspace.id}:${missionId}`);
                    }
                }
                if (transportOwner.ensureCompletionPassport(context, snapshot))
                    transportOwner.scheduleReport(context, snapshot);
            }
        }
        catch (error) {
            transportOwner["reportError"]({ workspaceId: workspace.id, error: normalizedError(error) });
        }
    }
    return recovered;
}

export async function createAndStart(transportOwner: MissionRuntimeService, workspaceId: string, input: MissionSpec): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    const parsed = MissionSpecSchema.parse(input);
    const spec = await context.specializedProfiles.bindMissionSpec(parsed);
    transportOwner.assertAdmissible(context.workspace, spec);
    if (spec.originSessionId) {
        const origin = transportOwner["options"].sessionManager.getSessions(context.workspace.id)
            .find((session) => session.id === spec.originSessionId);
        if (!origin)
            throw new Error(`Origin session "${spec.originSessionId}" does not belong to workspace "${workspaceId}"`);
    }
    context.controller.createMission(spec);
    return context.runtime.startMission(spec.id);
}

export async function createAndStartSpecializedEvaluation(transportOwner: MissionRuntimeService, workspaceId: string, input: MissionSpec, target: {
    profileId: string;
    stage: SpecializedProfileEvaluation['stage'];
}): Promise<MissionSnapshot> {
    await transportOwner["start"]();
    const context = await transportOwner["contextFor"](workspaceId);
    const parsed = MissionSpecSchema.parse(input);
    const foundry = await transportOwner["getSpecializedProfileFoundry"](workspaceId);
    const existingBeforeReservation = loadMissionSnapshot(context.workspace.rootPath, parsed.id);
    if (existingBeforeReservation) {
        const existingProfile = existingBeforeReservation.spec.agentProfiles
            .find(({ id }) => id === target.profileId);
        const reference = existingProfile
            ? parseSpecializedMissionProfileReference(existingProfile.systemPrompt)
            : null;
        if (!reference
            || reference.profileId !== target.profileId
            || reference.evaluationStage !== target.stage
            || !reference.evaluationCohortId
            || !missionSpecsMatchIgnoringSpecializedPrompt(parsed, existingBeforeReservation.spec, target.profileId)) {
            throw new Error(`Evaluation Mission "${parsed.id}" already exists with another specification`);
        }
        await context.specializedProfiles.revalidateMissionSpec(existingBeforeReservation.spec);
        return context.runtime.startMission(parsed.id);
    }
    const reservation = await foundry.reserveEvaluationMission(workspaceId, {
        profileId: target.profileId,
        stage: target.stage,
        missionId: parsed.id,
        caseFingerprintSha256: missionCorpusFingerprint({ spec: parsed }),
    });
    let created = false;
    try {
        const spec = await context.specializedProfiles.bindEvaluationMissionSpec(parsed, target.profileId, target.stage, reservation.campaignId);
        transportOwner.assertAdmissible(context.workspace, spec);
        const assigned = spec.workItems.some((item) => {
            if (item.agentProfileId)
                return item.agentProfileId === target.profileId;
            return ['task', 'subtask', 'integration', 'correction'].includes(item.kind)
                && spec.defaultWorkerProfileId === target.profileId;
        });
        if (!assigned) {
            throw new Error(`Specialized evaluation Mission must assign executable work to "${target.profileId}"`);
        }
        const existing = loadMissionSnapshot(context.workspace.rootPath, spec.id);
        if (existing) {
            if (JSON.stringify(existing.spec) !== JSON.stringify(spec)) {
                throw new Error(`Evaluation Mission "${spec.id}" already exists with another bound specification`);
            }
            return context.runtime.startMission(spec.id);
        }
        context.controller.createMission(spec);
        created = true;
        return context.runtime.startMission(spec.id);
    }
    catch (error) {
        if (!created && !loadMissionSnapshot(context.workspace.rootPath, parsed.id)) {
            await foundry.releaseEvaluationMission(workspaceId, {
                profileId: target.profileId,
                missionId: parsed.id,
            });
        }
        throw error;
    }
}
