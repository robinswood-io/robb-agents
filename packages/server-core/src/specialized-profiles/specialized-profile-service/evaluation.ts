import type { MissionSnapshot } from "@craft-agent/shared/missions";
import { SpecializedProfileRegistryRevisionConflictError, SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE, canonicalSpecializedProfileVersionHash, parseSpecializedMissionProfileReference, type RecordSpecializedProfileEvaluationRequest, type SpecializedProfileEvaluation, type SpecializedProfileRegistryMutationResult } from "@craft-agent/shared/specialized-profiles";
import type { SpecializedProfileService } from '../SpecializedProfileService.ts';
import { EVALUATION_VALIDITY_MS } from './shared.ts';
import { createRegistryAuthority, evaluationCampaignManifestSha256, attestEvaluation } from './authority.ts';
import { missionCorpusFingerprint, requireProfile, normalizeMissionIds } from './definition.ts';
import { evaluationMetrics, snapshotEvidencePayload, isExecutableEvaluationItem, evaluationProfileForItem } from './metrics.ts';
import { canonicalJson, sha256 } from './serialization.ts';

export async function recordEvaluation(transportOwner: SpecializedProfileService, workspaceId: string, request: RecordSpecializedProfileEvaluationRequest): Promise<SpecializedProfileRegistryMutationResult> {
    const workspace = transportOwner["requireWorkspace"](workspaceId);
    const authorityKey = await transportOwner["loadAuthorityKey"](workspaceId);
    const store = await transportOwner["storeFor"](workspace, authorityKey);
    const evaluatorActorId = 'specialized-profile-mission-evaluator';
    const loaded = await store.loadOrCreate(workspaceId, evaluatorActorId);
    const loadedProfile = requireProfile(loaded, request.profileId);
    if (loadedProfile.currentVersion !== request.expectedCurrentVersion) {
        throw new Error(`Specialized profile version changed from ${request.expectedCurrentVersion} to ${loadedProfile.currentVersion}`);
    }
    const expectedState = SPECIALIZED_PROFILE_EVALUATION_ENTRY_STATE[request.stage];
    const loadedStageEntry = loadedProfile.transitions.at(-1);
    if (!loadedStageEntry || loadedProfile.currentState !== expectedState || loadedStageEntry.to !== expectedState) {
        throw new Error(`Evaluation stage ${request.stage} requires current lifecycle state ${expectedState}`);
    }
    const entryCampaigns = (loadedProfile.evaluationCampaigns ?? []).filter((candidate) => candidate.profileVersion === loadedProfile.currentVersion
        && candidate.stage === request.stage
        && candidate.stageEntryTransitionSequence === loadedStageEntry.sequence);
    const exactClosedReplays = entryCampaigns.filter((candidate) => candidate.state === 'closed'
        && candidate.closedFromRevision === request.expectedRegistryRevision);
    if (exactClosedReplays.length > 1) {
        throw new Error('Evaluation retry matches multiple closed host campaigns');
    }
    const freshCampaigns = loaded.revision === request.expectedRegistryRevision
        ? entryCampaigns.filter((candidate) => candidate.state === 'open')
        : [];
    if (freshCampaigns.length > 1) {
        throw new Error('Multiple open host evaluation campaigns exist for the lifecycle entry');
    }
    let campaign = exactClosedReplays[0] ?? freshCampaigns[0];
    if (!campaign) {
        if (loaded.revision !== request.expectedRegistryRevision) {
            throw new SpecializedProfileRegistryRevisionConflictError(request.expectedRegistryRevision, loaded.revision);
        }
        throw new Error('No open or retryable host evaluation campaign exists');
    }
    if (campaign.state === 'closed' && campaign.evaluationId) {
        const version = loadedProfile.versions[request.expectedCurrentVersion - 1];
        const evaluation = loadedProfile.evaluations.find((candidate) => candidate.id === campaign!.evaluationId);
        const manifestIds = normalizeMissionIds(campaign.missionIds);
        const manifestSha256 = evaluationCampaignManifestSha256({
            workspaceId,
            profileId: loadedProfile.id,
            profileVersion: loadedProfile.currentVersion,
            stage: request.stage,
            stageEntryTransitionSequence: loadedStageEntry.sequence,
            campaignId: campaign.id,
            missionIds: manifestIds,
            ...(campaign.caseFingerprints !== undefined ? { caseFingerprints: campaign.caseFingerprints } : {}),
        });
        const evaluationIdentity = evaluation && sha256(canonicalJson({
            schemaVersion: 1,
            workspaceId,
            profileId: loadedProfile.id,
            profileVersion: loadedProfile.currentVersion,
            stage: request.stage,
            stageEntryTransitionSequence: loadedStageEntry.sequence,
            campaignId: campaign.id,
            manifestSha256,
            executionRouteSha256: evaluation.executionRouteSha256,
            capabilityEnvelopeSha256: evaluation.capabilityEnvelopeSha256,
        }));
        const expectedEvaluationId = evaluationIdentity
            ? `profile-evaluation-${evaluationIdentity}`
            : undefined;
        const authority = createRegistryAuthority(workspaceId, authorityKey);
        const exactMissionEvidence = evaluation?.evidence.filter(({ uri }) => uri.startsWith('proof-passport://') || uri.startsWith('mission-attestation://')) ?? [];
        const exactSnapshotEvidence = evaluation?.evidence.filter(({ uri }) => uri.startsWith(`mission://${workspaceId}/`)) ?? [];
        const exactLineageEvidence = evaluation?.evidence.filter(({ uri }) => uri.startsWith('corpus-lineage://')) ?? [];
        if (!version
            || !evaluation
            || campaign.evaluationId !== expectedEvaluationId
            || evaluation.id !== expectedEvaluationId
            || evaluation.runId !== `mission-evaluation-${evaluationIdentity}`
            || evaluation.profileId !== loadedProfile.id
            || evaluation.profileVersion !== loadedProfile.currentVersion
            || evaluation.stage !== request.stage
            || evaluation.stageEntryTransitionSequence !== loadedStageEntry.sequence
            || evaluation.evaluator.actorId !== evaluatorActorId
            || evaluation.cohort.id !== campaign.id
            || evaluation.cohort.closedAt !== campaign.closedAt
            || evaluation.cohort.missionIds.length !== manifestIds.length
            || evaluation.cohort.missionIds.some((id, index) => id !== manifestIds[index])
            || evaluation.corpus.heldOut !== true
            || evaluation.baseline.kind !== 'none'
            || evaluation.baseline.reference !== 'absolute-host-attested-outcomes'
            || exactLineageEvidence.length !== 1
            || exactMissionEvidence.length !== manifestIds.length
            || exactSnapshotEvidence.length !== manifestIds.length
            || !authority.verifyEvaluation({ evaluation, version })) {
            throw new Error('Committed evaluation retry does not match its authenticated host campaign result');
        }
        return { registry: loaded, profileId: request.profileId };
    }
    const idempotentClosedRetry = campaign.state === 'closed'
        && campaign.evaluationId === undefined
        && campaign.closedFromRevision === request.expectedRegistryRevision;
    if (loaded.revision !== request.expectedRegistryRevision && !idempotentClosedRetry) {
        throw new SpecializedProfileRegistryRevisionConflictError(request.expectedRegistryRevision, loaded.revision);
    }
    const closed = campaign.state === 'closed'
        ? { registry: loaded, campaign }
        : await store.closeEvaluationCampaign(loaded.revision, {
            profileId: request.profileId,
            expectedCurrentVersion: request.expectedCurrentVersion,
            stage: request.stage,
            campaignId: campaign.id,
            actorId: evaluatorActorId,
        });
    const current = closed.registry;
    campaign = closed.campaign;
    const profile = requireProfile(current, request.profileId);
    const stageEntry = profile.transitions.at(-1)!;
    const version = profile.versions[request.expectedCurrentVersion - 1];
    if (!version)
        throw new Error(`Unknown specialized profile version ${request.expectedCurrentVersion}`);
    const expectedVersionSha256 = canonicalSpecializedProfileVersionHash(version);
    const cohortId = campaign.id;
    const cohortCandidates = await transportOwner["options"].listMissions(workspaceId);
    const manifestIds = normalizeMissionIds(campaign.missionIds);
    const missionIds = normalizeMissionIds(cohortCandidates.flatMap((snapshot) => {
        const candidate = snapshot.spec.agentProfiles.find(({ id }) => id === profile.id);
        const reference = candidate
            ? parseSpecializedMissionProfileReference(candidate.systemPrompt)
            : null;
        return reference?.profileId === profile.id
            && reference.profileVersion === profile.currentVersion
            && reference.versionSha256 === expectedVersionSha256
            && reference.selectedState === expectedState
            && reference.lifecycleEntryTransitionSequence === stageEntry.sequence
            && reference.evaluationStage === request.stage
            && reference.evaluationCohortId === cohortId
            ? [snapshot.spec.id]
            : [];
    }).sort());
    if (missionIds.length !== manifestIds.length
        || missionIds.some((id, index) => id !== manifestIds[index])) {
        throw new Error('Persisted evaluation Missions do not exactly match the closed host campaign manifest');
    }
    if (!transportOwner["options"].missionEvidenceProvider) {
        throw new Error('Specialized profile evaluation requires a host-verified Mission evidence provider');
    }
    const evidenceSnapshots: MissionSnapshot[] = [];
    const missionEvidence: Array<{
        uri: string;
        sha256: string;
    }> = [];
    let executionRouteSha256: string | undefined;
    let capabilityEnvelopeSha256: string | undefined;
    for (const missionId of missionIds) {
        const verified = await transportOwner["options"].missionEvidenceProvider.loadVerified({ workspaceId, missionId });
        const snapshot = verified.snapshot;
        if (snapshot.spec.id !== missionId) {
            throw new Error(`Verified Mission evidence for "${missionId}" has a mismatched Mission id`);
        }
        const caseFingerprint = missionCorpusFingerprint(snapshot);
        if (!campaign.caseFingerprints
            || campaign.caseFingerprints[missionId] !== caseFingerprint) {
            throw new Error(`Evaluation Mission "${missionId}" changed after its host corpus case was reserved`);
        }
        if (!['completed', 'failed'].includes(snapshot.status)) {
            throw new Error(`Evaluation Mission "${missionId}" is not terminal`);
        }
        if (Date.parse(snapshot.createdAt) < Date.parse(stageEntry.occurredAt)) {
            throw new Error(`Evaluation Mission "${missionId}" predates the ${expectedState} stage entry`);
        }
        if (Date.parse(snapshot.updatedAt) > transportOwner["now"]().getTime()) {
            throw new Error(`Evaluation Mission "${missionId}" completed in the future`);
        }
        const candidate = snapshot.spec.agentProfiles.find(({ id }) => id === profile.id);
        const reference = candidate
            ? parseSpecializedMissionProfileReference(candidate.systemPrompt)
            : null;
        if (!candidate
            || candidate.role !== version.definition.role
            || candidate.specialty !== version.definition.specialty
            || !reference
            || reference.profileId !== profile.id
            || reference.profileVersion !== profile.currentVersion
            || reference.selectedState !== expectedState
            || reference.lifecycleEntryTransitionSequence !== stageEntry.sequence
            || reference.versionSha256 !== expectedVersionSha256
            || reference.evaluationStage !== request.stage
            || reference.evaluationCohortId !== cohortId) {
            throw new Error(`Evaluation Mission "${missionId}" is not bound to the exact specialized profile version`);
        }
        if (executionRouteSha256 && executionRouteSha256 !== reference.executionRouteSha256) {
            throw new Error(`Evaluation campaign "${cohortId}" mixes execution routes`);
        }
        if (capabilityEnvelopeSha256
            && capabilityEnvelopeSha256 !== reference.capabilityEnvelopeSha256) {
            throw new Error(`Evaluation campaign "${cohortId}" mixes capability envelopes`);
        }
        executionRouteSha256 ??= reference.executionRouteSha256;
        capabilityEnvelopeSha256 ??= reference.capabilityEnvelopeSha256;
        const runtimeDefinitions = Object.values(snapshot.workItems).map(({ definition }) => definition);
        const assigned = runtimeDefinitions.filter((item) => isExecutableEvaluationItem(item)
            && evaluationProfileForItem(snapshot.spec, item) === profile.id);
        if (assigned.length === 0) {
            throw new Error(`Evaluation Mission "${missionId}" did not assign executable work to the specialized profile`);
        }
        const foreignExecutable = runtimeDefinitions.find((item) => isExecutableEvaluationItem(item)
            && evaluationProfileForItem(snapshot.spec, item) !== profile.id);
        if (foreignExecutable) {
            throw new Error(`Evaluation Mission "${missionId}" delegates evaluated work item "${foreignExecutable.id}" outside the specialized profile`);
        }
        for (const item of assigned) {
            const runtime = snapshot.workItems[item.id];
            const executionProfile = runtime?.executionBinding?.specializedProfile;
            if (!runtime
                || runtime.agentProfileId !== profile.id
                || runtime.attempt < 1
                || runtime.executionHistory.length < 1
                || !executionProfile
                || executionProfile.profileId !== profile.id
                || executionProfile.profileVersion !== profile.currentVersion
                || executionProfile.versionSha256 !== expectedVersionSha256
                || executionProfile.capabilityEnvelopeSha256 !== reference.capabilityEnvelopeSha256
                || executionProfile.executionRouteSha256 !== reference.executionRouteSha256) {
                throw new Error(`Evaluation Mission "${missionId}" has no host execution binding for work item "${item.id}"`);
            }
        }
        if (!/^[a-f0-9]{64}$/.test(verified.evidence.sha256)
            || (!verified.evidence.uri.startsWith('proof-passport://')
                && !verified.evidence.uri.startsWith('mission-attestation://'))) {
            throw new Error(`Evaluation Mission "${missionId}" lacks canonical host proof evidence`);
        }
        evidenceSnapshots.push(snapshot);
        missionEvidence.push(verified.evidence);
    }
    const metrics = evaluationMetrics(evidenceSnapshots);
    const completedAtMs = Math.max(...evidenceSnapshots.map((snapshot) => Date.parse(snapshot.updatedAt)));
    const startedAtMs = Math.min(...evidenceSnapshots.map((snapshot) => Date.parse(snapshot.createdAt)));
    if (!executionRouteSha256 || !capabilityEnvelopeSha256) {
        throw new Error('Evaluation campaign has no consistent host execution fingerprint');
    }
    if (!transportOwner["options"].corpusLineageProvider) {
        throw new Error('Specialized profile promotion requires an independent host corpus-lineage attestor');
    }
    const manifestSha256 = evaluationCampaignManifestSha256({
        workspaceId,
        profileId: profile.id,
        profileVersion: profile.currentVersion,
        stage: request.stage,
        stageEntryTransitionSequence: stageEntry.sequence,
        campaignId: cohortId,
        missionIds: manifestIds,
        ...(campaign.caseFingerprints !== undefined ? { caseFingerprints: campaign.caseFingerprints } : {}),
    });
    const provenanceSha256 = sha256(canonicalJson(version.provenance));
    const lineage = await transportOwner["options"].corpusLineageProvider.attestHeldOut({
        workspaceId,
        profileId: profile.id,
        profileVersion: profile.currentVersion,
        stage: request.stage,
        stageEntryTransitionSequence: stageEntry.sequence,
        campaignId: cohortId,
        campaignCreatedAt: campaign.createdAt,
        profileVersionCreatedAt: version.createdAt,
        manifestSha256,
        provenanceSha256,
    });
    const reservedAtMs = Date.parse(lineage.reservedAt);
    if (lineage.schemaVersion !== 1
        || lineage.manifestSha256 !== manifestSha256
        || lineage.provenanceSha256 !== provenanceSha256
        || lineage.disjointFromProvenance !== true
        || !Number.isFinite(reservedAtMs)
        || reservedAtMs > Date.parse(version.createdAt)
        || reservedAtMs > Date.parse(campaign.createdAt)
        || !lineage.providerId.trim()
        || !lineage.attestationId.trim()
        || !lineage.corpusId.trim()
        || !lineage.lineageId.trim()
        || !lineage.partitionVersion.trim()
        || !lineage.evidence.uri.startsWith('corpus-lineage://')
        || !/^[a-f0-9]{64}$/.test(lineage.evidence.sha256)) {
        throw new Error('Host corpus-lineage attestation is missing, stale, mismatched, or not disjoint');
    }
    const evaluationIdentity = sha256(canonicalJson({
        schemaVersion: 1,
        workspaceId,
        profileId: profile.id,
        profileVersion: profile.currentVersion,
        stage: request.stage,
        stageEntryTransitionSequence: stageEntry.sequence,
        campaignId: cohortId,
        manifestSha256,
        executionRouteSha256,
        capabilityEnvelopeSha256,
    }));
    const evaluationId = `profile-evaluation-${evaluationIdentity}`;
    const evaluation: SpecializedProfileEvaluation = {
        schemaVersion: 1,
        id: evaluationId,
        profileId: profile.id,
        profileVersion: profile.currentVersion,
        stage: request.stage,
        stageEntryTransitionSequence: stageEntry.sequence,
        executionRouteSha256,
        capabilityEnvelopeSha256,
        outcome: metrics.verifiedPassRate >= 0.95
            && metrics.falseCompletionCount === 0
            && metrics.policyViolationCount === 0
            && metrics.completeReceiptCount === metrics.requiredReceiptCount
            ? 'pass'
            : 'fail',
        runId: `mission-evaluation-${evaluationIdentity}`,
        corpus: {
            id: lineage.corpusId,
            version: lineage.partitionVersion,
            heldOut: true,
        },
        // No comparative baseline is claimed unless the host evaluates one.
        // This gate is deliberately based on absolute, host-attested outcomes.
        baseline: { kind: 'none', reference: 'absolute-host-attested-outcomes' },
        cohort: {
            id: cohortId,
            missionIds,
            closedAt: closed.campaign.closedAt!,
        },
        evaluator: { actorId: evaluatorActorId },
        metrics,
        evidence: [
            lineage.evidence,
            ...evidenceSnapshots.flatMap((snapshot, index) => [
                {
                    uri: `mission://${workspaceId}/${snapshot.spec.id}/revision/${snapshot.revision}`,
                    sha256: sha256(canonicalJson(snapshotEvidencePayload(snapshot))),
                },
                missionEvidence[index]!,
            ]),
        ],
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        validUntil: new Date(completedAtMs + EVALUATION_VALIDITY_MS).toISOString(),
    };
    const registry = await store.recordEvaluation(closed.registry.revision, evaluatorActorId, attestEvaluation(evaluation, workspaceId, version, authorityKey));
    return { registry, profileId: request.profileId };
}
