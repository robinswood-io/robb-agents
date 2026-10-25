import { randomUUID } from "node:crypto";
import { SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE, SpecializedProfileEvaluationSchema, type SpecializedProfileEvaluation, type SpecializedProfileEvaluationCampaign, type SpecializedProfileRegistryDocument } from "../schema.ts";
import type { SpecializedProfileRegistryStore } from '../registry-store.ts';
import { SpecializedProfileRegistryRevisionConflictError, SpecializedProfileTransitionGateError, requireProfile, assertProfileVersion } from './shared.ts';

export async function recordEvaluation(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, actorId: string, value: SpecializedProfileEvaluation): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["update"](expectedRevision, actorId, (document, occurredAt) => {
        const evaluation = SpecializedProfileEvaluationSchema.parse(value);
        const profile = requireProfile(document, evaluation.profileId);
        const version = profile.versions[evaluation.profileVersion - 1];
        if (!version) {
            throw new Error(`Specialized profile "${profile.id}" version ${evaluation.profileVersion} does not exist`);
        }
        if (profile.evaluations.some((entry) => entry.id === evaluation.id)) {
            throw new Error(`Specialized profile evaluation "${evaluation.id}" already exists`);
        }
        if (profile.evaluations.some((entry) => entry.runId === evaluation.runId)) {
            throw new Error(`Specialized profile evaluation run "${evaluation.runId}" already exists`);
        }
        if (actorId !== evaluation.evaluator.actorId) {
            throw new Error('Evaluation actor must match the host-authenticated evaluator');
        }
        if ([version.provenance.proposedBy.actorId, version.createdBy].includes(evaluation.evaluator.actorId)) {
            throw new Error('Specialized profile evaluation must be independent from the version proposer and creator');
        }
        const expectedState = SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[evaluation.stage];
        const stageEntry = profile.transitions[evaluation.stageEntryTransitionSequence - 1];
        if (profile.currentState !== expectedState
            || !stageEntry
            || stageEntry.sequence !== evaluation.stageEntryTransitionSequence
            || stageEntry.profileVersion !== evaluation.profileVersion
            || stageEntry.to !== expectedState
            || profile.transitions.at(-1)?.sequence !== stageEntry.sequence) {
            throw new SpecializedProfileTransitionGateError(`Evaluation stage ${evaluation.stage} must be recorded during the exact current ${expectedState} lifecycle entry`);
        }
        if (Date.parse(evaluation.startedAt) < Date.parse(stageEntry.occurredAt)) {
            throw new SpecializedProfileTransitionGateError(`Evaluation stage ${evaluation.stage} started before entry into ${expectedState}`);
        }
        if (!transportOwner["authority"]?.verifyEvaluation({ evaluation, version })) {
            throw new SpecializedProfileTransitionGateError(`Evaluation "${evaluation.id}" lacks a valid host authority attestation`);
        }
        if (Date.parse(evaluation.completedAt) > transportOwner["now"]().getTime()) {
            throw new Error('Specialized profile evaluation completion cannot be in the future');
        }
        const campaign = (profile.evaluationCampaigns ?? []).find((candidate) => candidate.id === evaluation.cohort.id);
        if (!campaign
            || campaign.state !== 'closed'
            || campaign.evaluationId !== undefined
            || campaign.profileVersion !== evaluation.profileVersion
            || campaign.stage !== evaluation.stage
            || campaign.stageEntryTransitionSequence !== evaluation.stageEntryTransitionSequence
            || campaign.missionIds.length !== evaluation.cohort.missionIds.length
            || campaign.missionIds.some((id, index) => id !== evaluation.cohort.missionIds[index])) {
            throw new SpecializedProfileTransitionGateError(`Evaluation "${evaluation.id}" is not bound to one exact closed host campaign`);
        }
        profile.evaluations.push(evaluation);
        campaign.evaluationId = evaluation.id;
        profile.updatedAt = occurredAt;
    });
}

