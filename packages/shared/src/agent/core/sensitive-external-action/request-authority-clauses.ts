import { GENERIC_MUTATION_TERM_ALIASES } from './action-vocabulary.ts';
import { ACTION_DETAILS, UNRESOLVED_TARGET_SENTINELS, structuredGmailPolicyRequest } from './host-authorization.ts';
import { containsNonNegatedPhrase, containsPhrase, directInvoiceEmailFulfillmentRequester, explicitConditionalTargetValues, isNonAuthorizingRequest, requestClauses, targetIsNamed, targetIsNegatedInClause } from './request-authorization.ts';
import { isTargetFreeGenericContinuation } from './structured-gmail-send.ts';
import { normalizeForMatch } from './target-syntax.ts';
import type { SensitiveExternalAction } from './types.ts';

function authorizingRequestClauses(
  action: SensitiveExternalAction,
  rawRequest: string,
): string[] {
  return requestClauses(rawRequest).filter(clause => (
    requestNamesSensitiveAction(action, normalizeForMatch(clause))
  ));
}

export function requestMatchesConditionalTargets(
  action: SensitiveExternalAction,
  rawRequest: string,
): boolean {
  const conditionalTargets = action.conditionalTargetCandidates ?? [];
  const clauses = authorizingRequestClauses(action, rawRequest);
  for (const kind of ['contract', 'document', 'envelope'] as const) {
    const allExplicitValues = explicitConditionalTargetValues(rawRequest, kind);
    if (allExplicitValues.length === 0) continue;
    const explicitValues = [...new Set(clauses.flatMap(clause => (
      explicitConditionalTargetValues(clause, kind)
        .filter(value => !targetIsNegatedInClause(clause, value))
    )))];
    const payloadValues = conditionalTargets
      .filter(candidate => candidate.kind === kind)
      .map(candidate => candidate.value.toLowerCase());
    // Once the user binds an operation to a typed object ID, the concrete
    // request must expose that same kind of ID. Absence is not proof of a
    // match, and every ID carried by the payload/URL must stay within the
    // explicitly authorized set.
    if (payloadValues.length === 0
      || payloadValues.some(value => !explicitValues.includes(value))) return false;
  }
  return true;
}

export function requestNamesSensitiveAction(
  action: SensitiveExternalAction,
  normalizedRequest: string,
): boolean {
  return (action.authorizationTermGroups ?? ACTION_DETAILS[action.category].authorizationTermGroups).every(group =>
    group.some(term => containsNonNegatedPhrase(normalizedRequest, term))
  );
}

function requestMentionsSensitiveAction(
  action: SensitiveExternalAction,
  normalizedRequest: string,
): boolean {
  return (action.authorizationTermGroups ?? ACTION_DETAILS[action.category].authorizationTermGroups).every(group =>
    group.some(term => containsPhrase(normalizedRequest, term))
  );
}

export function requestNamesSensitiveActionCategory(
  action: SensitiveExternalAction,
  normalizedRequest: string,
): boolean {
  if (action.category !== 'external_mutation') {
    return requestMentionsSensitiveAction(action, normalizedRequest);
  }
  return requestMentionsSensitiveAction(action, normalizedRequest)
    || Object.values(GENERIC_MUTATION_TERM_ALIASES).some(terms =>
    terms.some(term => containsPhrase(normalizedRequest, term))
  ) || ACTION_DETAILS.external_mutation.authorizationTermGroups.some(terms =>
    terms.some(term => containsPhrase(normalizedRequest, term))
  );
}

/**
 * A current user request authorizes the action only when it explicitly names
 * both the action category and a concrete target/audience derived from the
 * tool call. Generic continuations never count as authorization.
 */
export function isSensitiveExternalActionExplicitlyAuthorized(
  action: SensitiveExternalAction,
  currentUserRequest?: string,
): boolean {
  const rawRequest = structuredGmailPolicyRequest(currentUserRequest ?? '');
  const normalizedRequest = normalizeForMatch(rawRequest);
  if (
    !normalizedRequest
    || isTargetFreeGenericContinuation(normalizedRequest)
    || isNonAuthorizingRequest(rawRequest, normalizedRequest)
  ) return false;

  const delegatedInvoiceRequester = directInvoiceEmailFulfillmentRequester(rawRequest);
  if (delegatedInvoiceRequester !== undefined) {
    return action.category === 'external_send'
      && action.boundedSessionPdfAttachment === true
      && action.targetCandidates.length === 1
      && action.targetCandidates[0]?.toLowerCase() === delegatedInvoiceRequester;
  }

  // A bounded session PDF is still content disclosure. Generic send authority
  // is sufficient only when the same authenticated request explicitly names
  // the invoice PDF deliverable; otherwise the attachment remains blocked.
  if (action.boundedSessionPdfAttachment
    && !(/\b(?:facture|invoice)\b/u.test(normalizedRequest)
      && /\bpdf\b/u.test(normalizedRequest))) return false;

  const actionNamed = requestNamesSensitiveAction(action, normalizedRequest);
  if (!actionNamed || action.targetCandidates.length === 0) return false;
  if (action.targetCandidates.some(target => UNRESOLVED_TARGET_SENTINELS.has(target))) return false;
  if (!requestMatchesConditionalTargets(action, rawRequest)) return false;

  // A later prohibition in the same user turn revokes an earlier positive
  // sentence. Never authorize by cherry-picking only the positive clause.
  const allClauses = requestClauses(rawRequest);
  const allConditionalTargets = (action.conditionalTargetCandidates ?? [])
    .map(candidate => candidate.value);
  if ([...action.targetCandidates, ...allConditionalTargets].some(target =>
    allClauses.some(clause => targetIsNamed(clause, target)
      && targetIsNegatedInClause(clause, target))
  )) return false;

  // Every concrete recipient/remote/account extracted from the call is part of
  // its authority boundary. Naming one `to` address must never authorize an
  // additional CC/BCC recipient or a different nested remote target.
  const clauses = authorizingRequestClauses(action, rawRequest);
  return action.targetCandidates.every(target => clauses.some(clause => (
    targetIsNamed(clause, target) && !targetIsNegatedInClause(clause, target)
  )));
}
