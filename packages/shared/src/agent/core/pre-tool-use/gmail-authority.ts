import type { classifySensitiveExternalAction } from "../sensitive-external-action.ts";
import { contextualGmailExactEffectExpectationFromObjective, contextualGmailReplyPreflightAttestationFromObjective, contextualGmailReplyRecoveryReason, contextualGmailTargetScopedAuthorizationSegments, externalActionAuthorityPolicySegments, isContextualGmailReplyAuthorizedByObjective, parseStructuredGmailSendResumeSegment, structuredGmailSendAuthorizationDiagnostic, type ContextualGmailReplyPreflightIntent } from "../sensitive-external-action.ts";
import { redundantlyAsksPermissionForSellsyReadOnlyOAuth } from "./autonomy-request-guards.ts";
import type { PreToolUseCheckResult, PreToolUseInput } from "./contracts.ts";
import { redundantlyAsksAboutEstablishedThirdPartyDependency } from "./dependency-guards.ts";
import { observedResolvedThirdPartyDependencies, observedThirdPartyDependencies } from "./dependency-state.ts";
import { contextualGmailObjectiveFingerprint, contextualGmailObjectiveProvidesClosedExactHumanAnchor, currentContextualGmailPreflightAttestation } from "./gmail-evidence.ts";
import { structuredGmailSendDiagnosticInput } from "./gmail-send-diagnostics.ts";
import { observedContextualGmailReads } from "./gmail-state.ts";

interface GmailAuthorityInput {
  readonly acceptedAuthorizationSegments: readonly string[];
  readonly targetScopedContextualGmailSegments: ReturnType<typeof contextualGmailTargetScopedAuthorizationSegments>;
  readonly contextualGmailPreflightTool: boolean;
  readonly policyAuthorizationSegments: ReturnType<typeof externalActionAuthorityPolicySegments>;
  readonly sensitiveAction: ReturnType<typeof classifySensitiveExternalAction>;
}

interface GmailAuthorityFacts {
  readonly contextualGmailObjective: string;
  readonly eligibleContextualGmailPreflight: ContextualGmailReplyPreflightIntent | undefined;
  readonly contextualGmailPreflightAttestation: ReturnType<typeof currentContextualGmailPreflightAttestation>;
  readonly structuredGmailSendDecision: ReturnType<typeof structuredGmailSendAuthorizationDiagnostic>['decision'];
  readonly contextualGmailPolicySegments: ReturnType<typeof contextualGmailTargetScopedAuthorizationSegments>;
  readonly contextualReplyRecovery: ReturnType<typeof contextualGmailReplyRecoveryReason>;
  readonly contextualReplyAuthorizedByObjective: boolean;
}

