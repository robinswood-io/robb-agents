import { detectSpecializationOpportunities, type CreateSpecializedProfileDraftRequest, type SpecializedProfileRegistryDocument, type SpecializedProfileRegistryMutationResult } from "@craft-agent/shared/specialized-profiles";
import { buildMissionSpecializationObservations } from "../mission-observations.ts";
import type { SpecializedProfileService } from '../SpecializedProfileService.ts';
import { buildCandidateInput, profileIdFor } from './definition.ts';

export async function getRegistry(transportOwner: SpecializedProfileService, workspaceId: string, actorId: string): Promise<SpecializedProfileRegistryDocument> {
    const workspace = transportOwner["requireWorkspace"](workspaceId);
    return (await transportOwner["storeFor"](workspace)).loadOrCreate(workspaceId, actorId);
}

export async function createDraft(transportOwner: SpecializedProfileService, workspaceId: string, actorId: string, request: CreateSpecializedProfileDraftRequest): Promise<SpecializedProfileRegistryMutationResult> {
    const workspace = transportOwner["requireWorkspace"](workspaceId);
    const snapshots = await transportOwner["options"].listMissions(workspaceId);
    const window = await transportOwner["verifiedAnalysisWindow"](workspaceId, snapshots);
    const observations = buildMissionSpecializationObservations(window.included);
    const report = detectSpecializationOpportunities(observations.observations);
    const proposal = report.proposals.find((candidate) => candidate.proposalId === request.proposalId);
    if (!proposal)
        throw new Error(`Unknown or no-longer-eligible specialization proposal "${request.proposalId}"`);
    if (proposal.category !== 'agent-profile') {
        throw new Error(`Proposal "${proposal.proposalId}" is a ${proposal.category}, not an agent profile`);
    }
    const profileId = profileIdFor(proposal.normalizedFamily);
    const store = await transportOwner["storeFor"](workspace);
    await store.loadOrCreate(workspaceId, actorId);
    const draft = await store.createDraft(request.expectedRegistryRevision, buildCandidateInput(profileId, request.proposalId, proposal, window.included, transportOwner["now"]()));
    return { registry: draft, profileId };
}
