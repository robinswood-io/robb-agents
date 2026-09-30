/**
 * Session utility functions
 */

import {
  SESSION_PERSISTENT_FIELDS,
  type ContextCompactionAttemptState,
  type ContextCompactionIssueCode,
  type ContextCompactionOutcome,
  type SessionPersistentField,
} from './types.js';

const CONTEXT_COMPACTION_OUTCOMES = new Set<ContextCompactionOutcome>([
  'succeeded',
  'ineffective',
  'unverified',
  'failed',
  'skipped-not-needed',
]);
const CONTEXT_COMPACTION_ISSUE_CODES = new Set<ContextCompactionIssueCode>([
  'timeout',
  'not-needed',
  'authentication',
  'aborted',
  'backend-error',
]);

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const identifier = value.trim();
  return identifier.length > 0 && identifier.length <= 256 && !/[\u0000-\u001f\u007f]/.test(identifier)
    ? identifier
    : undefined;
}

/**
 * Accept only the fixed scalar compaction receipt. This strips provider text,
 * extension objects, unsafe numbers, and unknown classifications before a
 * session header is written or hydrated.
 */
export function sanitizeContextCompactionAttemptState(
  value: unknown,
): ContextCompactionAttemptState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const source = value as Record<string, unknown>;
  const attemptedAt = nonNegativeSafeInteger(source.attemptedAt);
  const contextTokensBefore = nonNegativeSafeInteger(source.contextTokensBefore);
  const contextTokensAfter = nonNegativeSafeInteger(source.contextTokensAfter);
  const providerContextBaselineTokens = nonNegativeSafeInteger(source.providerContextBaselineTokens);
  const providerBaselineAdmissionDispatchedAt = nonNegativeSafeInteger(
    source.providerBaselineAdmissionDispatchedAt,
  );
  const objectiveRootId = boundedIdentifier(source.objectiveRootId);
  const outcome = typeof source.outcome === 'string'
    && CONTEXT_COMPACTION_OUTCOMES.has(source.outcome as ContextCompactionOutcome)
    ? source.outcome as ContextCompactionOutcome
    : undefined;
  if (attemptedAt === undefined || contextTokensBefore === undefined || !outcome) return undefined;

  const hardLimitTokens = nonNegativeSafeInteger(source.hardLimitTokens);
  const classifiedIssueCode = typeof source.issueCode === 'string'
    && CONTEXT_COMPACTION_ISSUE_CODES.has(source.issueCode as ContextCompactionIssueCode)
    ? source.issueCode as ContextCompactionIssueCode
    : undefined;
  const issueCode = outcome === 'skipped-not-needed'
    ? (classifiedIssueCode === 'not-needed' ? classifiedIssueCode : undefined)
    : (outcome === 'failed' && classifiedIssueCode !== 'not-needed' ? classifiedIssueCode : undefined);

  return {
    attemptedAt,
    contextTokensBefore,
    ...(outcome === 'succeeded' && contextTokensAfter !== undefined
      && contextTokensAfter < contextTokensBefore ? { contextTokensAfter } : {}),
    outcome,
    ...(objectiveRootId ? { objectiveRootId } : {}),
    ...(outcome === 'succeeded' && providerContextBaselineTokens !== undefined
      && providerContextBaselineTokens > 0
      ? { providerContextBaselineTokens }
      : outcome === 'succeeded' && source.awaitingProviderContextBaseline === true
        ? { awaitingProviderContextBaseline: true as const }
        : {}),
    ...(outcome === 'succeeded' && source.awaitingProviderContextBaseline === true
      && providerContextBaselineTokens === undefined
      && providerBaselineAdmissionDispatchedAt !== undefined
      ? { providerBaselineAdmissionDispatchedAt }
      : {}),
    ...(hardLimitTokens !== undefined && hardLimitTokens > 0 ? { hardLimitTokens } : {}),
    ...(source.hardLimitFollowUpAttempted === true ? { hardLimitFollowUpAttempted: true as const } : {}),
    ...(source.hardLimitRecoveryAttempted === true ? { hardLimitRecoveryAttempted: true as const } : {}),
    ...(issueCode ? { issueCode } : {}),
  };
}

/**
 * Pick persistent fields from a session-like object.
 * Used by createSessionHeader, readSessionJsonl, getSessions, getSession
 * to ensure all persistent fields are included consistently.
 *
 * @param source - Object containing session fields
 * @returns Object with only the persistent fields that exist in source
 */
export function pickSessionFields<T extends object>(
  source: T
): Partial<Record<SessionPersistentField, unknown>> {
  const result: Partial<Record<SessionPersistentField, unknown>> = {};
  for (const field of SESSION_PERSISTENT_FIELDS) {
    if (!(field in source)) continue;
    const value = (source as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (field === 'contextCompactionAttempt') {
      const sanitized = sanitizeContextCompactionAttemptState(value);
      if (sanitized) result[field] = sanitized;
      continue;
    }
    result[field] = value;
  }
  return result;
}
