import { randomUUID } from "node:crypto";
import { hashSensitiveExternalActionOperation } from './external-action-hash.ts';
import { maybeFinalizeContextualGmailSessionCleanup } from './gmail-cleanup.ts';
import { CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS, contextualGmailPreflightAttestations, contextualGmailPreflightGenerations, contextualGmailSessionsPendingFinalCleanup, contextualGmailToolUseClaims, inFlightContextualGmailReplies, reservedContextualGmailReplyAttestations } from './gmail-state.ts';

export interface ContextualGmailHostExecutionTicket {
  readonly generation: number;
  readonly hostExecutionToken: string;
  readonly runtimeId: string;
  readonly sessionId: string;
  readonly toolUseId: string;
}

export type ContextualGmailHostExecutionDecision =
  | { applies: false; allowed: true }
  | { applies: true; allowed: false; reason: string }
  | { applies: true; allowed: true; ticket: ContextualGmailHostExecutionTicket };

/** Read-only runtime correlation used to decide whether Stop must kill a host runtime. */
export function hasContextualGmailInFlightForRuntime(input: {
  sessionId: string;
  runtimeId: string;
}): boolean {
  return inFlightContextualGmailReplies.get(input.sessionId)?.runtimeId === input.runtimeId;
}

/**
 * Atomically cross the last host boundary before invoking a bound Gmail
 * mutation. The pre-tool reservation is correlated by runtime, operation hash
 * and (when available) the SDK tool-use id. An omitted id is safe only because
 * a session can hold at most one in-flight reply and the exact operation still
 * has to match.
 */
export function beginContextualGmailHostExecution(input: {
  sessionId: string;
  runtimeId?: string;
  toolUseId?: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}): ContextualGmailHostExecutionDecision {
  if (!CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS.has(input.toolName)) {
    return { applies: false, allowed: true };
  }

  const inFlight = inFlightContextualGmailReplies.get(input.sessionId);
  const exactOperationHash = hashSensitiveExternalActionOperation(input.toolName, input.toolInput);
  const reservationKey = inFlight
    ? `${input.sessionId}:${inFlight.toolUseId}`
    : undefined;
  const exactClaim = inFlight
    ? contextualGmailToolUseClaims.get(reservationKey!)
    : undefined;
  if (!input.runtimeId
    || !inFlight
    || inFlight.runtimeId !== input.runtimeId
    || inFlight.toolName !== input.toolName
    || inFlight.operationHash !== exactOperationHash
    || (input.toolUseId !== undefined && input.toolUseId !== inFlight.toolUseId)
    || inFlight.invalidated
    || inFlight.poisoned
    || exactClaim?.phase !== 'admitted') {
    return {
      applies: true,
      allowed: false,
      reason: 'Validation failed: this bound Gmail host call has no exact admitted reservation for the current runtime, tool id and payload. Do not execute it or use another send path; run one fresh canonical preflight when no prior mutation remains in flight.',
    };
  }
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey!);
  const generation = contextualGmailPreflightGenerations.get(input.sessionId);
  if (!reserved
    || reserved.expiresAt <= Date.now()
    || reserved.generation !== inFlight.generation
    || generation !== inFlight.generation) {
    // The exact host invocation is known not to have started, so an expired or
    // otherwise invalid reservation can be consumed safely. Never restore it.
    reservedContextualGmailReplyAttestations.delete(reservationKey!);
    contextualGmailPreflightAttestations.delete(input.sessionId);
    inFlightContextualGmailReplies.delete(input.sessionId);
    exactClaim.phase = 'terminal';
    maybeFinalizeContextualGmailSessionCleanup(input.sessionId);
    return {
      applies: true,
      allowed: false,
      reason: 'Validation failed: the exact Gmail host reservation expired or is no longer the current generation. No host call started. Run one fresh canonical preflight before retrying.',
    };
  }
  if (inFlight.hostExecutionToken) {
    return {
      applies: true,
      allowed: false,
      reason: 'Validation failed: the admitted bound Gmail reply already entered host execution. A duplicate host start is blocked until the exact execution ticket settles.',
    };
  }

  const hostExecutionToken = randomUUID();
  inFlight.hostExecutionToken = hostExecutionToken;
  inFlight.possiblyExecuted = true;
  return {
    applies: true,
    allowed: true,
    ticket: {
      generation: inFlight.generation,
      hostExecutionToken,
      runtimeId: input.runtimeId,
      sessionId: input.sessionId,
      toolUseId: inFlight.toolUseId,
    },
  };
}

/**
 * Consume the authority represented by exactly one host execution ticket.
 * This is intentionally outcome-agnostic: once the host call started, a
 * transport error cannot prove that Gmail observed no effect. A retry therefore
 * requires a fresh canonical preflight and exact-effect reconciliation.
 */
export function settleContextualGmailHostExecution(
  ticket: ContextualGmailHostExecutionTicket,
): boolean {
  const inFlight = inFlightContextualGmailReplies.get(ticket.sessionId);
  if (!inFlight
    || inFlight.toolUseId !== ticket.toolUseId
    || inFlight.runtimeId !== ticket.runtimeId
    || inFlight.generation !== ticket.generation
    || inFlight.hostExecutionToken !== ticket.hostExecutionToken) {
    return false;
  }

  const reservationKey = `${ticket.sessionId}:${ticket.toolUseId}`;
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
  if (reserved?.generation === ticket.generation) {
    reservedContextualGmailReplyAttestations.delete(reservationKey);
  }
  contextualGmailPreflightAttestations.delete(ticket.sessionId);
  inFlightContextualGmailReplies.delete(ticket.sessionId);
  const claim = contextualGmailToolUseClaims.get(reservationKey);
  if (claim && claim.phase !== 'poisoned') claim.phase = 'terminal';
  maybeFinalizeContextualGmailSessionCleanup(ticket.sessionId);
  return true;
}

/**
 * Confirm that a backend runtime can no longer start host work. Teardown may
 * release its own admitted reservation only before host execution began; a
 * started call stays fail-closed until its exact ticket settles.
 */
export function confirmContextualGmailRuntimeTeardown(input: {
  sessionId: string;
  runtimeId: string;
}): boolean {
  const pendingCleanup = contextualGmailSessionsPendingFinalCleanup.get(input.sessionId);
  if (pendingCleanup?.runtimeId === input.runtimeId) {
    pendingCleanup.runtimeTeardownConfirmed = true;
    maybeFinalizeContextualGmailSessionCleanup(input.sessionId);
  }
  const inFlight = inFlightContextualGmailReplies.get(input.sessionId);
  if (!inFlight
    || inFlight.runtimeId !== input.runtimeId
    || inFlight.hostExecutionToken
    || inFlight.possiblyExecuted) {
    return false;
  }

  const reservationKey = `${input.sessionId}:${inFlight.toolUseId}`;
  const reserved = reservedContextualGmailReplyAttestations.get(reservationKey);
  if (reserved?.generation === inFlight.generation) {
    reservedContextualGmailReplyAttestations.delete(reservationKey);
  }
  contextualGmailPreflightAttestations.delete(input.sessionId);
  inFlightContextualGmailReplies.delete(input.sessionId);
  const claim = contextualGmailToolUseClaims.get(reservationKey);
  if (claim && claim.phase !== 'poisoned') claim.phase = 'terminal';
  maybeFinalizeContextualGmailSessionCleanup(input.sessionId);
  return true;
}
