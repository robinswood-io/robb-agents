/** Existing behavior separated into direct modules by responsibility, preserving the public entry point. */
export type { LearningTrajectorySource, VerifiedLearningProposal, VerifiedLearningAction, VerifiedLearningEvent, LearningEventSigner, LearningKeyResolver, LearningActorRole, HostVerifiedLearningIdentity, LearningIdentityResolver, VerifiedLearningAuthority, VerifiedLearningState, VerifiedLearningProjection } from './verified-learning/contracts.ts';
export { LearningTrajectorySourceSchema, VerifiedLearningProposalSchema, VerifiedLearningEventSchema, LearningActorRoleSchema, HostVerifiedLearningIdentitySchema } from './verified-learning/contracts.ts';
export { VerifiedLearningStore } from './verified-learning/store.ts';
export { createVerifiedLearningProposal, recordVerifiedLearningEval, approveVerifiedLearningProposal, recordVerifiedLearningCanary, rollbackVerifiedLearningCanary, revokeVerifiedLearningProposal } from './verified-learning/actions.ts';
export { verifyVerifiedLearningHistory } from './verified-learning/history.ts';
