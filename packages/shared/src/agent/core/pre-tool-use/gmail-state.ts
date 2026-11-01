import { type ContextualGmailReplyPreflightAttestation, type ContextualGmailReplyPreflightIntent } from "../sensitive-external-action.ts";

export const CONTEXTUAL_GMAIL_PREFLIGHT_ATTESTATION_TTL_MS = 15 * 60 * 1000;

export const CONTEXTUAL_GMAIL_BINDING_MAX_TTL_MS = 10 * 60 * 1000;

export const CONTEXTUAL_GMAIL_BINDING_FUTURE_SKEW_MS = 30 * 1000;

export const GMAIL_API_MESSAGE_ID = /^[0-9a-f]{12,32}$/iu;

export const CONTEXTUAL_GMAIL_READ_TOOLS = new Set([
  'mcp__google-contacts__gmail_get_message',
  'mcp__google-contacts__gmail_get_message_by_url',
  'mcp__orion-mcp__orion_mcp_read',
  'mcp__orion-mcp__orion_mcp_call',
]);

export const CONTEXTUAL_GMAIL_PREFLIGHT_TOOLS = new Set([
  'mcp__google-contacts__gmail_reply_preflight',
  'mcp__google-contacts__gmail_reply_all_preflight',
]);

export const CONTEXTUAL_GMAIL_BOUND_REPLY_TOOLS = new Set([
  'mcp__google-contacts__gmail_reply_bound',
  'mcp__google-contacts__gmail_reply_all',
]);

export const pendingContextualGmailPreflights = new Map<string, {
  expiresAt: number;
  generation: number;
  intent: ContextualGmailReplyPreflightIntent;
  policySegments: readonly string[];
  objectiveFingerprint: string;
}>();

export const observedContextualGmailReads = new Map<string, {
  expiresAt: number;
  messageId: string;
  toolUseId: string;
  objectiveFingerprint: string;
}>();

export const contextualGmailPreflightAttestations = new Map<string, {
  expiresAt: number;
  generation: number;
  value: ContextualGmailReplyPreflightAttestation;
  objectiveFingerprint: string;
}>();

export const reservedContextualGmailReplyAttestations = new Map<string, {
  expiresAt: number;
  generation: number;
  value: ContextualGmailReplyPreflightAttestation;
  objectiveFingerprint: string;
}>();

export const contextualGmailPreflightGenerations = new Map<string, number>();

export interface ContextualGmailToolUseClaim {
  objectiveFingerprint: string;
  operationHash: string;
  phase: 'claimed' | 'awaiting-source-reentry' | 'admitted' | 'terminal' | 'poisoned';
  sourceActivationReentryConsumed: boolean;
  toolName: string;
}

export const contextualGmailToolUseClaims = new Map<string, ContextualGmailToolUseClaim>();

export const inFlightContextualGmailReplies = new Map<string, {
  generation: number;
  hostExecutionToken?: string;
  invalidated: boolean;
  operationHash: string;
  poisoned: boolean;
  possiblyExecuted: boolean;
  runtimeId?: string;
  toolName: string;
  toolUseId: string;
}>();

/**
 * Definitive session deletion is distinct from a backend runtime restart.
 * When a bound host call is still unresolved, retain its exact correlation
 * until either its ticket settles or its runtime is confirmed dead, then purge
 * every remaining session-scoped tombstone and observation.
 */
export const contextualGmailSessionsPendingFinalCleanup = new Map<string, {
  runtimeId?: string;
  runtimeTeardownConfirmed: boolean;
}>();
