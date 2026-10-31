
/**
 * Privacy-minimal evidence attached to a root mission observation.
 *
 * The contract intentionally excludes transcripts, prompts, responses, tool
 * payloads, routes, models, and permissions. Callers must adjudicate these
 * signals before passing them to this read-only classifier.
 */
export const SPECIALIZATION_SIGNALS = [
  'platform-defect',
  'context-retrieval-gap',
  'durable-preference',
  'reusable-knowledge',
  'deterministic-procedure',
  'stable-variable-workflow',
  'domain-judgment',
  'stable-tool-boundary',
  'stable-risk-boundary',
  'stable-verification-boundary',
] as const;

export type SpecializationSignal = typeof SPECIALIZATION_SIGNALS[number];

export const SPECIALIZATION_OPPORTUNITY_CATEGORIES = [
  // Order is also conservative selection precedence. A shared defect or
  // missing context should be corrected before adding execution machinery;
  // a bounded agent profile supersedes the less isolated skill alternative.
  'platform-fix',
  'memory',
  'automation',
  'agent-profile',
  'skill',
] as const;

export type SpecializationOpportunityCategory =
  typeof SPECIALIZATION_OPPORTUNITY_CATEGORIES[number];

export interface RootMissionSpecializationObservation {
  /** Stable identifier of the externally adjudicated observation. */
  readonly observationId: string;
  /** Objective of the root mission, never a child-agent objective. */
  readonly rootObjective: string;
  /** Stable task-family label supplied by the host or an offline audit. */
  readonly family: string;
  /** Structured signals only; no transcript-derived free-form payload. */
  readonly signals: readonly SpecializationSignal[];
}

export interface SpecializationCategoryThreshold {
  readonly minimumFamilyRootMissions: number;
  readonly minimumSupportingRootMissions: number;
  readonly minimumSupportingRate: number;
}

export interface AgentProfileOpportunityThreshold extends SpecializationCategoryThreshold {
  /** Number of tool, risk, and verification boundaries required on each supporting mission. */
  readonly minimumBoundaryKinds: number;
}

export interface SpecializationOpportunityThresholds {
  readonly 'platform-fix': SpecializationCategoryThreshold;
  readonly memory: SpecializationCategoryThreshold;
  readonly automation: SpecializationCategoryThreshold;
  readonly skill: SpecializationCategoryThreshold;
  readonly 'agent-profile': AgentProfileOpportunityThreshold;
}

export interface SpecializationOpportunityThresholdOverrides {
  readonly 'platform-fix'?: Partial<SpecializationCategoryThreshold>;
  readonly memory?: Partial<SpecializationCategoryThreshold>;
  readonly automation?: Partial<SpecializationCategoryThreshold>;
  readonly skill?: Partial<SpecializationCategoryThreshold>;
  readonly 'agent-profile'?: Partial<AgentProfileOpportunityThreshold>;
}

export const DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS: SpecializationOpportunityThresholds =
  Object.freeze({
    'platform-fix': Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    memory: Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    automation: Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    skill: Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
    }),
    'agent-profile': Object.freeze({
      minimumFamilyRootMissions: 8,
      minimumSupportingRootMissions: 5,
      minimumSupportingRate: 0.6,
      minimumBoundaryKinds: 3,
    }),
  });

export interface SpecializationCandidateAssessment {
  readonly category: SpecializationOpportunityCategory;
  readonly eligible: boolean;
  readonly familyRootMissionCount: number;
  readonly supportingRootMissionCount: number;
  readonly supportingRate: number;
  readonly threshold: SpecializationCategoryThreshold | AgentProfileOpportunityThreshold;
  readonly reasons: readonly string[];
}

export interface SpecializationFamilyAnalysis {
  readonly family: string;
  readonly normalizedFamily: string;
  readonly rawObservationCount: number;
  readonly rootMissionCount: number;
  readonly candidates: readonly SpecializationCandidateAssessment[];
  readonly selectedCategory?: SpecializationOpportunityCategory;
  readonly explanation: readonly string[];
}

/**
 * A recommendation only. There is deliberately no active state or activation
 * callback in this contract.
 */
export interface SpecializationOpportunityProposal {
  readonly schemaVersion: 1;
  readonly proposalId: string;
  readonly family: string;
  readonly normalizedFamily: string;
  readonly category: SpecializationOpportunityCategory;
  readonly state: 'inactive';
  readonly activationMode: 'human-review-required';
  readonly automaticActivation: false;
  readonly rawObservationCount: number;
  readonly rootMissionCount: number;
  readonly supportingRootMissionCount: number;
  readonly supportingRate: number;
  readonly supportingObservationIds: readonly string[];
  readonly explanation: readonly string[];
}

export interface SpecializationOpportunityReport {
  readonly schemaVersion: 1;
  readonly mode: 'analysis-only';
  readonly mutationMode: 'forbidden';
  readonly activationMode: 'proposal-only';
  readonly thresholds: SpecializationOpportunityThresholds;
  readonly rawObservationCount: number;
  readonly deduplicatedRootMissionCount: number;
  readonly analyses: readonly SpecializationFamilyAnalysis[];
  readonly proposals: readonly SpecializationOpportunityProposal[];
}

export interface DeduplicatedRootMission {
  readonly key: string;
  readonly normalizedFamily: string;
  readonly familyVariants: Set<string>;
  readonly observationIds: Set<string>;
  readonly signals: Set<SpecializationSignal>;
  rawObservationCount: number;
}

export const OBSERVATION_KEYS = new Set(['observationId', 'rootObjective', 'family', 'signals']);

export const SIGNAL_SET = new Set<string>(SPECIALIZATION_SIGNALS);

export const CATEGORY_SET = new Set<string>(SPECIALIZATION_OPPORTUNITY_CATEGORIES);

export const BASE_THRESHOLD_KEYS = new Set([
  'minimumFamilyRootMissions',
  'minimumSupportingRootMissions',
  'minimumSupportingRate',
]);

export const AGENT_THRESHOLD_KEYS = new Set([...BASE_THRESHOLD_KEYS, 'minimumBoundaryKinds']);

export const MEMORY_SIGNALS = new Set<SpecializationSignal>([
  'context-retrieval-gap',
  'durable-preference',
  'reusable-knowledge',
]);

export const AGENT_BOUNDARY_SIGNALS = [
  'stable-tool-boundary',
  'stable-risk-boundary',
  'stable-verification-boundary',
] as const satisfies readonly SpecializationSignal[];

export const CATEGORY_SIGNAL_DESCRIPTIONS: Record<SpecializationOpportunityCategory, string> = {
  'platform-fix': 'a recurring platform defect',
  memory: 'a durable-context or reusable-knowledge need',
  automation: 'a deterministic procedure',
  skill: 'a stable workflow with variable inputs',
  'agent-profile': 'a stable judgment workflow with its own operational boundaries',
};