export async function reserveEvaluationMission(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: {
    profileId: string;
    expectedCurrentVersion: number;
    stage: SpecializedProfileEvaluation['stage'];
    missionId: string;
    caseFingerprintSha256: string;
    actorId: string;
}): Promise<{
    registry: SpecializedProfileRegistryDocument;
    campaign: SpecializedProfileEvaluationCampaign;
}> {
    return transportOwner["withLock"](async () => {
        const current = await transportOwner["loadDocument"](true);
        if (!current)
            throw new Error(`Specialized profile registry does not exist for workspace "${transportOwner["workspaceRoot"]}"`);
        const currentProfile = requireProfile(current, input.profileId);
        assertProfileVersion(currentProfile, input.expectedCurrentVersion);
        const existing = (currentProfile.evaluationCampaigns ?? []).find((campaign) => campaign.missionIds.includes(input.missionId));
        if (existing) {
            if (existing.state !== 'open'
                || existing.profileVersion !== currentProfile.currentVersion
                || existing.stage !== input.stage
                || existing.stageEntryTransitionSequence !== currentProfile.transitions.at(-1)?.sequence) {
                throw new SpecializedProfileTransitionGateError(`Evaluation Mission "${input.missionId}" is already bound to another or closed campaign`);
            }
            if (existing.caseFingerprints?.[input.missionId] !== input.caseFingerprintSha256) {
                throw new SpecializedProfileTransitionGateError(`Evaluation Mission "${input.missionId}" changed after host case reservation`);
            }
            return { registry: current, campaign: structuredClone(existing) };
        }
        if (current.revision !== expectedRevision) {
            throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
        }
        const expectedState = SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[input.stage];
        const stageEntry = currentProfile.transitions.at(-1)!;
        if (currentProfile.currentState !== expectedState || stageEntry.to !== expectedState) {
            throw new SpecializedProfileTransitionGateError(`Evaluation stage ${input.stage} requires current lifecycle state ${expectedState}`);
        }
        const next = structuredClone(current);
        const profile = requireProfile(next, input.profileId);
        const campaigns = profile.evaluationCampaigns ??= [];
        let campaign = campaigns.find((candidate) => candidate.state === 'open'
            && candidate.profileVersion === profile.currentVersion
            && candidate.stage === input.stage
            && candidate.stageEntryTransitionSequence === stageEntry.sequence);
        const occurredAt = transportOwner["now"]().toISOString();
        if (!campaign) {
            campaign = {
                schemaVersion: 1,
                id: `profile-evaluation-campaign-${randomUUID()}`,
                profileVersion: profile.currentVersion,
                stage: input.stage,
                stageEntryTransitionSequence: stageEntry.sequence,
                state: 'open',
                missionIds: [],
                caseFingerprints: {},
                createdAt: occurredAt,
            };
            campaigns.push(campaign);
        }
        if (campaign.missionIds.length >= 499) {
            throw new SpecializedProfileTransitionGateError('Specialized profile evaluation campaign is full');
        }
        campaign.missionIds.push(input.missionId);
        campaign.missionIds.sort();
        campaign.caseFingerprints ??= {};
        campaign.caseFingerprints[input.missionId] = input.caseFingerprintSha256;
        profile.updatedAt = occurredAt;
        next.revision += 1;
        next.updatedAt = occurredAt;
        next.updatedBy = input.actorId;
        const sealed = transportOwner["sealDocument"](next, current.head.documentSha256);
        await transportOwner["writeDocument"](sealed, current);
        return {
            registry: sealed,
            campaign: structuredClone(requireProfile(sealed, input.profileId).evaluationCampaigns!
                .find(({ id }) => id === campaign!.id)!),
        };
    });
}

