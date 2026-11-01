import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { detectHighStakesEvidenceDomain } from "@craft-agent/shared/agent";
import { isContextDependentDirectTurn } from "@craft-agent/shared/config";
import { objectiveAmendmentAuthorityText, objectiveAuthorityAmendments } from './amendment-authority.ts';
import { classifyAuthorizedObjectiveEvidenceDomain } from './execution-authority.ts';
import { hasNonAuthoritativeStructuredLead } from './instruction-clause-syntax.ts';
import { CONTINUATION_FILLER_PATTERN, CONTINUATION_REFERENCE_PATTERN, CONTINUATION_REOPEN_PATTERN, CONTINUATION_VERBS, isExecutionChannelCorrection, isPrecisionOrCompletenessChallenge } from './intent-vocabulary.ts';
import { isLegacyPlanImplementationRequest } from './request-intent.ts';
import { foldForIntent } from './types.ts';

function editDistanceWithin(left: string, right: string, limit: number): boolean {
  if (Math.abs(left.length - right.length) > limit) return false;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return (previous[right.length] ?? limit + 1) <= limit;
}

export function looksLikeContinuation(text: string): boolean {
  if (isContextDependentDirectTurn(text)) return true;
  if (isExecutionChannelCorrection(text)) return true;
  if (isTerseContextualRepairAmendment(text)) return true;
  if (isPrecisionOrCompletenessChallenge(text)) return true;
  const folded = foldForIntent(text);
  const withoutFiller = folded.match(CONTINUATION_FILLER_PATTERN)?.[1] ?? folded;
  const [firstWord = ''] = withoutFiller.split(/\s+/);
  const typoTolerance = firstWord.length >= 5 ? 2 : 1;
  return CONTINUATION_REFERENCE_PATTERN.test(withoutFiller)
    || CONTINUATION_REOPEN_PATTERN.test(withoutFiller)
    || /^(?:(?:a toi de|merci de|veuillez)\s+)?(?:fai(?:s|tes)\s+(?:la|les|ces)\s+corrections?|corrig(?:e|ez)\s+(?:le|la|les|ca|cela)|plan\s+approuve\s*,?\s*(?:veuillez\s+)?execute(?:r|z)?)\b/.test(withoutFiller)
    || CONTINUATION_VERBS.some(verb => editDistanceWithin(firstWord, verb, typoTolerance));
}

/** A bare repair verb has no self-contained target. It can safely amend an
 * active or explicitly incomplete objective, but it cannot establish that a
 * verified objective was actually incomplete. Reusing a completed root here
 * would silently recover all of its old target and mutation authority from a
 * phrase such as "Résout". */
export function isTerseContextualRepairAmendment(text: string): boolean {
  if (hasNonAuthoritativeStructuredLead(text) || text.length > 120) return false;
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  const bareRepair = /^(?:(?:ok|oui|yes|daccord)\s+)?(?:resou(?:s|t|dre)|regle|fix)(?:\s+(?:ca|cela|ceci|it|this))?$/;
  if (bareRepair.test(normalized)) return true;

  // Recover the exact production-shaped contextual repair: a deictic repair
  // followed only by a short failure diagnosis and the already-assigned
  // private-IP location. This deliberately cannot consume another imperative
  // ("puis déploie", "et supprime") or introduce an autonomous target.
  const privateIpDiagnosticRepair = /^(?:(?:ok|oui|yes|daccord)\s+)?repare\s+(?:ca|cela|ceci)\s+(?:(?:devrait\s+(?:marche(?:r)?|fonctionne(?:r)?)|(?:ne\s+)?(?:marche|fonctionne)\s+pas|(?:echoue|bloque)))(?:\s+(?:(?:car|puisque|parce\s+que)\s+)?(?:on\s+est|nous\s+sommes)\s+bien\s+(?:sur|via)\s+(?:l\s*)?(?:adresse\s+)?ip\s+privee\s+(?:attribuee|assignee|attritree))?$/;
  return privateIpDiagnosticRepair.test(normalized);
}

/**
 * Older builds could accidentally replace a real objective root with one of
 * these context-only corrections. They are valid amendments, but never a
 * self-contained source of target or mutation authority.
 */
export function isLegacyContextualObjectiveRoot(text: string): boolean {
  return isExecutionChannelCorrection(text)
    || isTerseContextualRepairAmendment(text)
    || isLegacyPlanImplementationRequest(text);
}

export function retainedObjectiveEvidenceDomain(objective: ActiveSessionObjective) {
  if (objective.evidenceDomain) return objective.evidenceDomain;
  // Legacy objectives did not persist their evidence subject. Prefer an
  // authoritative mutation segment, then recover a read-only subject that a
  // later deictic correction ("fix the findings") can legitimately retain.
  for (const text of [
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)).reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ]) {
    const domain = classifyAuthorizedObjectiveEvidenceDomain(text);
    if (domain) return domain;
  }
  for (const text of [
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)).reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ]) {
    const domain = detectHighStakesEvidenceDomain(text);
    if (domain) return domain;
  }
  return undefined;
}
