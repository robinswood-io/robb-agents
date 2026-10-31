/// <reference path="../bash-parser.d.ts" />

/** Sensitive external effects: classification and explicit request authority. */
export type { SensitiveExternalActionCategory, SensitiveConditionalTargetKind, SensitiveConditionalTarget, SensitiveExternalAction } from './sensitive-external-action/types.ts';
export { hasUnresolvedRemoteScopeTarget, hasUnresolvedSensitiveExternalActionTarget, externalActionAuthorityPolicySegments } from './sensitive-external-action/host-authorization.ts';
export { isSensitiveExternalActionOtherwiseAuthorizedByObjective } from './sensitive-external-action/objective-authorization-policy.ts';
export { isSensitiveRemoteTransferSource } from './sensitive-external-action/remote-scope-targets.ts';
export { isClearlyReadOnlyToolAction } from './sensitive-external-action/connector-classification.ts';
export { signedOssAtomicWriteAuthorizedSessionId } from './sensitive-external-action/signed-oss-write.ts';
export { classifySensitiveExternalAction } from './sensitive-external-action/classification.ts';
export { isSensitiveExternalActionExplicitlyAuthorized } from './sensitive-external-action/request-authority-clauses.ts';
export type { StructuredGmailSendResumePayload, StructuredGmailSendAuthorizationDecision, StructuredGmailSendMismatchCategory, StructuredGmailSendAuthorizationDiagnostic } from './sensitive-external-action/structured-gmail-send.ts';
export { parseStructuredGmailSendResumeSegment, isTargetFreeGenericContinuation } from './sensitive-external-action/structured-gmail-send.ts';
export { structuredGmailSendAuthorizationDiagnostic, structuredGmailSendAuthorizationDecision, isStructuredGmailSendAuthorizedByObjective } from './sensitive-external-action/structured-gmail-authorization.ts';
export type { ContextualGmailReplyScope } from './sensitive-external-action/gmail-reply-parsing.ts';
export { contextualGmailTargetScopedAuthorizationSegments } from './sensitive-external-action/gmail-reply-objective.ts';
export type { ContextualGmailExactEffectExpectation } from './sensitive-external-action/gmail-reply-constraints.ts';
export { contextualGmailExactEffectExpectationFromObjective, contextualGmailClosedExactEffectExpectationFromObjective } from './sensitive-external-action/gmail-reply-expectation.ts';
export type { ContextualGmailReplyPreflightIntent, ContextualGmailReplyPreflightAttestation } from './sensitive-external-action/gmail-reply-authorization.ts';
export { contextualGmailReplyPreflightAttestationFromObjective, isContextualGmailReplyAuthorizedByObjective, isContextualGmailReplyRequestedByObjective, hasContextualGmailReplyMention, contextualGmailReplyRecoveryReason } from './sensitive-external-action/gmail-reply-authorization.ts';
export { isSensitiveExternalActionConfirmationRequestedByObjective, isSensitiveExternalActionAuthorizedByObjective } from './sensitive-external-action/objective-authorization.ts';
