import { SpecializedProfileRegistryRevisionConflictError, type SpecializedProfileEvaluation, type SpecializedProfileRegistryDocument } from "@craft-agent/shared/specialized-profiles";
import type { SpecializedProfileService } from '../SpecializedProfileService.ts';
import { requireProfile } from './definition.ts';

export async function reserveEvaluationMission(transportOwner: SpecializedProfileService, workspaceId: string, input: {
    profileId: string;
    stage: SpecializedProfileEvaluation['stage'];
    missionId: string;
    caseFingerprintSha256: string;
}): Promise<{
    campaignId: string;
    registry: SpecializedProfileRegistryDocument;
}> {
    const workspace = transportOwner["requireWorkspace"](workspaceId);
    const store = await transportOwner["storeFor"](workspace);
    const actorId = 'specialized-profile-evaluation-campaign-manager';
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await store.loadOrCreate(workspaceId, actorId);
        const profile = requireProfile(current, input.profileId);
        try {
            const reserved = await store.reserveEvaluationMission(current.revision, {
                profileId: input.profileId,
                expectedCurrentVersion: profile.currentVersion,
                stage: input.stage,
                missionId: input.missionId,
                caseFingerprintSha256: input.caseFingerprintSha256,
                actorId,
            });
            return { campaignId: reserved.campaign.id, registry: reserved.registry };
        }
        catch (error) {
            if (!(error instanceof SpecializedProfileRegistryRevisionConflictError) || attempt === 2)
                throw error;
        }
    }
    throw new Error('Could not reserve specialized evaluation campaign');
}

export async function releaseEvaluationMission(transportOwner: SpecializedProfileService, workspaceId: string, input: {
    profileId: string;
    missionId: string;
}): Promise<void> {
    const workspace = transportOwner["requireWorkspace"](workspaceId);
    const store = await transportOwner["storeFor"](workspace);
    const actorId = 'specialized-profile-evaluation-campaign-manager';
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await store.loadOrCreate(workspaceId, actorId);
        try {
            await store.releaseEvaluationMission(current.revision, { ...input, actorId });
            return;
        }
        catch (error) {
            if (!(error instanceof SpecializedProfileRegistryRevisionConflictError) || attempt === 2)
                throw error;
        }
    }
}
