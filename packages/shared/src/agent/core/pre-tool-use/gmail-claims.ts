import type { PreToolUseCheckResult, PreToolUseInput } from "./contracts.ts";
import { hashSensitiveExternalActionOperation } from "./external-action-hash.ts";
import { contextualGmailObjectiveFingerprint } from "./gmail-evidence.ts";
import type { ContextualGmailToolUseClaim } from "./gmail-state.ts";
import { CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS, CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS, contextualGmailPreflightAttestations, contextualGmailSessionsPendingFinalCleanup, contextualGmailToolUseClaims, inFlightContextualGmailReplies, pendingContextualGmailPreflights } from "./gmail-state.ts";

interface GmailClaimInput {
  readonly acceptedAuthorizationSegments: readonly string[];
}

export function claimGmailToolUse(
  snapshot: Pick<PreToolUseInput,
    | 'toolName'
    | 'sessionId'
    | 'toolUseId'
    | 'input'
    | 'sourceActivationReentry'
    | 'permissionApprovalReentry'
  >,
  authority: GmailClaimInput,
): {
  readonly contextualGmailPreflightTool: boolean;
  readonly contextualGmailToolUseClaim: ContextualGmailToolUseClaim | undefined;
} | Extract<PreToolUseCheckResult, { type: 'block' }> {
  const {
    toolName,
    sessionId,
    toolUseId,
    input,
    sourceActivationReentry = false,
    permissionApprovalReentry = false,
  } = snapshot;
  const {
    acceptedAuthorizationSegments,
  } = authority;
  const contextualGmailPreflightTool = CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS.has(toolName);
  const contextualGmailBoundTool = CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(toolName);
  const contextualGmailLifecycleTool = contextualGmailPreflightTool || contextualGmailBoundTool;
  if (contextualGmailLifecycleTool
    && contextualGmailSessionsPendingFinalCleanup.has(sessionId)) {
    return {
      type: 'block',
      reason: 'Validation failed: this session is being permanently destroyed. No new Gmail preflight or bound reply may start while its exact runtime cleanup is pending.',
    };
  }
  if (contextualGmailPreflightTool && !toolUseId) {
    return {
      type: 'block',
      reason: 'Validation failed: a Gmail reply preflight requires one host-issued toolUseId so its result can be correlated without invalidating or replacing existing exact-once authority. Retry through the canonical connector call; do not use another send path or browser fallback.',
    };
  }
  if (contextualGmailBoundTool && !toolUseId) {
    return {
      type: 'block',
      reason: 'Validation failed: a bound Gmail reply requires one host-issued toolUseId so its signed preflight attestation can be reserved and consumed exactly once. Retry through the canonical connector call; do not use another send path or browser fallback.',
    };
  }
  let contextualGmailToolUseClaim: ContextualGmailToolUseClaim | undefined;
  if (contextualGmailLifecycleTool && toolUseId) {
    const claimKey = `${sessionId}:${toolUseId}`;
    const objectiveFingerprint = contextualGmailObjectiveFingerprint(acceptedAuthorizationSegments);
    const operationHash = hashSensitiveExternalActionOperation(toolName, input);
    const existingClaim = contextualGmailToolUseClaims.get(claimKey);
    const validSourceActivationReentry = sourceActivationReentry
      && existingClaim?.phase === 'awaiting-source-reentry'
      && !existingClaim.sourceActivationReentryConsumed
      && existingClaim.toolName === toolName
      && existingClaim.operationHash === operationHash
      && existingClaim.objectiveFingerprint === objectiveFingerprint;
    const validPermissionApprovalReentry = permissionApprovalReentry
      && !!existingClaim
      && (existingClaim.phase === 'claimed' || existingClaim.phase === 'admitted')
      && existingClaim.toolName === toolName
      && existingClaim.operationHash === operationHash
      && existingClaim.objectiveFingerprint === objectiveFingerprint;
    if (!existingClaim) {
      contextualGmailToolUseClaim = {
        objectiveFingerprint,
        operationHash,
        phase: 'claimed',
        sourceActivationReentryConsumed: false,
        toolName,
      };
      contextualGmailToolUseClaims.set(claimKey, contextualGmailToolUseClaim);
    } else if (validSourceActivationReentry) {
      existingClaim.phase = 'claimed';
      existingClaim.sourceActivationReentryConsumed = true;
      contextualGmailToolUseClaim = existingClaim;
    } else if (validPermissionApprovalReentry) {
      contextualGmailToolUseClaim = existingClaim;
    } else {
      existingClaim.phase = 'poisoned';
      pendingContextualGmailPreflights.delete(claimKey);
      contextualGmailPreflightAttestations.delete(sessionId);
      const collidingInFlight = inFlightContextualGmailReplies.get(sessionId);
      if (collidingInFlight?.toolUseId === toolUseId) collidingInFlight.poisoned = true;
      return {
        type: 'block',
        reason: 'Validation failed: this host-issued Gmail lifecycle toolUseId was already claimed. The id is now poisoned because delayed terminal results cannot be attributed to one occurrence; use a new canonical tool call id after any in-flight reply reaches a terminal result or the runtime is safely restarted.',
      };
    }
  }
  const inFlightContextualGmailReply = contextualGmailLifecycleTool
    ? inFlightContextualGmailReplies.get(sessionId)
    : undefined;
  if (inFlightContextualGmailReply
    && !(permissionApprovalReentry && inFlightContextualGmailReply.toolUseId === toolUseId
      && inFlightContextualGmailReply.toolName === toolName
      && inFlightContextualGmailReply.operationHash
        === hashSensitiveExternalActionOperation(toolName, input))) {
    return {
      type: 'block',
      reason: contextualGmailPreflightTool
        ? 'Validation failed: another bound Gmail reply is still in flight for this session. Wait for its terminal host result, then run one fresh canonical preflight; an absence check made while the prior mutation is unresolved cannot authorize a later reply.'
        : 'Validation failed: another bound Gmail reply is still in flight for this session. Wait for its terminal host result before attempting any later reply; do not start a second mutation or use another send path.',
    };
  }
  return {
    contextualGmailPreflightTool,
    contextualGmailToolUseClaim,
  };
}
