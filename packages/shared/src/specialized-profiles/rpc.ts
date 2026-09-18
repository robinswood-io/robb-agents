import type {
  SpecializationOpportunityReport,
} from './opportunity-engine.ts';
import type {
  SpecializedProfileEvaluation,
  SpecializedProfileRegistryDocument,
  SpecializedProfileState,
} from './schema.ts';

/** Read-only workspace analysis. The host never returns transcript content. */
export interface SpecializedProfileAnalysisResult {
  report: SpecializationOpportunityReport;
  analyzedMissionIds: string[];
  excludedMissionCount: number;
  generatedAt: string;
}

export interface CreateSpecializedProfileDraftRequest {
  proposalId: string;
  expectedRegistryRevision: number;
}

export interface TransitionSpecializedProfileRequest {
  profileId: string;
  expectedRegistryRevision: number;
  expectedCurrentVersion: number;
  to: SpecializedProfileState;
  reason: string;
  evaluationIds?: string[];
}

export interface RecordSpecializedProfileEvaluationRequest {
  expectedRegistryRevision: number;
  evaluation: SpecializedProfileEvaluation;
}

export interface RollbackSpecializedProfileRequest {
  profileId: string;
  expectedRegistryRevision: number;
  expectedCurrentVersion: number;
  rollbackOfVersion: number;
  reason: string;
}

export interface SpecializedProfileRegistryMutationResult {
  registry: SpecializedProfileRegistryDocument;
  profileId: string;
}
