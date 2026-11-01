import { join } from "node:path";
import { CONFIG_DIR } from "@craft-agent/shared/config";
import type { MissionSnapshot } from "@craft-agent/shared/missions";
import { type SpecializedProfileEvaluation, type SpecializedProfileRegistryAnchorStore, type SpecializedProfileState } from "@craft-agent/shared/specialized-profiles";

export interface SpecializedProfileWorkspace {
    id: string;
    rootPath: string;
}

export interface SpecializedProfileServiceOptions {
    resolveWorkspace(workspaceId: string): SpecializedProfileWorkspace | null;
    listMissions(workspaceId: string): Promise<MissionSnapshot[]>;
    now?: () => Date;
    loadAuthorityKey?: (workspaceId: string) => Promise<string | Uint8Array>;
    anchorStore?: SpecializedProfileRegistryAnchorStore;
    /** Loads a host-authenticated, replayed Mission outcome (for example a verified Proof Passport). */
    missionEvidenceProvider?: SpecializedProfileMissionEvidenceProvider;
    /**
     * Independent host authority for pre-reserved evaluation corpus lineage.
     * Absence deliberately disables promotion: text similarity is not lineage.
     */
    corpusLineageProvider?: SpecializedProfileCorpusLineageProvider;
    /** Required for opt-in/canary/default; consumes a one-time, separately authenticated human challenge. */
    humanApprovalProvider?: SpecializedProfileHumanApprovalProvider;
    lookbackDays?: number;
}

export interface SpecializedProfileRegistryLoaderOptions {
    now?: () => Date;
    loadAuthorityKey?: (workspaceId: string) => Promise<string | Uint8Array>;
    anchorStore?: SpecializedProfileRegistryAnchorStore;
}

export interface SpecializedProfileHumanApprovalProvider {
    consume(input: {
        /** Provider must replay the same authentication result for this key. */
        idempotencyKey: string;
        challengeId: string;
        workspaceId: string;
        profileId: string;
        profileVersion: number;
        from: SpecializedProfileState;
        to: 'opt-in' | 'canary' | 'default';
        rationale: string;
        registryRevision: number;
        registryHeadSha256: string;
        lifecycleEntryTransitionSequence: number;
        evaluationIds: string[];
        versionSha256: string;
    }): Promise<{
        reviewerActorId: string;
        assurance: 'webauthn' | 'os-session' | 'oauth-recent';
        verifierId: string;
        eventId: string;
        authenticatedAt: string;
        expiresAt: string;
        evidence: Array<{
            uri: string;
            sha256: string;
        }>;
    }>;
}

export interface SpecializedProfileMissionEvidenceProvider {
    loadVerified(input: {
        workspaceId: string;
        missionId: string;
    }): Promise<{
        snapshot: MissionSnapshot;
        evidence: {
            uri: string;
            sha256: string;
        };
    }>;
}

export interface SpecializedProfileCorpusLineageProvider {
    attestHeldOut(input: {
        workspaceId: string;
        profileId: string;
        profileVersion: number;
        stage: SpecializedProfileEvaluation['stage'];
        stageEntryTransitionSequence: number;
        campaignId: string;
        campaignCreatedAt: string;
        profileVersionCreatedAt: string;
        manifestSha256: string;
        provenanceSha256: string;
    }): Promise<{
        schemaVersion: 1;
        providerId: string;
        attestationId: string;
        corpusId: string;
        lineageId: string;
        partitionVersion: string;
        /** Must predate the profile version and evaluation campaign. */
        reservedAt: string;
        manifestSha256: string;
        provenanceSha256: string;
        disjointFromProvenance: boolean;
        evidence: {
            uri: string;
            sha256: string;
        };
    }>;
}

export const PROMOTION_STATES = new Set<SpecializedProfileState>(['opt-in', 'canary', 'default']);

export const WRITE_OR_EXTERNAL_CAPABILITIES = new Set([
    'workspace-write',
    'network',
    'external-mutation',
]);

export const AUTHORITY_KEY_PURPOSE = 'specialized-profile-registry-v2';

export const AUTHORITY_KEY_ID = 'workspace-governance:specialized-profile-registry-v2';

export const AUTHORITY_EVIDENCE_PREFIX = 'robb-authority://specialized-profiles/v2/';

export const EVALUATION_VALIDITY_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_LOOKBACK_DAYS = 180;

export const DEFAULT_ANCHOR_DIRECTORY = join(CONFIG_DIR, 'governance', 'specialized-profile-registry-heads');
