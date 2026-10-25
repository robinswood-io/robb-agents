import type { MissionSnapshot } from "@craft-agent/shared/missions";
import { SpecializedProfileRegistryStore, type CreateSpecializedProfileDraftRequest, type RecordSpecializedProfileEvaluationRequest, type RollbackSpecializedProfileRequest, type SpecializedProfileEvaluation, type SpecializedProfileAnalysisResult, type SpecializedProfileRegistryAnchorStore, type SpecializedProfileRegistryDocument, type SpecializedProfileRegistryMutationResult, type TransitionSpecializedProfileRequest } from "@craft-agent/shared/specialized-profiles";
import { loadWorkspaceGovernanceSigningKey } from "../tasks/execution-proof-runtime.ts";
import { FileSpecializedProfileRegistryAnchorStore } from "./registry-anchor-store.ts";
import { AUTHORITY_KEY_PURPOSE, DEFAULT_LOOKBACK_DAYS, DEFAULT_ANCHOR_DIRECTORY } from './specialized-profile-service/shared.ts';
import type { SpecializedProfileWorkspace, SpecializedProfileServiceOptions } from './specialized-profile-service/shared.ts';
import { createRegistryAuthority } from './specialized-profile-service/authority.ts';
import * as specializedProfileServiceAnalysis from './specialized-profile-service/analysis.ts';
import * as specializedProfileServiceDraft from './specialized-profile-service/draft.ts';
import * as specializedProfileServiceTransition from './specialized-profile-service/transition.ts';
import * as specializedProfileServiceEvaluation from './specialized-profile-service/evaluation.ts';
import * as specializedProfileServiceCampaign from './specialized-profile-service/campaign.ts';
export type { SpecializedProfileWorkspace, SpecializedProfileServiceOptions, SpecializedProfileRegistryLoaderOptions, SpecializedProfileHumanApprovalProvider, SpecializedProfileMissionEvidenceProvider, SpecializedProfileCorpusLineageProvider } from './specialized-profile-service/shared.ts';
export { loadSpecializedProfileRegistryForMission } from './specialized-profile-service/authority.ts';
export { missionCorpusFingerprint } from './specialized-profile-service/definition.ts';

/**
 * Host-owned bridge between durable Mission evidence and the inactive profile
 * registry. It never selects a provider/model or grants a requested capability.
 */
export class SpecializedProfileService {
    private readonly now: () => Date;
    private readonly loadAuthorityKey: (workspaceId: string) => Promise<string | Uint8Array>;
    private readonly lookbackDays: number;
    private readonly anchorStore: SpecializedProfileRegistryAnchorStore;
    constructor(private readonly options: SpecializedProfileServiceOptions) {
        this.now = options.now ?? (() => new Date());
        this.loadAuthorityKey = options.loadAuthorityKey
            ?? ((workspaceId) => loadWorkspaceGovernanceSigningKey(workspaceId, AUTHORITY_KEY_PURPOSE));
        this.lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
        this.anchorStore = options.anchorStore
            ?? new FileSpecializedProfileRegistryAnchorStore(DEFAULT_ANCHOR_DIRECTORY);
        if (!Number.isInteger(this.lookbackDays) || this.lookbackDays < 30 || this.lookbackDays > 730) {
            throw new RangeError('lookbackDays must be an integer between 30 and 730');
        }
    }
    async analyze(workspaceId: string): Promise<SpecializedProfileAnalysisResult> {
        return specializedProfileServiceAnalysis.analyze(this, workspaceId);
    }
    async getRegistry(workspaceId: string, actorId: string): Promise<SpecializedProfileRegistryDocument> {
        return specializedProfileServiceDraft.getRegistry(this, workspaceId, actorId);
    }
    async createDraft(workspaceId: string, actorId: string, request: CreateSpecializedProfileDraftRequest): Promise<SpecializedProfileRegistryMutationResult> {
        return specializedProfileServiceDraft.createDraft(this, workspaceId, actorId, request);
    }
    async transition(workspaceId: string, actorId: string, request: TransitionSpecializedProfileRequest): Promise<SpecializedProfileRegistryMutationResult> {
        return specializedProfileServiceTransition.transition(this, workspaceId, actorId, request);
    }
    async recordEvaluation(workspaceId: string, request: RecordSpecializedProfileEvaluationRequest): Promise<SpecializedProfileRegistryMutationResult> {
        return specializedProfileServiceEvaluation.recordEvaluation(this, workspaceId, request);
    }
    /** Host-internal campaign admission. It is intentionally not exposed by RPC. */
    async reserveEvaluationMission(workspaceId: string, input: {
        profileId: string;
        stage: SpecializedProfileEvaluation['stage'];
        missionId: string;
        caseFingerprintSha256: string;
    }): Promise<{
        campaignId: string;
        registry: SpecializedProfileRegistryDocument;
    }> {
        return specializedProfileServiceCampaign.reserveEvaluationMission(this, workspaceId, input);
    }
    async releaseEvaluationMission(workspaceId: string, input: {
        profileId: string;
        missionId: string;
    }): Promise<void> {
        return specializedProfileServiceCampaign.releaseEvaluationMission(this, workspaceId, input);
    }
    async rollback(workspaceId: string, actorId: string, request: RollbackSpecializedProfileRequest): Promise<SpecializedProfileRegistryMutationResult> {
        return specializedProfileServiceTransition.rollback(this, workspaceId, actorId, request);
    }
    private requireWorkspace(workspaceId: string): SpecializedProfileWorkspace {
        const workspace = this.options.resolveWorkspace(workspaceId);
        if (!workspace)
            throw new Error(`Workspace ${workspaceId} not found`);
        return workspace;
    }
    private analysisWindow(snapshots: readonly MissionSnapshot[]): {
        included: MissionSnapshot[];
        excludedCount: number;
    } {
        return specializedProfileServiceAnalysis.analysisWindow(this, snapshots);
    }
    private async verifiedAnalysisWindow(workspaceId: string, snapshots: readonly MissionSnapshot[]): Promise<{
        included: MissionSnapshot[];
        excludedCount: number;
    }> {
        return specializedProfileServiceAnalysis.verifiedAnalysisWindow(this, workspaceId, snapshots);
    }
    private async storeFor(workspace: SpecializedProfileWorkspace, resolvedAuthorityKey?: string | Uint8Array): Promise<SpecializedProfileRegistryStore> {
        const authorityKey = resolvedAuthorityKey ?? await this.loadAuthorityKey(workspace.id);
        return new SpecializedProfileRegistryStore(workspace.rootPath, {
            now: this.now,
            authority: createRegistryAuthority(workspace.id, authorityKey),
            anchorStore: this.anchorStore,
        });
    }
}
