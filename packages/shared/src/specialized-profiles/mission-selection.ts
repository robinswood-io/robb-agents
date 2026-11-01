/** Direct modules preserving the existing connector and specialized mission profile contracts and implementations. */
export type { SpecializedMissionProfileState, SpecializedMissionProfileReference, SpecializedMissionProfileBinding, SpecializedMissionCapability, SpecializedMissionSelectionContext, SpecializedMissionProfileSelection } from './mission-selection/contracts.ts';
export { SPECIALIZED_MISSION_PROFILE_ID_PREFIX, SPECIALIZED_MISSION_PROFILE_STATES, SPECIALIZED_MISSION_PROFILE_BINDING_STATES, SpecializedMissionProfileSelectionError } from './mission-selection/contracts.ts';
export { specializedProfileHasCurrentMissionQualification, selectSpecializedMissionProfile } from './mission-selection/selection.ts';
export { parseSpecializedMissionProfileReference, isSpecializedMissionProfileState, specializedProfileCapabilityEnvelopeIdentity } from './mission-selection/bindings.ts';
export { specializedProfileExecutionRouteIdentity } from './mission-selection/execution-route.ts';
