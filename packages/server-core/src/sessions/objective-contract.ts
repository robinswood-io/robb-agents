/** Objective contracts: intent, authority, transitions and evidence bindings. */
export { isPrecisionOrCompletenessChallenge, OBJECTIVE_OUTCOME_CONTINUE_EXAMPLE } from './objective-contract/intent-vocabulary.ts';
export type { ObjectiveTransitionInput } from './objective-contract/types.ts';
export { isLegacyPlanImplementationRequest } from './objective-contract/request-intent.ts';
export { classifyAuthorizedObjectiveEvidenceDomain } from './objective-contract/execution-authority.ts';
export { isLegacyContextualObjectiveRoot } from './objective-contract/amendment-history.ts';
export { isExplicitReadOnlyReview, isExplicitReadOnlyClosureRequest } from './objective-contract/closure-intent.ts';
export { objectiveRequiresExecutionEvidence, projectLegacyObjectiveCompletionRequirements } from './objective-contract/execution-requirements.ts';
export { transitionObjectiveContract } from './objective-contract/transition.ts';
export { objectiveCostUsd, findObjectiveText, isHostSyntheticObjectiveText, isHostSyntheticObjectiveMessage, reconstructObjectiveForBranch } from './objective-contract/history-reconstruction.ts';
export { isObjectiveToolExecutedSuccessfully, isObjectiveCoordinationTool, hasObjectiveSubstantiveToolResult, isObjectiveMutationTool } from './objective-contract/tool-evidence.ts';
export type { TurnProgressFingerprints } from './objective-contract/progress-evidence.ts';
export { isObjectiveEvidenceInvalidatingMutation, turnProgressFingerprints, turnProgressFingerprint, hasObjectiveExecutionEvidence } from './objective-contract/progress-evidence.ts';
export { objectiveReviewBinding, objectiveRequiresScopeCoverageReview, buildObjectiveScopePrompt, objectiveAllowsContentCheckReview } from './objective-contract/review-binding.ts';
export type { ExplicitReadOnlyAuthorityBoundary } from './objective-contract/prompt-authority.ts';
export { currentExplicitReadOnlyAuthorityBoundary, objectiveEvidenceContractSegments } from './objective-contract/prompt-authority.ts';
export { buildObjectiveContractPrompt } from './objective-contract/prompt.ts';
