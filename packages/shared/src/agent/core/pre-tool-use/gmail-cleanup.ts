import { observedResolvedThirdPartyDependencies, observedThirdPartyDependencies } from './dependency-state.ts';
import { contextualGmailPreflightAttestations, contextualGmailPreflightGenerations, contextualGmailSessionsPendingFinalCleanup, contextualGmailToolUseClaims, inFlightContextualGmailReplies, observedContextualGmailReads, pendingContextualGmailPreflights, reservedContextualGmailReplyAttestations } from './gmail-state.ts';

/**
 * Discard only transient Gmail exact-once mutation state after an interrupted
 * tool runtime. Keep independently observed third-party dependency evidence:
 * an abort/restart must not make the agent ask the user about the same known
 * vendor wait state again.
 */
export function clearContextualGmailMutationLifecycleState(sessionId: string): void {
  contextualGmailPreflightAttestations.delete(sessionId);
  contextualGmailPreflightGenerations.delete(sessionId);
  inFlightContextualGmailReplies.delete(sessionId);
  observedContextualGmailReads.delete(sessionId);
  for (const key of pendingContextualGmailPreflights.keys()) {
    if (key.startsWith(`${sessionId}:`)) pendingContextualGmailPreflights.delete(key);
  }
  for (const key of reservedContextualGmailReplyAttestations.keys()) {
    if (key.startsWith(`${sessionId}:`)) reservedContextualGmailReplyAttestations.delete(key);
  }
  maybeFinalizeContextualGmailSessionCleanup(sessionId);
}

/** Session destruction/tests can explicitly discard every session-scoped observation. */
export function clearContextualGmailPreflightAttestation(sessionId: string): void {
  contextualGmailSessionsPendingFinalCleanup.delete(sessionId);
  clearContextualGmailMutationLifecycleState(sessionId);
  for (const key of contextualGmailToolUseClaims.keys()) {
    if (key.startsWith(`${sessionId}:`)) contextualGmailToolUseClaims.delete(key);
  }
  observedThirdPartyDependencies.delete(sessionId);
  observedResolvedThirdPartyDependencies.delete(sessionId);
}

export function maybeFinalizeContextualGmailSessionCleanup(sessionId: string): void {
  const pendingCleanup = contextualGmailSessionsPendingFinalCleanup.get(sessionId);
  if (!pendingCleanup
    || inFlightContextualGmailReplies.has(sessionId)
    || pendingCleanup.runtimeId && !pendingCleanup.runtimeTeardownConfirmed) return;
  clearContextualGmailPreflightAttestation(sessionId);
}

/**
 * Request definitive cleanup for a deleted session. Unlike a runtime
 * invalidation, this eventually removes dependency observations and tool-id
 * tombstones too. An unresolved host mutation remains fail-closed until its
 * exact ticket or confirmed runtime teardown proves the terminal boundary.
 */
export function destroyContextualGmailSessionState(sessionId: string): void {
  const inFlight = inFlightContextualGmailReplies.get(sessionId);
  contextualGmailSessionsPendingFinalCleanup.set(sessionId, {
    ...(inFlight?.runtimeId !== undefined ? { runtimeId: inFlight?.runtimeId } : {}),
    runtimeTeardownConfirmed: !inFlight?.runtimeId,
  });
  invalidateContextualGmailSessionState(sessionId);
  maybeFinalizeContextualGmailSessionCleanup(sessionId);
}

/**
 * Invalidate reusable session evidence without making an unresolved host
 * mutation disappear. Backend instances call this when a session runtime is
 * destroyed or recreated; the matching runtime teardown/ticket is the only
 * authority that may release an in-flight reply.
 */
export function invalidateContextualGmailSessionState(sessionId: string): void {
  contextualGmailPreflightAttestations.delete(sessionId);
  observedContextualGmailReads.delete(sessionId);
  for (const key of pendingContextualGmailPreflights.keys()) {
    if (key.startsWith(`${sessionId}:`)) pendingContextualGmailPreflights.delete(key);
  }

  const inFlight = inFlightContextualGmailReplies.get(sessionId);
  if (inFlight) inFlight.invalidated = true;
  const preservedKey = inFlight ? `${sessionId}:${inFlight.toolUseId}` : undefined;
  for (const key of reservedContextualGmailReplyAttestations.keys()) {
    if (key.startsWith(`${sessionId}:`) && key !== preservedKey) {
      reservedContextualGmailReplyAttestations.delete(key);
    }
  }
  for (const key of contextualGmailToolUseClaims.keys()) {
    if (key.startsWith(`${sessionId}:`) && key !== preservedKey) {
      contextualGmailToolUseClaims.delete(key);
    }
  }
  if (!inFlight) contextualGmailPreflightGenerations.delete(sessionId);
}
