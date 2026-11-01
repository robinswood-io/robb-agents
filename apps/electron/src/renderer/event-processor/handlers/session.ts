/** Existing contracts and operations grouped into direct responsibility modules; bodies and public API preserved. */
export { handleComplete, handleError, handleTypedError, handleStatus, handleInfo, handleInterrupted } from './session/lifecycle.ts';
export { handleTitleGenerated, handleTitleRegenerating, handleAsyncOperation, handleWorkingDirectoryChanged, handlePermissionModeChanged, handleSessionModelChanged, handleConnectionChanged } from './session/activity.ts';
export { handleUserMessage, handleMessageAnnotationsUpdated } from './session/messages.ts';
export { handleSourcesChanged, handleLabelsChanged, handleProjectIdChanged, handleSessionStatusChanged, handleSessionMetadataChanged, handleSessionFlagged, handleSessionUnflagged, handleSessionArchived, handleSessionUnarchived, handleNameChanged, handleUsageUpdate, handleObjectiveChanged } from './session/metadata.ts';
export { handlePermissionRequest, handleCredentialRequest, handlePlanSubmitted, handleSessionShared, handleSessionUnshared, handleAuthRequest, handleAuthCompleted } from './session/requests.ts';
