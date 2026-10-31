import { completionCriterionPathKeys as pathKeys } from "@craft-agent/session-tools-core";
import type { ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { contextualGmailExactEffectExpectationFromObjective } from "@craft-agent/shared/agent";
import { canonicalToolName } from './criterion-identities.ts';

const EXACT_GMAIL_SENT_VERIFIER = 'mcp__google-contacts__gmail_verify_sent_message';

function criterionInputField(
  criterion: ObjectiveAcceptanceCriterion,
  field: string,
): unknown {
  for (const [path, value] of Object.entries(criterion.input)) {
    const keys = pathKeys(path);
    if (keys?.length === 1 && keys[0] === field) return value;
  }
  return undefined;
}

export function criterionChecksTrue(criterion: ObjectiveAcceptanceCriterion, field: string): boolean {
  return criterion.checks.some(check => {
    const keys = pathKeys(check.path);
    return keys?.length === 1 && keys[0] === field && check.equals === true;
  });
}

export function exactEmailSet(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const emails = value.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)
    ?.map(email => email.toLowerCase()) ?? [];
  const residue = value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '')
    .replace(/[\s,;]+/gu, '');
  return residue || new Set(emails).size !== emails.length
    ? undefined
    : [...new Set(emails)].sort();
}

function objectiveAuthorizationSegments(objective: ActiveSessionObjective): string[] {
  return [
    ...(objective.originalText ? [objective.originalText] : []),
    ...(objective.amendments ?? []).map(amendment => amendment.text),
  ];
}

export function exactGmailCompletionCriterionGap(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): string | undefined {
  const expectation = contextualGmailExactEffectExpectationFromObjective(
    objectiveAuthorizationSegments(objective),
  );
  // This additional contract applies only when the human supplied one exact
  // body. Ordinary Gmail inspection and non-exact correspondence keep the
  // generic acceptance machinery.
  if (!expectation?.expectedBody) return undefined;
  const matching = criteria.some(criterion => {
    if (canonicalToolName(criterion.toolName) !== EXACT_GMAIL_SENT_VERIFIER
      || !criterionChecksTrue(criterion, 'ok')) return false;
    const expectedAnchorMessageId = criterionInputField(criterion, 'expectedAnchorMessageId');
    const expectedTo = criterionInputField(criterion, 'expectedTo');
    const expectedCc = criterionInputField(criterion, 'expectedCc');
    const expectedFrom = criterionInputField(criterion, 'expectedFrom');
    const expectedSubject = criterionInputField(criterion, 'expectedSubject');
    const expectedBody = criterionInputField(criterion, 'expectedBody');
    const expectedIsHtml = criterionInputField(criterion, 'expectedIsHtml');
    if (typeof expectedAnchorMessageId !== 'string'
      || expectation.anchorMessageId !== undefined
        && expectedAnchorMessageId.toLowerCase() !== expectation.anchorMessageId
      || typeof expectedTo !== 'string' || exactEmailSet(expectedTo) === undefined
      || typeof expectedCc !== 'string' || exactEmailSet(expectedCc) === undefined
      || typeof expectedSubject !== 'string' || !expectedSubject
      || expectedBody !== expectation.expectedBody
      || expectedIsHtml !== (expectation.expectedIsHtml ?? false)) return false;
    if (expectation.expectedRecipientEmail !== undefined
      && JSON.stringify(exactEmailSet(expectedTo))
        !== JSON.stringify([expectation.expectedRecipientEmail])) return false;
    if (expectation.expectedCc !== undefined
      && JSON.stringify(exactEmailSet(expectedCc))
        !== JSON.stringify(exactEmailSet(expectation.expectedCc))) return false;
    if (expectation.expectedSenderEmail !== undefined
      && JSON.stringify(exactEmailSet(expectedFrom))
        !== JSON.stringify([expectation.expectedSenderEmail])) return false;
    if (expectation.expectedSubject !== undefined
      && expectedSubject !== expectation.expectedSubject) return false;
    return true;
  });
  return matching ? undefined
    : 'Exact Gmail effect lacks one complete sent-message proof bound to the anchor thread, sender, To, Cc, subject and exact body. Register gmail_verify_sent_message with every specified expected field and $.ok == true; the eventual tool call supplies the candidate messageId, and an older message matching only a subset is neither a duplicate nor completion evidence.';
}

export function assertExactGmailCompletionCriteria(
  objective: ActiveSessionObjective,
  criteria: readonly ObjectiveAcceptanceCriterion[],
): void {
  const gap = exactGmailCompletionCriterionGap(objective, criteria);
  if (gap) throw new Error(`${gap} Nothing was registered; this rejection does not authorize repeating an already identical external effect.`);
}