export function evaluateGmailAuthority(
  snapshot: Pick<PreToolUseInput,
    | 'sessionId'
    | 'toolName'
    | 'input'
    | 'dataFolderPath'
  >,
  authority: GmailAuthorityInput,
): GmailAuthorityFacts | Extract<PreToolUseCheckResult, { type: 'block' }> {
  const {
    sessionId,
    toolName,
    input,
    dataFolderPath,
  } = snapshot;
  const {
    acceptedAuthorizationSegments,
    targetScopedContextualGmailSegments,
    contextualGmailPreflightTool,
    policyAuthorizationSegments,
    sensitiveAction,
  } = authority;
  const contextualGmailObjective = contextualGmailObjectiveFingerprint(acceptedAuthorizationSegments);
  const observedDependencyState = observedThirdPartyDependencies.get(sessionId);
  const currentObservedDependencies = observedDependencyState
    && observedDependencyState.expiresAt > Date.now()
    && observedDependencyState.objectiveFingerprint === contextualGmailObjective
    ? observedDependencyState.dependencies
    : [];
  if (observedDependencyState && currentObservedDependencies.length === 0) {
    observedThirdPartyDependencies.delete(sessionId);
  }
  const observedResolvedDependencyState = observedResolvedThirdPartyDependencies.get(sessionId);
  const currentObservedResolvedDependencies = observedResolvedDependencyState
    && observedResolvedDependencyState.expiresAt > Date.now()
    && observedResolvedDependencyState.objectiveFingerprint === contextualGmailObjective
    ? observedResolvedDependencyState.dependencies
    : [];
  if (observedResolvedDependencyState && currentObservedResolvedDependencies.length === 0) {
    observedResolvedThirdPartyDependencies.delete(sessionId);
  }
  const observedRead = observedContextualGmailReads.get(sessionId);
  if (observedRead && (observedRead.expiresAt <= Date.now()
    || observedRead.objectiveFingerprint !== contextualGmailObjective)) {
    observedContextualGmailReads.delete(sessionId);
  }
  const observedContextualGmailPreflight = contextualGmailReplyPreflightAttestationFromObjective(
    toolName,
    input,
    targetScopedContextualGmailSegments,
  );
  if (contextualGmailPreflightTool
    && targetScopedContextualGmailSegments !== policyAuthorizationSegments
    && (!observedContextualGmailPreflight
      || contextualGmailExactEffectExpectationFromObjective(targetScopedContextualGmailSegments)?.expectedSenderEmail === undefined)
    && input["expectedSenderEmail"] !== undefined) {
    return {
      type: 'block',
      reason: 'Validation failed: this selected Gmail reply did not specify a From identity. Omit expectedSenderEmail and retry the same read-only preflight using the connected Gmail profile; the signed connector receipt will report its actual sender. Do not ask the user for another authorization or an internal message ID.',
    };
  }
  let eligibleContextualGmailPreflight: ContextualGmailReplyPreflightIntent | undefined;
  if (observedContextualGmailPreflight) {
    const read = observedContextualGmailReads.get(sessionId);
    const matchingRead = read && read.expiresAt > Date.now()
      && read.objectiveFingerprint === contextualGmailObjective
      && read.messageId === observedContextualGmailPreflight.messageId;
    const exactHumanAnchor = contextualGmailObjectiveProvidesClosedExactHumanAnchor(
      targetScopedContextualGmailSegments,
      observedContextualGmailPreflight,
    );
    if (matchingRead || exactHumanAnchor) {
      eligibleContextualGmailPreflight = observedContextualGmailPreflight;
    }
  }
  const contextualGmailPreflightAttestation = currentContextualGmailPreflightAttestation(
    sessionId,
    contextualGmailObjective,
  );
  if (redundantlyAsksPermissionForSellsyReadOnlyOAuth(toolName, input)) {
    return {
      type: 'block',
      reason: 'Input request rejected: a read-only Sellsy OAuth handshake is already an admitted connector observation. Start mcp__atria-sellsy__atria_sellsy_oauth_start with only read scopes, then use the provider callback if it actually requires account consent or MFA. Do not ask for an additional Robb Agents permission.',
    };
  }
  if (redundantlyAsksAboutEstablishedThirdPartyDependency(
    toolName,
    input,
    policyAuthorizationSegments,
    currentObservedDependencies,
    currentObservedResolvedDependencies,
  )) {
    return {
      type: 'block',
      reason: 'Input request rejected: the accepted objective already establishes that this exact access item is pending from an identified third party. Finish all independent safe work, report the precise external dependency and its evidence, and keep any already-authorized monitor active. Do not ask the user to choose the same wait state again.',
    };
  }
  const structuredGmailSendDiagnostic = sensitiveAction
    ? structuredGmailSendAuthorizationDiagnostic(
      toolName,
      structuredGmailSendDiagnosticInput(
        input,
        acceptedAuthorizationSegments,
        dataFolderPath,
      ),
      acceptedAuthorizationSegments,
    )
    : { decision: 'not-applicable' as const, mismatchCategories: [] };
  const structuredGmailSendDecision = structuredGmailSendDiagnostic.decision;
  let contextualGmailPolicySegments = targetScopedContextualGmailSegments;
  if (structuredGmailSendDecision === 'authorized') {
    for (let index = acceptedAuthorizationSegments.length - 1; index >= 0; index -= 1) {
      if (parseStructuredGmailSendResumeSegment(acceptedAuthorizationSegments[index] ?? '')) {
        // The closed marker is a new-send authority boundary. Historical
        // thread-reply context before it cannot reclassify this exact send,
        // while same-segment and later reply directives remain visible.
        contextualGmailPolicySegments = targetScopedContextualGmailSegments.slice(index);
        break;
      }
    }
  }
  const contextualReplyRecovery = sensitiveAction
    ? contextualGmailReplyRecoveryReason(
      toolName,
      input,
      contextualGmailPolicySegments,
      contextualGmailPreflightAttestation,
    )
    : undefined;
  const contextualReplyAuthorizedByObjective = !!sensitiveAction
    && !contextualReplyRecovery
    && isContextualGmailReplyAuthorizedByObjective(
      toolName,
      input,
      contextualGmailPolicySegments,
      contextualGmailPreflightAttestation,
    );
  // A structured restart is a closed payload contract. If the current Gmail
  // mutation diverges from it, neither the generic objective matcher nor a
  // later permission prompt may widen that exact human authorization.
  if (structuredGmailSendDecision === 'invalid') {
    const mismatchCategories = structuredGmailSendDiagnostic.mismatchCategories.length > 0
      ? structuredGmailSendDiagnostic.mismatchCategories.join(', ')
      : 'closed-contract-mismatch';
    return {
      type: 'block',
      reason: `Objective authority: this Gmail send does not exactly match the authenticated structured payload. Mismatch categories (field names only; no values reflected): ${mismatchCategories}. Canonical input contract: include exact "to", "sendAsEmail", "subject", "body", and "attachmentPaths" values from the authenticated payload, with "attachmentPaths" either empty or containing its one bounded session PDF, plus "isHtml": false; "cc" and "bcc" may be omitted or must be empty strings. Optional "requireKnownContacts", "allowExternal", and "checkContacts" must be booleans; optional "_displayName" and "_intent" must be strings. Do not include "from", "replyTo", aliases, or any unknown field. Reconcile with reads and retry only that canonical payload; do not request broader permission.`,
    };
  }
  return {
    contextualGmailObjective,
    eligibleContextualGmailPreflight,
    contextualGmailPreflightAttestation,
    structuredGmailSendDecision,
    contextualGmailPolicySegments,
    contextualReplyRecovery,
    contextualReplyAuthorizedByObjective,
  };
}