export async function closeEvaluationCampaign(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: {
    profileId: string;
    expectedCurrentVersion: number;
    stage: SpecializedProfileEvaluation['stage'];
    campaignId: string;
    actorId: string;
}): Promise<{
    registry: SpecializedProfileRegistryDocument;
    campaign: SpecializedProfileEvaluationCampaign;
}> {
    return transportOwner["withLock"](async () => {
        const current = await transportOwner["loadDocument"](true);
        if (!current)
            throw new Error(`Specialized profile registry does not exist for workspace "${transportOwner["workspaceRoot"]}"`);
        const currentProfile = requireProfile(current, input.profileId);
        assertProfileVersion(currentProfile, input.expectedCurrentVersion);
        const stageEntry = currentProfile.transitions.at(-1)!;
        const campaigns = currentProfile.evaluationCampaigns ?? [];
        const retry = campaigns.find((campaign) => campaign.id === input.campaignId
            &&
                campaign.state === 'closed'
            && campaign.evaluationId === undefined
            && campaign.profileVersion === currentProfile.currentVersion
            && campaign.stage === input.stage
            && campaign.stageEntryTransitionSequence === stageEntry.sequence);
        if (retry) {
            if (retry.closedFromRevision !== expectedRevision) {
                throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
            }
            return { registry: current, campaign: structuredClone(retry) };
        }
        if (current.revision !== expectedRevision) {
            throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
        }
        const open = campaigns.find((campaign) => campaign.id === input.campaignId
            &&
                campaign.state === 'open'
            && campaign.profileVersion === currentProfile.currentVersion
            && campaign.stage === input.stage
            && campaign.stageEntryTransitionSequence === stageEntry.sequence);
        if (!open)
            throw new SpecializedProfileTransitionGateError('No open host evaluation campaign exists');
        if (open.missionIds.length < 20) {
            throw new SpecializedProfileTransitionGateError('Host evaluation campaign requires at least 20 reserved Missions');
        }
        if (!open.caseFingerprints
            || Object.keys(open.caseFingerprints).length !== open.missionIds.length
            || open.missionIds.some((missionId) => !open.caseFingerprints?.[missionId])) {
            throw new SpecializedProfileTransitionGateError('Host evaluation campaign has no complete immutable case manifest');
        }
        const next = structuredClone(current);
        const profile = requireProfile(next, input.profileId);
        const campaign = profile.evaluationCampaigns!.find(({ id }) => id === open.id)!;
        const occurredAt = transportOwner["now"]().toISOString();
        campaign.state = 'closed';
        campaign.closedAt = occurredAt;
        campaign.closedFromRevision = current.revision;
        profile.updatedAt = occurredAt;
        next.revision += 1;
        next.updatedAt = occurredAt;
        next.updatedBy = input.actorId;
        const sealed = transportOwner["sealDocument"](next, current.head.documentSha256);
        await transportOwner["writeDocument"](sealed, current);
        return {
            registry: sealed,
            campaign: structuredClone(requireProfile(sealed, input.profileId).evaluationCampaigns!
                .find(({ id }) => id === open.id)!),
        };
    });
}

export async function releaseEvaluationMission(transportOwner: SpecializedProfileRegistryStore, expectedRevision: number, input: {
    profileId: string;
    missionId: string;
    actorId: string;
}): Promise<SpecializedProfileRegistryDocument> {
    return transportOwner["withLock"](async () => {
        const current = await transportOwner["loadDocument"](true);
        if (!current)
            throw new Error(`Specialized profile registry does not exist for workspace "${transportOwner["workspaceRoot"]}"`);
        const currentProfile = requireProfile(current, input.profileId);
        const found = (currentProfile.evaluationCampaigns ?? []).find((campaign) => campaign.missionIds.includes(input.missionId));
        if (!found)
            return current;
        if (found.state !== 'open') {
            throw new SpecializedProfileTransitionGateError('Closed evaluation campaign reservations cannot be released');
        }
        if (current.revision !== expectedRevision) {
            throw new SpecializedProfileRegistryRevisionConflictError(expectedRevision, current.revision);
        }
        const next = structuredClone(current);
        const profile = requireProfile(next, input.profileId);
        const campaigns = profile.evaluationCampaigns ?? [];
        const campaign = campaigns.find(({ id }) => id === found.id)!;
        campaign.missionIds = campaign.missionIds.filter((missionId) => missionId !== input.missionId);
        if (campaign.caseFingerprints)
            delete campaign.caseFingerprints[input.missionId];
        if (campaign.missionIds.length === 0) {
            profile.evaluationCampaigns = campaigns.filter(({ id }) => id !== campaign.id);
        }
        const occurredAt = transportOwner["now"]().toISOString();
        profile.updatedAt = occurredAt;
        next.revision += 1;
        next.updatedAt = occurredAt;
        next.updatedBy = input.actorId;
        const sealed = transportOwner["sealDocument"](next, current.head.documentSha256);
        await transportOwner["writeDocument"](sealed, current);
        return sealed;
    });
}
