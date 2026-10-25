import type { MissionSnapshot } from "@craft-agent/shared/missions";
import { detectSpecializationOpportunities, type SpecializedProfileAnalysisResult } from "@craft-agent/shared/specialized-profiles";
import { buildMissionSpecializationObservations } from "../mission-observations.ts";
import type { SpecializedProfileService } from '../SpecializedProfileService.ts';

export async function analyze(transportOwner: SpecializedProfileService, workspaceId: string): Promise<SpecializedProfileAnalysisResult> {
    transportOwner["requireWorkspace"](workspaceId);
    const snapshots = await transportOwner["options"].listMissions(workspaceId);
    const window = await transportOwner["verifiedAnalysisWindow"](workspaceId, snapshots);
    const observations = buildMissionSpecializationObservations(window.included);
    return {
        report: detectSpecializationOpportunities(observations.observations),
        analyzedMissionIds: observations.analyzedMissionIds,
        excludedMissionCount: observations.excludedMissionCount + window.excludedCount,
        generatedAt: transportOwner["now"]().toISOString(),
    };
}

export function analysisWindow(transportOwner: SpecializedProfileService, snapshots: readonly MissionSnapshot[]): {
    included: MissionSnapshot[];
    excludedCount: number;
} {
    const upperBound = transportOwner["now"]().getTime();
    const lowerBound = upperBound - transportOwner["lookbackDays"] * 86400000;
    const included = snapshots.filter((snapshot) => {
        const timestamp = Date.parse(snapshot.updatedAt);
        return Number.isFinite(timestamp) && timestamp >= lowerBound && timestamp <= upperBound;
    });
    return { included, excludedCount: snapshots.length - included.length };
}

export async function verifiedAnalysisWindow(transportOwner: SpecializedProfileService, workspaceId: string, snapshots: readonly MissionSnapshot[]): Promise<{
    included: MissionSnapshot[];
    excludedCount: number;
}> {
    const window = transportOwner["analysisWindow"](snapshots);
    if (!transportOwner["options"].missionEvidenceProvider) {
        throw new Error('Specialized profile analysis requires host-authenticated Mission evidence');
    }
    const included: MissionSnapshot[] = [];
    let excludedCount = window.excludedCount;
    for (const candidate of window.included) {
        if (!['completed', 'failed'].includes(candidate.status)) {
            excludedCount += 1;
            continue;
        }
        try {
            const verified = await transportOwner["options"].missionEvidenceProvider.loadVerified({
                workspaceId,
                missionId: candidate.spec.id,
            });
            if (verified.snapshot.spec.id !== candidate.spec.id
                || !['completed', 'failed'].includes(verified.snapshot.status)
                || transportOwner["analysisWindow"]([verified.snapshot]).included.length !== 1) {
                excludedCount += 1;
                continue;
            }
            included.push(verified.snapshot);
        }
        catch {
            excludedCount += 1;
        }
    }
    return { included, excludedCount };
}
