import type { ActiveSessionObjective } from "@craft-agent/shared/sessions";
import { detectHighStakesEvidenceDomain, isConcreteOperationalSoftwareRestatement, isExplicitNonMedicalOperationalTreatmentClarification, isOperationalTechnicalContractLifecycleObjective, stripExplicitNonMedicalOperationalTreatmentClarification } from "@craft-agent/shared/agent";
import { objectiveAmendmentAuthorityText, objectiveAuthorityAmendments } from './amendment-authority.ts';
import { independentInstructionClauses } from './amendment-intent.ts';
import { classifyAuthorizedObjectiveEvidenceDomain, classifyObjectiveRequest } from './execution-authority.ts';
import { objectiveRequiresExecutionEvidence } from './execution-requirements.ts';
import { EXPLICIT_NEW_OBJECTIVE_PATTERNS } from './intent-vocabulary.ts';
import { foldForIntent } from './types.ts';

/** Allow a stale medical tier to fall only after either a narrow explicit
 * correction or a fully restated concrete software mission, and only when
 * every human-authored objective segment remains non-clinical under the
 * current classifiers. The operational restatement path repairs historical
 * classifier state; it grants no tool or target authority of its own. */
export function canCorrectLegacyMedicalFalsePositive(
  objective: ActiveSessionObjective,
  currentText: string,
  currentTextIsAmendment: boolean,
): boolean {
  if (objective.evidenceDomain !== 'medical') return false;
  const historicalSegments = [
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)),
  ].filter(text => text.trim().length > 0);
  const clarificationSeen = currentTextIsAmendment
    && isExplicitNonMedicalOperationalTreatmentClarification(currentText)
    || historicalSegments.some(isExplicitNonMedicalOperationalTreatmentClarification);
  const operationalRestatementSeen = currentTextIsAmendment
    && isConcreteOperationalSoftwareRestatement(objectiveAmendmentAuthorityText(currentText))
    || [...historicalSegments].reverse().some(isConcreteOperationalSoftwareRestatement);
  if (!clarificationSeen && !operationalRestatementSeen) return false;

  return historicalSegments.every(text => {
    const remainingText = stripExplicitNonMedicalOperationalTreatmentClarification(text) ?? text;
    return (classifyObjectiveRequest(remainingText).highRisk === false
      // A genuinely clinical root can be observational and therefore standard;
      // it must still never be reinterpreted by a later contradictory claim.
      && detectHighStakesEvidenceDomain(remainingText) !== 'medical')
      // A detailed software recovery list may use bare “santé” as one of its
      // operational checks. The shared predicate neutralizes only that
      // ambiguous noun and still rejects every independent clinical signal.
      || isConcreteOperationalSoftwareRestatement(remainingText);
  });
}

/** Migrate a persisted legal source gate only when the newest substantive
 * human instruction fully restates an operational contract/signature incident
 * over a concrete technical substrate. A terse continuation cannot invent
 * this correction, and any real legal/drafting signal keeps the old gate. */
export function canCorrectLegacyTechnicalLegalFalsePositive(
  objective: ActiveSessionObjective,
  currentText: string,
  currentTextIsAmendment: boolean,
): boolean {
  if (objective.evidenceDomain !== 'legal') return false;
  const historicalSegments = [
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)),
  ].filter(text => text.trim().length > 0);
  if (!historicalSegments.every(text => (
    classifyObjectiveRequest(text).highRisk === false
      && detectHighStakesEvidenceDomain(text) !== 'legal'
    || (isOperationalTechnicalContractLifecycleObjective(text)
        || isConcreteOperationalSoftwareRestatement(text))
      && classifyAuthorizedObjectiveEvidenceDomain(text) === undefined
      && detectHighStakesEvidenceDomain(text) === undefined
  ))) return false;
  const candidates = currentTextIsAmendment
    ? [objectiveAmendmentAuthorityText(currentText)]
    : objectiveAuthorityAmendments(objective)
      .map(amendment => objectiveAmendmentAuthorityText(amendment.text))
      .reverse();
  const correction = candidates.find(isOperationalTechnicalContractLifecycleObjective);
  if (!correction) return false;
  return classifyObjectiveRequest(correction).highRisk === false
    && detectHighStakesEvidenceDomain(correction) === undefined;
}

export function reclassifiedHighStakesClarification(
  objective: ActiveSessionObjective,
  currentText: string,
  currentTextIsAmendment: boolean,
): { evidenceDomain?: ReturnType<typeof detectHighStakesEvidenceDomain> } | undefined {
  const historicalClarifications = objectiveAuthorityAmendments(objective)
    .map(amendment => objectiveAmendmentAuthorityText(amendment.text))
    .reverse();
  const currentClarification = currentTextIsAmendment
    && stripExplicitNonMedicalOperationalTreatmentClarification(currentText) !== undefined;
  // A fresh substantive instruction owns its domain. Historical clarification
  // reclassification is only needed while resuming persisted state, or when
  // the current amendment is itself another bounded clarification.
  const candidates = currentTextIsAmendment
    ? (currentClarification ? [currentText, ...historicalClarifications] : [])
    : historicalClarifications;
  for (const text of candidates) {
    const remainingText = stripExplicitNonMedicalOperationalTreatmentClarification(text);
    if (remainingText === undefined) continue;
    const classification = classifyObjectiveRequest(remainingText);
    if (!classification.highRisk) continue;
    return {
      evidenceDomain: classifyAuthorizedObjectiveEvidenceDomain(remainingText)
        ?? detectHighStakesEvidenceDomain(remainingText),
    };
  }
  return undefined;
}

