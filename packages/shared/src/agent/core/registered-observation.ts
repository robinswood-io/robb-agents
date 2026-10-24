/** Registered observations: bounded shell, remote, SQL and validation commands. */
export { isObjectiveShellExecutorToolName } from './registered-observation/shell-vocabulary.ts';
export { isProvablyReadOnlyShellCommand, isRegisteredShellObservation, isReadOnlyRegisteredShellObservation, isObjectiveShellEvidenceCommand, isObjectiveShellObservationCommand } from './registered-observation/git-observations.ts';
export { isRemoteStaticSourceInspectionCandidate, remoteStaticSourceInspectionLiteralPath, remoteStaticSourceInspectionLiteralPaths, containsRemoteStaticSourceInspectionCandidate, isBoundedRemoteStaticSourceInspection } from './registered-observation/read-policy.ts';
export type { BoundedTargetedRemoteOperationalInspection } from './registered-observation/operational-inspection.ts';
export { classifyBoundedTargetedRemoteOperationalInspection, isBoundedTargetedRemoteOperationalInspection } from './registered-observation/operational-inspection.ts';
export type { ReadOnlyRemoteObservationRepair } from './registered-observation/remote-read-repair.ts';
export { classifyReadOnlyRemoteObservationRepair, classifyNestedSshReadOnlyRemoteObservationRepair, containsLocalSshTransportInvocation } from './registered-observation/remote-read-repair.ts';
export { objectiveShellExitZeroProvesSuccess } from './registered-observation/success-markers.ts';
export { hasBoundedObjectiveShellSuccessMarker } from './registered-observation/success-markers-has-bounded-objective-shell-success-marker.ts';
