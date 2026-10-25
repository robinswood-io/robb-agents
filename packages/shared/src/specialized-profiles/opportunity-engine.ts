/** Existing contracts and operations grouped into direct responsibility modules; bodies and public API preserved. */
export type { SpecializationSignal, SpecializationOpportunityCategory, RootMissionSpecializationObservation, SpecializationCategoryThreshold, AgentProfileOpportunityThreshold, SpecializationOpportunityThresholds, SpecializationOpportunityThresholdOverrides, SpecializationCandidateAssessment, SpecializationFamilyAnalysis, SpecializationOpportunityProposal, SpecializationOpportunityReport } from './opportunity-engine/contracts.ts';
export { SPECIALIZATION_SIGNALS, SPECIALIZATION_OPPORTUNITY_CATEGORIES, DEFAULT_SPECIALIZATION_OPPORTUNITY_THRESHOLDS } from './opportunity-engine/contracts.ts';
export { detectSpecializationOpportunities } from './opportunity-engine/opportunities.ts';
export { resolveSpecializationOpportunityThresholds } from './opportunity-engine/validation.ts';