/** Re-evaluate persisted execution authority after a bounded classifier fix.
 * This runs only on a non-substantive continuation, never in preference to a
 * fresh amendment, and cannot revive work whose execution authority was
 * explicitly revoked. */
export function reclassifiedPersistedHighStakesObjective(
  objective: ActiveSessionObjective,
): { evidenceDomain?: ReturnType<typeof detectHighStakesEvidenceDomain> } | undefined {
  if (!objectiveRequiresExecutionEvidence(objective)) return undefined;
  for (const text of [
    ...objectiveAuthorityAmendments(objective)
      .map(amendment => objectiveAmendmentAuthorityText(amendment.text))
      .reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ]) {
    const classification = classifyObjectiveRequest(text);
    if (!classification.highRisk) continue;
    return {
      evidenceDomain: classifyAuthorizedObjectiveEvidenceDomain(text)
        ?? detectHighStakesEvidenceDomain(text),
    };
  }
  return undefined;
}

/** A later deictic correction may target a genuinely requested read-only
 * audit, but never a domain merely quoted or mentioned by an intervening
 * report. This keeps "analyse les permissions … en lecture seule" useful
 * without letting "le rapport mentionne les permissions" retarget authority. */
export function latestExplicitAuditEvidenceDomain(objective: ActiveSessionObjective) {
  const segments = [
    ...objectiveAuthorityAmendments(objective).map(amendment => objectiveAmendmentAuthorityText(amendment.text)).reverse(),
    objectiveAmendmentAuthorityText(objective.originalText ?? ''),
  ];
  for (const text of segments) {
    // Bind the audited subject to the same bounded clause as the observation
    // verb. A later conditional blocker clause mentioning a secret is not the
    // subject of an earlier generic “verify the result” instruction.
    for (const clause of independentInstructionClauses(text)) {
      const folded = foldForIntent(clause);
      const explicitAudit = /\b(?:analys(?:e|er|ez)|analy[sz]e|audit(?:e|er|ez)?|inspect(?:e|er|ez)?|review|revoi[st]|verifi(?:e|er|ez))\b/.test(folded);
      const explicitReadOnly = /\b(?:lecture seule|read only|sans (?:le |la |les )?(?:modifier|modification|corriger|correction)|without (?:any )?(?:change|changing|modification)|ne modifi(?:e|er|ez) (?:rien|pas))\b/.test(folded);
      const reportedMention = /\b(?:rapport|report|document|texte|message|compte rendu)\b[^.!?\n]{0,160}\b(?:mentionne|mentions?|indique|reports?|says?|cite)\b/.test(folded);
      const mutationRequested = classifyObjectiveRequest(clause).mutationRequested;
      if (!explicitAudit || reportedMention || mutationRequested && !explicitReadOnly) continue;
      const domain = detectHighStakesEvidenceDomain(clause);
      if (domain) return domain;
    }
  }
  // A real earlier mutation can also own the referent of a terse correction.
  // Do not fall back to a bare detected domain: conditional blocker wording
  // such as “stop only if a secret is missing” is not an audited subject and
  // must not turn later generic fixes into credential mutations.
  for (const text of segments) {
    if (!classifyObjectiveRequest(text).highRisk) continue;
    const domain = classifyAuthorizedObjectiveEvidenceDomain(text);
    if (domain) return domain;
  }
  return undefined;
}

export function startsExplicitNewObjective(text: string): boolean {
  const folded = foldForIntent(text).replace(/^(?:(?:bon|alors|donc|ok|okay|oui|yes|maintenant|now|please)\s+)+/, '');
  return EXPLICIT_NEW_OBJECTIVE_PATTERNS.some(pattern => pattern.test(folded));
}

export function isObjectiveStatusOnly(text: string): boolean {
  const normalized = foldForIntent(text).replace(/-/g, ' ').replace(/\s+/g, ' ');
  return /^(?:ou en (?:es tu|sommes nous)|(?:quel(?:le)?s? (?:est|sont) )?(?:(?:le|la|les) )?(?:statut|avancement)|(?:(?:peux tu|pouvez vous|pourrais tu|pourriez vous) )?(?:(?:me|nous) )?(?:donner|donne|donnez|faire|fais|faites) (?:(?:moi|nous) )?(?:un|le) (?:point davancement|point de situation|statut)|(?:can|could|would) you (?:give|send) (?:me|us) (?:a )?(?:status|progress) update|(?:give|send) (?:me|us) (?:a )?(?:status|progress) update|what(?:s| is) the (?:status|progress)|where are we|how is it going|status|progress|merci|thanks)$/.test(normalized);
}
