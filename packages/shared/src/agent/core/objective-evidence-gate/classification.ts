import type { HighStakesEvidenceDomain } from './contracts.ts';
import { hasAuthoritativeDirectClinicalMutation, hasContextualMedicalTreatment, isDirectLegalDocumentMutation } from './mutation-classification.ts';
import { hasAuthoritativeMutationPattern } from './mutation-negations.ts';
import { isOperationalTechnicalContractLifecycleObjective, normalizedMedicalEvidenceText } from './operational-context.ts';
import { CONCRETE_OPERATIONAL_SOFTWARE_ACTION_PATTERN, CONCRETE_OPERATIONAL_SOFTWARE_LOCATOR_PATTERN, CONCRETE_OPERATIONAL_SOFTWARE_TARGET_PATTERN, CONCRETE_OPERATIONAL_SOFTWARE_VERIFICATION_PATTERN, DIRECT_RBAC_DOMAIN_PATTERN, DIRECT_RBAC_MUTATION_ACTION_PATTERN, DOMAINS, MUTATING_REQUEST_PATTERN, OPERATIONAL_CONTRACT_LIFECYCLE_WORDS_GLOBAL_PATTERN, TECHNICAL_CONTRACT_PATTERN } from './patterns.ts';

function hasAuthoritativeDirectRbacMutation(text: string): boolean {
  return hasAuthoritativeMutationPattern(text, DIRECT_RBAC_MUTATION_ACTION_PATTERN);
}

/** Detect the subject domain only. Mutation authority must be established by
 * the host objective classifier before this result is persisted or supplied
 * to beginObjectiveEvidenceGate. */
export function detectHighStakesEvidenceDomain(text: string): Exclude<HighStakesEvidenceDomain, 'unspecified'> | undefined {
  const normalizedText = text.normalize('NFC');
  if (isDirectLegalDocumentMutation(normalizedText)) return 'legal';
  const legalText = isOperationalTechnicalContractLifecycleObjective(normalizedText)
    ? normalizedText
      .replace(TECHNICAL_CONTRACT_PATTERN, ' ')
      .replace(OPERATIONAL_CONTRACT_LIFECYCLE_WORDS_GLOBAL_PATTERN, ' ')
    : normalizedText.replace(TECHNICAL_CONTRACT_PATTERN, ' ');
  // Neutralize only locally bounded service/check health expressions. Product
  // nouns such as health records or applications de santé remain medical even
  // when the rest of the objective has a concrete operational shape.
  const medicalText = normalizedMedicalEvidenceText(normalizedText).text;
  if (DIRECT_RBAC_DOMAIN_PATTERN.test(normalizedText)) return 'security';
  const directDomain = DOMAINS.find(([domain, pattern]) => pattern.test(
    domain === 'legal' ? legalText : domain === 'medical' ? medicalText : normalizedText,
  ))?.[0];
  return directDomain ?? (hasContextualMedicalTreatment(medicalText) ? 'medical' : undefined);
}

function concreteOperationalSoftwareShape(text: string): boolean {
  return text.length >= 120
    && CONCRETE_OPERATIONAL_SOFTWARE_TARGET_PATTERN.test(text)
    && CONCRETE_OPERATIONAL_SOFTWARE_ACTION_PATTERN.test(text)
    && CONCRETE_OPERATIONAL_SOFTWARE_VERIFICATION_PATTERN.test(text)
    && CONCRETE_OPERATIONAL_SOFTWARE_LOCATOR_PATTERN.test(text);
}

/**
 * A fully restated, concrete software operation can safely repair an obsolete
 * persisted *domain label* when every historical human segment is also
 * non-medical under the current classifier. This predicate grants no tool or
 * target authority: it only distinguishes a detailed operational restatement
 * from a terse continuation such as “continue” or “fix it”.
 */
export function isConcreteOperationalSoftwareRestatement(text: string): boolean {
  const normalized = text.normalize('NFC').trim();
  return concreteOperationalSoftwareShape(normalized)
    && detectHighStakesEvidenceDomain(normalized) === undefined;
}

export function classifyHighStakesEvidenceDomain(text: string): HighStakesEvidenceDomain | undefined {
  const normalizedText = text.normalize('NFC');
  if (!isDirectLegalDocumentMutation(normalizedText)
    && !hasAuthoritativeMutationPattern(normalizedText, MUTATING_REQUEST_PATTERN)
    && !hasAuthoritativeDirectClinicalMutation(normalizedText)
    && !hasAuthoritativeDirectRbacMutation(normalizedText)) return undefined;
  return detectHighStakesEvidenceDomain(normalizedText);
}
