import { type PermissionMode } from "../../mode-manager.ts";
import { hashSensitiveExternalActionOperation } from './external-action-hash.ts';
import { maybeFinalizeContextualGmailSessionCleanup } from './gmail-cleanup.ts';
import { contextualGmailObjectiveFingerprint } from './gmail-evidence.ts';
import { CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS, contextualGmailPreflightAttestations, contextualGmailPreflightGenerations, contextualGmailToolUseClaims, inFlightContextualGmailReplies, reservedContextualGmailReplyAttestations } from './gmail-state.ts';

export interface ContextualGmailPromptReservationDecision {
  applies: boolean;
  allowed: boolean;
  reason?: string;
}

/**
 * Resolve an Ask-mode decision for a Gmail reply already reserved by the
 * pre-tool pipeline. Backends resume approved prompts directly, so this is the
 * last host-side boundary at which the signed binding, objective and exact-once
 * reservation can be revalidated after an arbitrarily long user wait.
 */
export function resolveContextualGmailPromptReservation(input: {
  sessionId: string;
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  approved: boolean;
  /** Effective host mode at the instant the delayed decision is consumed. */
  permissionMode?: PermissionMode;
  /** Active host sources at the instant the delayed decision is consumed. */
  activeSourceSlugs?: readonly string[];
  objectiveAuthorizationSegments?: readonly string[];
}): ContextualGmailPromptReservationDecision {
  const { sessionId, toolUseId, toolName, toolInput, approved } = input;
  if (!toolUseId || !CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(toolName)) {
    return { applies: false, allowed: approved };
  }

  const reservationKey = `${sessionId}:${toolUseId}`;
  const claim = contextualGmailToolUseClaims.get(reservationKey);
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
  const inFlight = inFlightContextualGmailReplies.get(sessionId);
  const applies = claim?.toolName === toolName
    || reserved !== undefined
    || inFlight?.toolUseId === toolUseId;
  if (!applies) return { applies: false, allowed: approved };

  const now = Date.now();
  const generation = contextualGmailPreflightGenerations.get(sessionId);
  const objectiveFingerprint = contextualGmailObjectiveFingerprint(
    input.objectiveAuthorizationSegments ?? [],
  );
  const validApproval = claim?.phase === 'admitted'
    && claim?.toolName === toolName
    && claim.operationHash === hashSensitiveExternalActionOperation(toolName, toolInput)
    && claim.objectiveFingerprint === objectiveFingerprint
    && input.permissionMode !== undefined
    && input.permissionMode !== 'safe'
    && input.activeSourceSlugs?.includes('google-contacts') === true
    && reserved !== undefined
    && reserved.expiresAt > now
    && reserved.generation === generation
    && reserved.objectiveFingerprint === objectiveFingerprint
    && inFlight?.toolUseId === toolUseId
    && inFlight.generation === generation
    && !inFlight.invalidated
    && !inFlight.poisoned;

  if (approved && validApproval) return { applies: true, allowed: true };

  // A prompt rejection, expiry or objective change proves that this reserved
  // invocation did not execute. Release only an unpoisoned exact match; a
  // collided id remains locked until confirmed runtime teardown because its
  // terminal events are indistinguishable.
  if (claim?.phase !== 'poisoned' && !inFlight?.poisoned) {
    reservedContextualGmailReplyAttestations.delete(reservationKey);
    if (inFlight?.toolUseId === toolUseId) inFlightContextualGmailReplies.delete(sessionId);
    if (claim) claim.phase = 'terminal';

    const canRestoreAfterDenial = !approved
      && reserved !== undefined
      && reserved.expiresAt > now
      && reserved.generation === generation
      && reserved.objectiveFingerprint === objectiveFingerprint
      && !inFlight?.invalidated
      && !contextualGmailPreflightAttestations.has(sessionId);
    if (canRestoreAfterDenial) {
      contextualGmailPreflightAttestations.set(sessionId, reserved);
    }
    maybeFinalizeContextualGmailSessionCleanup(sessionId);
  }

  if (!approved) return { applies: true, allowed: false };
  return {
    applies: true,
    allowed: false,
    reason: 'Validation failed: the signed Gmail preflight reservation expired, changed objective, lost its exact host correlation, entered Explore mode, or lost its active Gmail source while awaiting approval. No reply was executed. Run one fresh canonical preflight after restoring the required mode and source before retrying; do not use a browser or another send path.',
  };
}
