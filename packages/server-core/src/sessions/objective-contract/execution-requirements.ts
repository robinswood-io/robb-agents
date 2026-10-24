import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { objectiveAmendmentAuthorityText, objectiveAuthorityAmendments } from './amendment-authority.ts';
import { amendmentEvidenceRequests, isChatResponseOnlyEdit } from './amendment-intent.ts';
import { isExplicitReadOnlyReview } from './closure-intent.ts';
import { isObjectiveMutationRequested } from './execution-authority.ts';
import { explicitlyRevokesExecutionAuthority, latestClauseRequestsExecution } from './execution-revocation.ts';
import { hasNonAuthoritativeStructuredLead } from './instruction-clause-syntax.ts';
import { DEV_LOGIN_REACTIVATION_REQUEST, canonicalizeMisspelledSendImperative, isDirectAutomatedFormCreationRequest, isDirectInvoiceEmailFulfillmentRequest, isLegacyPlanImplementationRequest } from './request-intent.ts';

/** Correct legacy intent flags at evaluation time without rewriting saved objectives. */
export function objectiveRequiresExecutionEvidence(objective: ActiveSessionObjective, fallbackText?: string): boolean {
  let amendmentDecision: boolean | undefined;
  const authorityAmendments = objectiveAuthorityAmendments(objective);
  for (let index = authorityAmendments.length - 1; index >= 0; index--) {
    const text = objectiveAmendmentAuthorityText(authorityAmendments[index]!.text);
    if (explicitlyRevokesExecutionAuthority(text)) {
      amendmentDecision = false;
      break;
    }
    if (isLegacyPlanImplementationRequest(text)
      || amendmentEvidenceRequests(text, objective.delegatedRole).execution
      || latestClauseRequestsExecution(text, objective.delegatedRole)) {
      amendmentDecision = true;
      break;
    }
  }
  const originalText = objectiveAmendmentAuthorityText(objective.originalText ?? fallbackText ?? '');
  const originalStillRequiresExecution = originalText?.trim()
    ? (isObjectiveMutationRequested(originalText)
        || latestClauseRequestsExecution(originalText, objective.delegatedRole))
      && !explicitlyRevokesExecutionAuthority(originalText)
      && !isExplicitReadOnlyReview(originalText)
      && !isChatResponseOnlyEdit(originalText)
    : true;
  // Repair the exact persisted false-negative observed in a misspelled send
  // objective. This is deliberately narrower than recomputing authority for
  // every legacy objective whose host-owned flag is absent.
  const recoveredMisspelledSendAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && canonicalizeMisspelledSendImperative(originalText) !== originalText
    && originalStillRequiresExecution;
  // An explicit repair command in a legacy root is actionable even when an
  // older router omitted its cached evidence flag. Require a direct French
  // imperative at the start; descriptive, quoted and question forms cannot
  // acquire authority through this migration.
  const recoveredDirectRepairAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && !hasNonAuthoritativeStructuredLead(originalText)
    && /^(?:solutionne|r[ée]sous|r[èe]gle|r[ée]pare|corrige)\b/iu.test(originalText.trim())
    && originalStillRequiresExecution;
  const recoveredDevLoginReactivationAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && DEV_LOGIN_REACTIVATION_REQUEST.test(originalText)
    && originalStillRequiresExecution;
  const recoveredPlanImplementationAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && isLegacyPlanImplementationRequest(originalText)
    && originalStillRequiresExecution;
  const recoveredInvoiceEmailFulfillmentAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && isDirectInvoiceEmailFulfillmentRequest(originalText)
    && originalStillRequiresExecution;
  const recoveredAutomatedFormCreationAuthority = objective.requiresExecutionEvidence === undefined
    && objective.delegatedRole !== 'reviewer'
    && !!originalText
    && isDirectAutomatedFormCreationRequest(originalText)
    && originalStillRequiresExecution;
  return objective.delegatedRole !== 'reviewer'
    && (objective.requiresExecutionEvidence === true
      || recoveredMisspelledSendAuthority
      || recoveredDirectRepairAuthority
      || recoveredDevLoginReactivationAuthority
      || recoveredPlanImplementationAuthority
      || recoveredInvoiceEmailFulfillmentAuthority
      || recoveredAutomatedFormCreationAuthority)
    && (amendmentDecision ?? originalStillRequiresExecution);
}

/** Rebuild only the completion obligations omitted by the known pre-classifier
 * historical objective schemas. This projection is runtime-only: persisted authority is
 * never broadened, and explicit false/revoked fields remain authoritative. */
export function projectLegacyObjectiveCompletionRequirements(
  objective: ActiveSessionObjective,
  fallbackText?: string,
): ActiveSessionObjective {
  if (objective.requiresExecutionEvidence !== undefined
    || objective.requiresAcceptanceCriteria !== undefined
    || !objectiveRequiresExecutionEvidence(objective, fallbackText)) return objective;
  return {
    ...objective,
    requiresExecutionEvidence: true,
    requiresAcceptanceCriteria: true,
  };
}
