/** Existing behavior separated into direct modules by responsibility, preserving the public entry point. */
export type { VerifiedMachineCapabilityAttestation, MeshIdentity, MeshIdentityResolver, MeshMachineIdentity, TrustedMachineCapabilityResolver, TrustedHumanIdentityResolver, VerifiedFederatedClaims, MissionQueueEnvelope, MissionQueueEnqueueInput, MeshMissionLease } from './sovereign-team-mesh/contracts.ts';
export { MeshCapabilitySetSchema, VerifiedMachineCapabilityAttestationSchema, MeshIdentitySchema, MissionQueueEnvelopeSchema, MissionQueueEnqueueInputSchema } from './sovereign-team-mesh/contracts.ts';
export { identityFromVerifiedFederation, identityFromVerifiedScim, identityFromVerifiedDeviceAttestation, delegateMissionAgentIdentity } from './sovereign-team-mesh/identity.ts';
export { SovereignMissionQueue } from './sovereign-team-mesh/mission-queue.ts';
